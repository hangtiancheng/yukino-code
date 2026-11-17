package teams

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

const teamNameParamDescription = "Target team name returned by TeamCreate or TeamList. Required when multiple teams match; omitted when only one team matches. Teammates are restricted to their own team."
const teamTodoWriteDescription = "Use team_name to select a team's TODO board when multiple teams exist. Teammates always use their own team's board."

type teamTaskBoard struct {
	manager   *TeamManager
	teamName  string
	agentName string
	fallback  todo.Board
}

func (b *teamTaskBoard) board() (*Team, error) {
	team, err := b.manager.ResolveTeam(b.teamName)
	if err != nil {
		return nil, err
	}
	if team == nil && b.fallback == nil {
		return nil, fmt.Errorf("No active team task board")
	}
	return team, nil
}
func (b *teamTaskBoard) BoardID() string {
	team, err := b.board()
	if err != nil {
		return ""
	}
	if team == nil {
		return b.fallback.BoardID()
	}
	return "team:" + team.Name
}
func (b *teamTaskBoard) Write(input map[string]any) ([]*todo.Task, error) {
	team, err := b.board()
	if err != nil {
		return nil, err
	}
	if team == nil {
		return b.fallback.Write(input)
	}
	actor := b.agentName
	if actor == LeadName {
		actor = ""
	}
	store, err := b.manager.GetTaskStore(team.Name)
	if err != nil {
		return nil, err
	}
	tasks, err := store.Write(input, todo.WriteOptions{Actor: actor, CreateTask: func(task *todo.Task) { name := b.agentName; task.CreatedBy = &name }, ValidateOwner: func(name string) error {
		if name == LeadName {
			return nil
		}
		team.mu.Lock()
		member := team.Members[name]
		available := member != nil && (member.Active || member.Progress == nil)
		team.mu.Unlock()
		if !available {
			return fmt.Errorf("Teammate '%s' is not available for assignment", name)
		}
		return nil
	}})
	if err != nil {
		return nil, err
	}
	parsed, _ := todo.ParseWrite(input)
	newCount := 0
	for _, edit := range parsed.Todos {
		if edit["id"] == nil {
			newCount++
		}
	}
	newIndex := len(tasks) - newCount
	for _, edit := range parsed.Todos {
		id, _ := edit["id"].(string)
		if id == "" {
			id = tasks[newIndex].ID
			newIndex++
		}
		owner, _ := edit["owner"].(string)
		if owner == "" || owner == LeadName || owner == b.agentName {
			continue
		}
		for _, task := range tasks {
			if task.ID == id && task.Owner == owner {
				message := fmt.Sprintf("Task assignment: #%s %s\n%s\nUse TodoWrite({}) to inspect dependencies, then TodoWrite({todos:[{id:\"%s\",status:\"in_progress\"}]}) to claim it before starting.", task.ID, task.Subject, task.Description, task.ID)
				if err := team.MailBox.Send(owner, NewFileMailMessage(b.agentName, message)); err != nil {
					return nil, err
				}
			}
		}
	}
	return tasks, nil
}

type TeamTodoWriteTool struct {
	TeamMgr   *TeamManager
	TeamName  string
	AgentName string
	Fallback  todo.Board
}

func (t *TeamTodoWriteTool) Name() string { return "TodoWrite" }
func (t *TeamTodoWriteTool) Description() string {
	return todo.WriteDescription + " " + teamTodoWriteDescription
}
func (t *TeamTodoWriteTool) Category() tools.ToolCategory          { return tools.CategoryRead }
func (t *TeamTodoWriteTool) IsConcurrencySafe(map[string]any) bool { return true }
func (t *TeamTodoWriteTool) tool(name string) *todo.TodoWriteTool {
	actor := t.AgentName
	if actor == "" {
		actor = LeadName
	}
	return &todo.TodoWriteTool{Board: &teamTaskBoard{manager: t.TeamMgr, teamName: name, agentName: actor, fallback: t.Fallback}}
}
func (t *TeamTodoWriteTool) Schema() map[string]any {
	schema := t.tool(t.TeamName).Schema()
	schema["description"] = t.Description()
	schema["input_schema"].(map[string]any)["properties"].(map[string]any)["team_name"] = map[string]any{"type": "string", "description": teamNameParamDescription}
	return schema
}
func (t *TeamTodoWriteTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	name, _ := args["team_name"].(string)
	if name == "" {
		name = t.TeamName
	}
	if t.TeamName != "" && sanitizeTeamName(name) != sanitizeTeamName(t.TeamName) {
		return tools.ToolResult{Output: "Teammates can only access their own team.", IsError: true}
	}
	input := map[string]any{}
	for key, value := range args {
		if key != "team_name" {
			input[key] = value
		}
	}
	return t.tool(name).Execute(ctx, input)
}
func (t *TeamTodoWriteTool) ForSubagent() tools.Tool {
	list, _ := todo.NewTaskList(nil)
	return &todo.TodoWriteTool{Board: list}
}
func (tm *TeamManager) ResolveTeam(name string) (*Team, error) {
	return tm.ResolveTeamForMember(name, "")
}
func (tm *TeamManager) ResolveTeamForMember(name, member string) (*Team, error) {
	if name != "" {
		if strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("Team name must not be empty or whitespace.")
		}
		team := tm.GetTeam(name)
		if team == nil {
			return nil, fmt.Errorf("Team '%s' not found.", name)
		}
		if member != "" && !team.HasMember(member) {
			return nil, nil
		}
		return team, nil
	}
	matches := []*Team{}
	for _, name := range tm.ListTeams() {
		team := tm.GetTeam(name)
		if team != nil && (member == "" || team.HasMember(member)) {
			matches = append(matches, team)
		}
	}
	if len(matches) > 1 {
		return nil, fmt.Errorf("Multiple teams match. Specify team_name; use TeamList to see available teams.")
	}
	if len(matches) == 0 {
		return nil, nil
	}
	return matches[0], nil
}

