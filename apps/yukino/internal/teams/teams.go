package teams

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/permissions"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

const TeamsDirName = "teams"

// TeamsBaseDir is the project-scoped root directory for team data. The
// canonical cwd is hashed so unrelated projects cannot restore, list, mutate,
// or delete each other's teams.
func TeamsBaseDir(cwd string) string {
	key, err := storage.ProjectKey(cwd)
	if err != nil {
		sum := sha256.Sum256([]byte(cwd))
		key = hex.EncodeToString(sum[:])
	}
	return storage.YukinoPath(TeamsDirName, key)
}

type Member struct {
	Name    string
	Checker *permissions.Checker
	Active  bool
	// Cancel cancels the teammate runtime; Done closes when the loop has
	// fully stopped, mirroring the reference cancel/done pair.
	Cancel               context.CancelFunc
	Done                 chan struct{}
	PendingPlan          *pendingPlanApproval
	PlanApprovalRequired bool
	Progress             *TeammateProgress

	AgentID      string
	AgentType    string
	Model        string
	WorktreePath string
	JoinedAt     int64
}

type Team struct {
	Cwd     string
	Name    string
	Members map[string]*Member
	MailBox *FileMailBox
	mu      sync.Mutex

	LeadAgentID                string
	Description                string
	CreatedAt                  int64
	PermissionMode             permissions.PermissionMode
	RequiresLeaderPlanApproval bool
	memberOrder                []string
}

func NewTeam(cwd, name string) *Team {
	inboxDir := filepath.Join(teamDir(cwd, name), "inboxes")
	return &Team{
		Cwd:            cwd,
		Name:           name,
		Members:        make(map[string]*Member),
		MailBox:        NewFileMailBox(inboxDir),
		CreatedAt:      time.Now().Unix(),
		PermissionMode: permissions.ModeDefault,
	}
}

// AddMember mirrors Team.addMember: it validates the name and records a bare,
// inactive member. The agent runtime is built later by spawnTeammate.
func (t *Team) AddMember(name string) (*Member, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if name == LeadName || !mailboxMemberPattern.MatchString(name) {
		return nil, fmt.Errorf("Invalid teammate name '%s'", name)
	}
	if t.Members[name] != nil {
		return nil, fmt.Errorf("Teammate '%s' already exists", name)
	}
	member := &Member{
		Name:     name,
		Active:   false,
		AgentID:  name,
		JoinedAt: time.Now().Unix(),
	}
	t.Members[name] = member
	t.memberOrder = append(t.memberOrder, name)
	t.persist()
	return member, nil
}

// RemoveMember mirrors Team.removeMember: an active teammate must be stopped
// first; removing an existing member unregisters its name and rewrites the
// team file with the member marked as removed.
func (t *Team) RemoveMember(name string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	member := t.Members[name]
	if member != nil && member.Active {
		return fmt.Errorf("Stop teammate '%s' before removing it", name)
	}
	if member == nil {
		return nil
	}
	delete(t.Members, name)
	for i, existing := range t.memberOrder {
		if existing == name {
			t.memberOrder = append(t.memberOrder[:i], t.memberOrder[i+1:]...)
			break
		}
	}
	GetNameRegistry().Unregister(name)
	WriteTeamFile(t.Cwd, t.Name, t.snapshot(), name)
	return nil
}

func (t *Team) SetMemberMeta(name, agentType, model, worktreePath string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.setMemberMeta(name, agentType, model, worktreePath)
}

// setMemberMeta mirrors Team.setMemberMeta; the caller must hold t.mu.
func (t *Team) setMemberMeta(name, agentType, model, worktreePath string) {
	member, ok := t.Members[name]
	if !ok {
		return
	}
	member.AgentType = agentType
	member.Model = model
	member.WorktreePath = worktreePath
	t.persist()
}

func (t *Team) StopMember(name string) {
	t.mu.Lock()
	member := t.Members[name]
	if member == nil {
		t.mu.Unlock()
		return
	}
	member.Active = false
	cancel, done := member.Cancel, member.Done
	if member.Progress != nil {
		if status := member.Progress.GetStatus(); status == "running" || status == "idle" {
			member.Progress.SetStatus("stopped")
		}
	}
	GetNameRegistry().Unregister(name)
	t.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	t.releaseMemberTasks(name)
	t.mu.Lock()
	member.Cancel = nil
	member.Done = nil
	t.persist()
	t.pruneTerminatedMembers()
	t.mu.Unlock()
}

