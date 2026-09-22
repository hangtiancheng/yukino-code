// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package teams

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/permissions"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module:"teams"})).
var log = logger.CreateChildLogger("teams")

// TeamModeInProcess is the only backend the Go server implements; TS also
// supports tmux/iterm backends (teams/backend.ts, deliberately not ported).
const TeamModeInProcess = "in-process"

// Member mirrors the TS teams/index.ts Member: runtime fields (Active,
// Cancel, Done, Checker) plus persistence-only metadata. The agent instance
// and per-turn conversation live behind the injected RunAgent callback (TS:
// the team layer stays decoupled from the LLM/agent layer), so — exactly like
// TS — the Member itself carries no agent reference.
type Member struct {
	Name   string
	Active bool
	Cancel context.CancelFunc
	// Done is closed when the teammate's loop goroutine has fully exited, so
	// stoppers can wait for a complete stop (TS: Member.done). Nil for members
	// restored from disk, which have no live goroutine.
	Done chan struct{}

	// Checker is the teammate's permission checker. Plan mode uses it to
	// determine the current state; permissions are elevated in place once
	// approval is granted (TS: Member.checker).
	Checker *permissions.Checker

	// Conv is the optional transcript conversation (TS: Member.conversation).
	// In-process teammate turns run on fresh per-turn conversations owned by
	// the RunAgent callback, so — exactly like TS — this stays nil and the
	// exit-time transcript save is dormant unless a host sets it.
	Conv *conversation.Manager

	// The following fields are metadata for persistence; they do not
	// participate in runtime scheduling and are only used when writing
	// config.json and restoring a team from disk.
	AgentID      string
	AgentType    string
	Model        string
	WorktreePath string
	JoinedAt     int64
}

// MemberMeta carries the persistence metadata backfilled after spawn (TS:
// Team.setMemberMeta).
type MemberMeta struct {
	AgentType    string
	Model        string
	WorktreePath string
}

type Team struct {
	Name string
	// Mode is the team backend (TS: Team.mode). The Go port only implements
	// "in-process".
	Mode string
	// WorkDir is the project directory of the team's owner (TS: Team.workDir),
	// used for the transcript location and the plan-file fallback.
	WorkDir string

	MailBox *FileMailBox

	// baseDir is the teams storage root for this team's owner (one chat
	// session = one workspace). Team state never crosses workspaces, so two
	// users with same-named teams cannot overwrite each other's files.
	baseDir string

	// members is guarded by mu; memberOrder preserves insertion order (TS:
	// the members Map). Use the HasMember/GetMember/MemberNames/ListMembers
	// accessors instead of touching the map directly.
	members     map[string]*Member
	memberOrder []string
	mu          sync.Mutex

	// Team-level metadata for persistence.
	LeadAgentID string
	Description string
	CreatedAt   int64
}

func NewTeam(baseDir, workDir, name string) *Team {
	inboxDir := filepath.Join(baseDir, sanitizeTeamName(name), "inboxes")
	return &Team{
		Name:      name,
		Mode:      TeamModeInProcess,
		WorkDir:   workDir,
		baseDir:   baseDir,
		members:   make(map[string]*Member),
		MailBox:   NewFileMailBox(inboxDir),
		CreatedAt: time.Now().Unix(),
	}
}

// dir returns this team's storage directory.
func (t *Team) dir() string {
	return filepath.Join(t.baseDir, sanitizeTeamName(t.Name))
}

// AddMember registers a member with its mailbox and persistence metadata (TS:
// Team.addMember). The member starts inactive; SpawnTeammate flips it.
func (t *Team) AddMember(name string) *Member {
	t.mu.Lock()
	defer t.mu.Unlock()

	member := &Member{
		Name:     name,
		Active:   false,
		AgentID:  name,
		JoinedAt: time.Now().Unix(),
	}
	if _, exists := t.members[name]; !exists {
		t.memberOrder = append(t.memberOrder, name)
	}
	t.members[name] = member
	t.persist()
	return member
}

// SetMemberMeta backfills member metadata (agent type, model, worktree path)
// and persists (TS: Team.setMemberMeta). The spawn flow obtains this
// information later than AddMember, hence the two-step write.
func (t *Team) SetMemberMeta(name string, meta MemberMeta) {
	t.mu.Lock()
	defer t.mu.Unlock()
	member := t.members[name]
	if member == nil {
		return
	}
	member.AgentType = meta.AgentType
	member.Model = meta.Model
	member.WorktreePath = meta.WorktreePath
	t.persist()
}

// StopMember marks the member inactive, cancels its context, and waits for its
// loop goroutine to fully exit (TS: stopOne awaits member.done). The wait
// happens outside the lock because the exiting goroutine needs t.mu to clear
// Active.
func (t *Team) StopMember(name string) {
	t.mu.Lock()
	member, ok := t.members[name]
	if !ok {
		t.mu.Unlock()
		return
	}
	member.Active = false
	if member.Cancel != nil {
		member.Cancel()
	}
	done := member.Done
	t.persist()
	t.mu.Unlock()

	if done != nil {
		<-done
	}
}