const (
	// TeamBoardIDPrefix and PrivateBoardIDPrefix mirror the reference board-id
	// prefixes; SubscribeLeaderTasks composes them with a generation counter.
	TeamBoardIDPrefix    = "team:"
	PrivateBoardIDPrefix = "private:"
	// LeaderTaskRefreshIntervalMS mirrors LEADER_TASK_REFRESH_INTERVAL_MS.
	LeaderTaskRefreshIntervalMS = 500
)

func jsonStringArray(items []string) string {
	data, _ := json.Marshal(items)
	return string(data)
}

func remapTaskIDs(teamName string, ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, jsonStringArray([]string{teamName, id}))
	}
	return out
}

func sameStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// SubscribeLeaderTasks mirrors subscribeLeaderTasks in the reference: it tracks
// the leader's task board (the aggregated team stores when teams exist,
// otherwise the private fallback list) and invokes listener with the tasks and a
// stable board id whenever they change. The returned function unsubscribes.
func SubscribeLeaderTasks(manager *TeamManager, fallback *todo.TaskList, listener func(tasks []*todo.Task, boardID string)) func() {
	var (
		mu          sync.Mutex
		teamNames   []string
		storeUnsubs []func()
		signature   string
		generation  int
		disposed    bool
	)
	var refresh func()
	refresh = func() {
		mu.Lock()
		if disposed {
			mu.Unlock()
			return
		}
		nextTeams := manager.ListTeams()
		if !sameStringSlice(nextTeams, teamNames) {
			for _, unsubscribe := range storeUnsubs {
				unsubscribe()
			}
			teamNames = nextTeams
			generation++
			storeUnsubs = make([]func(), 0, len(teamNames))
			for _, name := range teamNames {
				store, err := manager.GetTaskStore(name)
				if err != nil {
					continue
				}
				storeUnsubs = append(storeUnsubs, store.Subscribe(func([]*todo.Task) { refresh() }))
			}
		}
		var tasks []*todo.Task
		if len(teamNames) > 0 {
			for _, name := range teamNames {
				store, err := manager.GetTaskStore(name)
				if err != nil {
					continue
				}
				storeTasks, err := store.ListTasks("", "")
				if err != nil {
					continue
				}
				for _, task := range storeTasks {
					if len(teamNames) == 1 {
						tasks = append(tasks, task)
						continue
					}
					remapped := *task
					remapped.ID = jsonStringArray([]string{name, task.ID})
					remapped.Subject = "[" + name + "] " + task.Subject
					remapped.Blocks = remapTaskIDs(name, task.Blocks)
					remapped.BlockedBy = remapTaskIDs(name, task.BlockedBy)
					tasks = append(tasks, &remapped)
				}
			}
		} else if fallback != nil {
			tasks = fallback.List()
		}
		var boardID string
		if len(teamNames) > 0 {
			boardID = TeamBoardIDPrefix + jsonStringArray(teamNames) + ":" + strconv.Itoa(generation)
		} else {
			boardID = PrivateBoardIDPrefix + strconv.Itoa(generation)
		}
		sigBytes, _ := json.Marshal([]any{boardID, tasks})
		nextSignature := string(sigBytes)
		changed := signature != nextSignature
		signature = nextSignature
		mu.Unlock()
		if changed {
			listener(tasks, boardID)
		}
	}
	var unsubscribePrivate func()
	if fallback != nil {
		unsubscribePrivate = fallback.Subscribe(func([]*todo.Task) { refresh() })
	}
	unsubscribeTeams := manager.Subscribe(refresh)
	ticker := time.NewTicker(time.Duration(LeaderTaskRefreshIntervalMS) * time.Millisecond)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				refresh()
			case <-done:
				return
			}
		}
	}()
	return func() {
		mu.Lock()
		disposed = true
		stores := storeUnsubs
		storeUnsubs = nil
		mu.Unlock()
		ticker.Stop()
		close(done)
		for _, unsubscribe := range stores {
			unsubscribe()
		}
		if unsubscribePrivate != nil {
			unsubscribePrivate()
		}
		unsubscribeTeams()
	}
}