// MaxRetainedTerminatedMembers mirrors MAX_RETAINED_TERMINATED_MEMBERS: the cap
// on terminated members kept in memory and on disk before the oldest are evicted.
const MaxRetainedTerminatedMembers = 200

// pruneTerminatedMembers evicts the oldest terminated members beyond the
// retention cap, mirroring Team.pruneTerminatedMembers in the reference. Running
// members are never dropped. The caller must hold t.mu.
func (t *Team) pruneTerminatedMembers() {
	var terminal []*Member
	for _, name := range t.memberOrder {
		member := t.Members[name]
		if member == nil || member.Active || member.Cancel != nil || member.Done != nil || member.Progress == nil {
			continue
		}
		switch member.Progress.GetStatus() {
		case "completed", "failed", "stopped":
			terminal = append(terminal, member)
		}
	}
	excess := len(terminal) - MaxRetainedTerminatedMembers
	if excess <= 0 {
		return
	}
	removed := terminal[:excess]
	removedNames := make([]string, 0, len(removed))
	removedSet := make(map[string]bool, len(removed))
	for _, member := range removed {
		delete(t.Members, member.Name)
		removedNames = append(removedNames, member.Name)
		removedSet[member.Name] = true
	}
	keep := make([]string, 0, len(t.memberOrder)-len(removed))
	for _, name := range t.memberOrder {
		if !removedSet[name] {
			keep = append(keep, name)
		}
	}
	t.memberOrder = keep
	WriteTeamFile(t.Cwd, t.Name, t.snapshot(), removedNames...)
}

func (t *Team) SendMessage(from, to, content string) error {
	t.mu.Lock()
	member := t.Members[to]
	if member == nil {
		t.mu.Unlock()
		return fmt.Errorf("Member '%s' not found in team '%s'", to, t.Name)
	}
	if !member.Active && member.Progress != nil {
		status := member.Progress.GetStatus()
		t.mu.Unlock()
		return fmt.Errorf("Teammate '%s' is %s and cannot receive work", to, status)
	}
	if member.Active && member.Progress != nil && member.PendingPlan == nil {
		member.Progress.SetStatus("running")
	}
	t.mu.Unlock()
	return t.MailBox.Send(to, NewFileMailMessage(from, content))
}

type TeamManager struct {
	mu              sync.Mutex
	cwd             string
	teams           map[string]*Team
	taskStores      map[string]*SharedTaskStore
	order           []string
	CoordinatorMode bool
	checker         *permissions.Checker
	unsubscribe     func()

	// listeners are notified after the team set changes (create/delete),
	// mirroring the reference TeamManager.subscribe/emitChange.
	listenersMu  sync.Mutex
	listeners    map[int]func()
	nextListener int
}

// Subscribe registers a listener notified whenever the team set changes. The
// returned function unsubscribes. Mirrors TeamManager.subscribe.
func (tm *TeamManager) Subscribe(listener func()) func() {
	tm.listenersMu.Lock()
	if tm.listeners == nil {
		tm.listeners = map[int]func(){}
	}
	id := tm.nextListener
	tm.nextListener++
	tm.listeners[id] = listener
	tm.listenersMu.Unlock()
	return func() {
		tm.listenersMu.Lock()
		delete(tm.listeners, id)
		tm.listenersMu.Unlock()
	}
}

// emitChange notifies subscribers. It must be called without tm.mu held, since
// listeners read the team set back through the manager.
func (tm *TeamManager) emitChange() {
	tm.listenersMu.Lock()
	listeners := make([]func(), 0, len(tm.listeners))
	for _, listener := range tm.listeners {
		listeners = append(listeners, listener)
	}
	tm.listenersMu.Unlock()
	for _, listener := range listeners {
		func() { defer func() { recover() }(); listener() }()
	}
}

func NewTeamManager(cwd string) *TeamManager {
	return &TeamManager{
		cwd:        cwd,
		teams:      make(map[string]*Team),
		taskStores: make(map[string]*SharedTaskStore),
	}
}

func teamDir(cwd, name string) string {
	return filepath.Join(TeamsBaseDir(cwd), sanitizeTeamName(name))
}