// StopAll stops every member (TS: Team.stopAll).
func (t *Team) StopAll() {
	for _, member := range t.ListMembers() {
		t.StopMember(member.Name)
	}
}

// HasMember reports whether name is registered on the team.
func (t *Team) HasMember(name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.members[name]
	return ok
}

// GetMember returns the named member, or nil when absent.
func (t *Team) GetMember(name string) *Member {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.members[name]
}

// ListMembers returns the members in join order (TS: [...members.values()]).
func (t *Team) ListMembers() []*Member {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]*Member, 0, len(t.memberOrder))
	for _, name := range t.memberOrder {
		if m := t.members[name]; m != nil {
			out = append(out, m)
		}
	}
	return out
}

// MemberNames returns the member names in join order.
func (t *Team) MemberNames() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	names := make([]string, 0, len(t.memberOrder))
	names = append(names, t.memberOrder...)
	return names
}

// IsMemberActive reports whether the named member exists and is running.
func (t *Team) IsMemberActive(name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	member, ok := t.members[name]
	return ok && member.Active
}

// SendMessage delivers a plain-text message to a member's mailbox (TS:
// Team.sendMessage). An unknown recipient is an error, matching the TS throw.
func (t *Team) SendMessage(from, to, content string) error {
	if !t.HasMember(to) {
		return fmt.Errorf("Member '%s' not found in team '%s'", to, t.Name)
	}
	return t.MailBox.Send(to, FileMailMessage{
		From:      from,
		Text:      content,
		Timestamp: isoTimestamp(time.Now()),
	})
}

type TeamManager struct {
	mu         sync.Mutex
	baseDir    string
	workDir    string
	teams      map[string]*Team
	teamOrder  []string                    // insertion order, mirroring the TS Map
	taskStores map[string]*SharedTaskStore // one shared task store per team
}

// NewTeamManager creates a manager rooted at baseDir with the project workDir
// (TS: new TeamManager(workDir)). The TS default baseDir is ~/.yukino/teams
// (TeamsBaseDir); a chat server running the multi-user `concurrent` mode
// passes the session workspace instead so each user's teams live in their own
// directory.
func NewTeamManager(baseDir, workDir string) *TeamManager {
	return &TeamManager{
		baseDir:    baseDir,
		workDir:    workDir,
		teams:      make(map[string]*Team),
		taskStores: make(map[string]*SharedTaskStore),
	}
}

func (tm *TeamManager) teamDir(name string) string {
	return filepath.Join(tm.baseDir, sanitizeTeamName(name))
}

func (tm *TeamManager) CreateTeam(name string) *Team {
	return tm.CreateTeamFull(name, "", "")
}

// CreateTeamFull creates a team, records the lead and description, then writes
// the configuration to config.json. Once persisted, future sessions can
// recover the team via GetTeam.
func (tm *TeamManager) CreateTeamFull(name string, leadAgentID, description string) *Team {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	team := NewTeam(tm.baseDir, tm.workDir, name)
	team.LeadAgentID = leadAgentID
	team.Description = description
	if _, exists := tm.teams[name]; !exists {
		tm.teamOrder = append(tm.teamOrder, name)
	}
	tm.teams[name] = team
	// Initialize an empty shared task store for the new team.
	store := NewSharedTaskStore(filepath.Join(tm.teamDir(name), "tasks.json"))
	if err := store.InitEmpty(); err != nil {
		log.Error("teams operation failed", "err", err)
	}
	tm.taskStores[name] = store
	team.persist()
	return team
}

// GetTaskStore returns the team's shared task store; when not cached in memory
// (e.g. in a teammate process), it loads from tasks.json on disk.
func (tm *TeamManager) GetTaskStore(teamName string) *SharedTaskStore {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if store, ok := tm.taskStores[teamName]; ok {
		return store
	}
	store := NewSharedTaskStore(filepath.Join(tm.teamDir(teamName), "tasks.json"))
	tm.taskStores[teamName] = store
	return store
}

// CreateTeamWith registers an externally-constructed Team so SendMessage
// and the coordination tools can reach it in this process.
func (tm *TeamManager) CreateTeamWith(team *Team) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if _, exists := tm.teams[team.Name]; !exists {
		tm.teamOrder = append(tm.teamOrder, team.Name)
	}
	tm.teams[team.Name] = team
}