func (tm *TeamManager) CreateTeam(name, leadAgentID, description string) (team *Team, err error) {
	defer func() {
		if err == nil {
			tm.emitChange()
		}
	}()
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if name == "" {
		name = "team-" + uuid.NewString()
	}
	if strings.TrimSpace(name) == "" {
		return nil, fmt.Errorf("Team name must not be empty or whitespace.")
	}
	key := sanitizeTeamName(name)
	exists := func() error {
		return fmt.Errorf("Team '%s' already exists. Choose a different name, or target the existing team with team_name='%s'.", name, name)
	}
	if tm.teams[key] != nil {
		return nil, exists()
	}
	if err := storage.MkdirPrivateSync(TeamsBaseDir(tm.cwd)); err != nil {
		return nil, err
	}
	if err := os.Mkdir(teamDir(tm.cwd, name), 0700); err != nil {
		if os.IsExist(err) {
			return nil, exists()
		}
		return nil, err
	}
	team = NewTeam(tm.cwd, name)
	team.LeadAgentID = leadAgentID
	team.Description = description
	team.RequiresLeaderPlanApproval = tm.CoordinatorMode
	if tm.checker != nil {
		team.PermissionMode = tm.checker.Mode()
	}
	store, err := NewSharedTaskStore(filepath.Join(teamDir(tm.cwd, name), "tasks.json"))
	if err != nil {
		return nil, err
	}
	if err := store.InitEmpty(); err != nil {
		return nil, err
	}
	tm.teams[key] = team
	tm.order = append(tm.order, key)
	tm.taskStores[key] = store
	team.persist()
	return team, nil
}

// GetTaskStore mirrors TeamManager.getTaskStore: the store is cached per
// canonical team identity, and an unreadable board fails at construction.
func (tm *TeamManager) GetTaskStore(teamName string) (*SharedTaskStore, error) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	key := sanitizeTeamName(teamName)
	if store, ok := tm.taskStores[key]; ok {
		return store, nil
	}
	store, err := NewSharedTaskStore(filepath.Join(teamDir(tm.cwd, teamName), "tasks.json"))
	if err != nil {
		return nil, err
	}
	tm.taskStores[key] = store
	return store, nil
}

func (tm *TeamManager) GetTeam(name string) *Team {
	tm.mu.Lock()
	if team, ok := tm.teams[sanitizeTeamName(name)]; ok {
		tm.mu.Unlock()
		return team
	}
	tf := ReadTeamFile(tm.cwd, name)
	if tf == nil {
		tm.mu.Unlock()
		return nil
	}
	team := NewTeam(tm.cwd, tf.Name)
	team.RequiresLeaderPlanApproval = tm.CoordinatorMode
	team.PermissionMode = tf.PermissionMode
	if tm.checker != nil {
		team.PermissionMode = tm.checker.Mode()
	}
	team.LeadAgentID = tf.LeadAgentID
	team.Description = tf.Description
	team.CreatedAt = tf.CreatedAt
	for _, m := range tf.Members {
		active := false
		team.Members[m.Name] = &Member{
			Name:         m.Name,
			AgentID:      m.AgentID,
			AgentType:    m.AgentType,
			Model:        m.Model,
			WorktreePath: m.WorktreePath,
			JoinedAt:     m.JoinedAt,
			Active:       active,
		}
		team.memberOrder = append(team.memberOrder, m.Name)
		status := "stopped"
		if m.IsActive {
			status = "failed"
		}
		team.Members[m.Name].Progress = NewTeammateProgress(m.Name, team.Name, TeammateSpinnerVerb)
		// The reference hydrates the UI start time from joinedAt, not now.
		team.Members[m.Name].Progress.StartTime = m.JoinedAt * 1000
		team.Members[m.Name].Progress.SetStatus(status)
		team.releaseMemberTasks(m.Name)
	}
	// The team is still local (not yet registered), so persist and prune the
	// hydrated terminated members without contending on the team lock.
	team.persist()
	team.pruneTerminatedMembers()
	tm.teams[sanitizeTeamName(name)] = team
	tm.order = append(tm.order, sanitizeTeamName(name))
	tm.mu.Unlock()
	tm.emitChange()
	return team
}

func (tm *TeamManager) DeleteTeam(name string) {
	defer tm.emitChange()
	team := tm.GetTeam(name)
	if team != nil {
		for _, member := range team.ListMembers() {
			team.StopMember(member.Name)
		}
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()
	key := sanitizeTeamName(name)
	delete(tm.teams, key)
	delete(tm.taskStores, key)
	for i, item := range tm.order {
		if item == key {
			tm.order = append(tm.order[:i], tm.order[i+1:]...)
			break
		}
	}
	_ = os.RemoveAll(teamDir(tm.cwd, name))
}

// DeleteAll mirrors TeamManager.deleteAll: every in-memory team is deleted,
// then residual team directories from previous sessions. Other project
// namespaces remain untouched.
func (tm *TeamManager) DeleteAll() {
	for _, name := range tm.ListTeams() {
		tm.DeleteTeam(name)
	}
	for _, name := range ListTeamNames(tm.cwd) {
		tm.DeleteTeam(name)
	}
}
func (tm *TeamManager) ListTeams() []string {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	names := []string{}
	for _, key := range tm.order {
		if team := tm.teams[key]; team != nil {
			names = append(names, team.Name)
		}
	}
	return names
}

// ListTeamNames lists every team directory name in the project namespace,
// mirroring listTeamNames in the reference. It returns an empty list when the
// base directory does not exist.
func ListTeamNames(cwd string) []string {
	entries, err := os.ReadDir(TeamsBaseDir(cwd))
	if err != nil {
		return []string{}
	}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	return names
}

// RestoreFromDisk hydrates every team found in the project namespace, restoring
// pending notifications and reclaiming interrupted teammates' work, mirroring
// TeamManager.restoreFromDisk in the reference.
func (tm *TeamManager) RestoreFromDisk() {
	for _, name := range ListTeamNames(tm.cwd) {
		tm.GetTeam(name)
	}
}

// StopAll stops every teammate runtime across all teams while retaining the
// teams themselves, mirroring TeamManager.stopAll in the reference.
func (tm *TeamManager) StopAll() {
	for _, name := range tm.ListTeams() {
		if team := tm.GetTeam(name); team != nil {
			for _, member := range team.ListMembers() {
				team.StopMember(member.Name)
			}
		}
	}
}

func (tm *TeamManager) CloseAll() {
	for _, name := range tm.ListTeams() {
		if team := tm.GetTeam(name); team != nil {
			for _, member := range team.ListMembers() {
				team.StopMember(member.Name)
			}
		}
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if tm.unsubscribe != nil {
		tm.unsubscribe()
		tm.unsubscribe = nil
	}
	tm.checker = nil
	tm.teams = map[string]*Team{}
	tm.taskStores = map[string]*SharedTaskStore{}
	tm.order = nil
	tm.listenersMu.Lock()
	tm.listeners = map[int]func(){}
	tm.listenersMu.Unlock()
}
func (tm *TeamManager) SetPermissionChecker(checker *permissions.Checker) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if tm.checker == checker {
		return
	}
	if tm.unsubscribe != nil {
		tm.unsubscribe()
	}
	tm.checker = checker
	sync := func() {
		tm.mu.Lock()
		defer tm.mu.Unlock()
		for _, team := range tm.teams {
			team.mu.Lock()
			team.PermissionMode = checker.Mode()
			team.persist()
			team.mu.Unlock()
		}
	}
	tm.unsubscribe = checker.SubscribeMode(sync)
	for _, team := range tm.teams {
		team.mu.Lock()
		team.PermissionMode = checker.Mode()
		team.persist()
		team.mu.Unlock()
	}
}
func (t *Team) ListMembers() []*Member {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.membersInOrder()
}
func (t *Team) membersInOrder() []*Member {
	result := []*Member{}
	seen := map[string]bool{}
	for _, name := range t.memberOrder {
		if m := t.Members[name]; m != nil {
			result = append(result, m)
			seen[name] = true
		}
	}
	for name, m := range t.Members {
		if !seen[name] {
			result = append(result, m)
		}
	}
	return result
}
func (t *Team) releaseMemberTasks(name string) {
	store, err := NewSharedTaskStore(filepath.Join(teamDir(t.Cwd, t.Name), "tasks.json"))
	if err != nil {
		return
	}
	tasks, err := store.ReleaseOwner(name)
	if err == nil && len(tasks) > 0 {
		ids := []string{}
		for _, task := range tasks {
			ids = append(ids, "#"+task.ID)
		}
		_ = t.MailBox.Send(LeadName, NewFileMailMessage(name, fmt.Sprintf("[tasks-released] %s exited. Unassigned tasks: %s. Use TodoWrite({}) to inspect and reassign them.", name, strings.Join(ids, ", "))))
	}
}

func (t *Team) HasMember(name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Members[name] != nil
}

func (t *Team) GetMember(name string) *Member {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Members[name]
}

func (t *Team) MemberActive(name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	member := t.Members[name]
	return member != nil && member.Active
}