// GetTeam checks memory first; on miss, looks for config.json on disk.
// A Team reconstructed from disk carries only metadata — member agent
// instances and conversations are empty — sufficient for SendMessage to
// deliver by name and for UI display; actually running a member requires
// re-spawning.
func (tm *TeamManager) GetTeam(name string) *Team {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if team, ok := tm.teams[name]; ok {
		return team
	}
	tf := ReadTeamFile(tm.baseDir, name)
	if tf == nil {
		return nil
	}
	team := NewTeam(tm.baseDir, tm.workDir, tf.Name)
	mode := ""
	for _, m := range tf.Members {
		if m.BackendType != "" {
			mode = m.BackendType
			break
		}
	}
	if isTeamMode(mode) {
		team.Mode = mode
	}
	team.LeadAgentID = tf.LeadAgentID
	team.Description = tf.Description
	team.CreatedAt = tf.CreatedAt
	for _, m := range tf.Members {
		active := false
		if m.IsActive != nil {
			active = *m.IsActive
		}
		team.members[m.Name] = &Member{
			Name:         m.Name,
			AgentID:      m.AgentID,
			AgentType:    m.AgentType,
			Model:        m.Model,
			WorktreePath: m.WorktreePath,
			JoinedAt:     m.JoinedAt,
			Active:       active,
		}
		team.memberOrder = append(team.memberOrder, m.Name)
	}
	if _, exists := tm.teams[name]; !exists {
		tm.teamOrder = append(tm.teamOrder, name)
	}
	tm.teams[name] = team
	return team
}

// isTeamMode mirrors the TS isTeamMode guard; only "in-process" is reachable
// in the Go port (tmux/iterm are not ported).
func isTeamMode(mode string) bool {
	return mode == TeamModeInProcess
}

func (tm *TeamManager) DeleteTeam(name string) {
	tm.mu.Lock()
	team := tm.teams[name]
	tm.mu.Unlock()
	if team != nil {
		registry := GetNameRegistry()
		for _, memberName := range team.MemberNames() {
			team.StopMember(memberName)
			// Unbind this member's mapping in the global name registry.
			registry.Unregister(memberName)
		}
		tm.mu.Lock()
		delete(tm.teams, name)
		tm.removeOrderLocked(name)
		tm.mu.Unlock()
	}
	tm.mu.Lock()
	delete(tm.taskStores, name)
	tm.mu.Unlock()
	// The team directory contains config.json, tasks.json, and inboxes; once
	// the team is gone, remove them all to prevent a future same-named team
	// from picking up stale data.
	_ = os.RemoveAll(tm.teamDir(name))
}

func (tm *TeamManager) removeOrderLocked(name string) {
	for i, n := range tm.teamOrder {
		if n == name {
			tm.teamOrder = append(tm.teamOrder[:i], tm.teamOrder[i+1:]...)
			return
		}
	}
}

// DeleteAll deletes every team: in-memory teams are stopped and unregistered,
// then any residual team directories on disk (e.g. leftovers from previous
// sessions, which never appear in ListTeams) are removed too. Enforces the
// single-team invariant before a new team is created (TS: TeamManager.deleteAll).
func (tm *TeamManager) DeleteAll() {
	for _, name := range tm.ListTeams() {
		tm.DeleteTeam(name)
	}
	// Directory names are already sanitized; DeleteTeam re-sanitizes to the
	// same value.
	for _, name := range ListTeamNames(tm.baseDir) {
		tm.DeleteTeam(name)
	}
}

// ListTeams returns the team names in creation order (TS: [...teams.values()]
// over the Map's insertion order).
func (tm *TeamManager) ListTeams() []string {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	names := make([]string, 0, len(tm.teamOrder))
	for _, name := range tm.teamOrder {
		if _, ok := tm.teams[name]; ok {
			names = append(names, name)
		}
	}
	return names
}

// Teams returns the team objects in creation order (TS: TeamManager.list).
func (tm *TeamManager) Teams() []*Team {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	out := make([]*Team, 0, len(tm.teamOrder))
	for _, name := range tm.teamOrder {
		if team, ok := tm.teams[name]; ok {
			out = append(out, team)
		}
	}
	return out
}

// StopAll stops every member of every team but keeps the teams registered
// (TS: TeamManager.stopAll).
func (tm *TeamManager) StopAll() {
	for _, team := range tm.Teams() {
		team.StopAll()
	}
}

// HasActiveMembers reports whether any team has a running member. The chat
// server uses this to keep an idle session alive while its teammates work.
func (tm *TeamManager) HasActiveMembers() bool {
	for _, team := range tm.Teams() {
		for _, member := range team.ListMembers() {
			if member.Active {
				return true
			}
		}
	}
	return false
}

// CloseAll stops every member of every team and drops the in-memory teams.
// Session.close calls this so teammate goroutines cannot outlive the session
// that spawned them.
func (tm *TeamManager) CloseAll() {
	for _, team := range tm.Teams() {
		team.StopAll()
	}
	tm.mu.Lock()
	tm.teams = make(map[string]*Team)
	tm.teamOrder = nil
	tm.mu.Unlock()
}
