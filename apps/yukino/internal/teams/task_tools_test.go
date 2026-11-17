package teams

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/todo"
)

func newTestTeamManager(t *testing.T) *TeamManager {
	t.Helper()
	useTempHome(t)
	GetNameRegistry().Clear()
	t.Cleanup(func() { GetNameRegistry().Clear() })
	return NewTeamManager(t.TempDir())
}
func TestTeamTodoWriteFlowAndAtomicAssignment(t *testing.T) {
	mgr := newTestTeamManager(t)
	team := createTestTeam(t, mgr, "myteam")
	if _, err := team.AddMember("alice"); err != nil {
		t.Fatal(err)
	}
	tool := &TeamTodoWriteTool{TeamMgr: mgr, TeamName: "myteam"}
	ctx := context.Background()
	result := tool.Execute(ctx, map[string]any{"todos": []any{map[string]any{"subject": "assigned", "owner": "alice"}, map[string]any{"subject": "invalid", "owner": "ghost"}}})
	if !result.IsError {
		t.Fatal(result)
	}
	store, err := mgr.GetTaskStore("myteam")
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := store.ListTasks("", "")
	if err != nil || len(tasks) != 0 {
		t.Fatal(tasks, err)
	}
	messages, err := team.MailBox.ReadUnread("alice")
	if err != nil || len(messages) != 0 {
		t.Fatal(messages, err)
	}
	result = tool.Execute(ctx, map[string]any{"todos": []any{map[string]any{"subject": "assigned", "owner": "alice", "priority": "high"}, map[string]any{"subject": "other"}}})
	if result.IsError || !strings.Contains(result.Output, `"boardId": "team:myteam"`) || !strings.Contains(result.Output, `"createdBy": "leader"`) || !strings.Contains(result.Output, "DONE 0/2") {
		t.Fatal(result)
	}
	messages, err = team.MailBox.ReadUnread("alice")
	if err != nil || len(messages) != 1 || !strings.Contains(messages[0].Text, "TodoWrite") {
		t.Fatal(messages, err)
	}
	result = tool.Execute(ctx, map[string]any{"todos": []any{map[string]any{"id": "1", "status": "completed"}}})
	if result.IsError || !strings.Contains(result.Output, "DONE 1/2") {
		t.Fatal(result)
	}
	scoped := &TeamTodoWriteTool{TeamMgr: mgr, TeamName: "myteam", AgentName: "alice"}
	if result := scoped.Execute(ctx, map[string]any{"team_name": "other"}); !result.IsError {
		t.Fatal(result)
	}
	if result := tool.Execute(ctx, map[string]any{"todos": []any{map[string]any{"id": "42", "status": "completed"}}}); !result.IsError {
		t.Fatal(result)
	}
}
func TestTeamTodoWriteFallbackAndAmbiguousTeam(t *testing.T) {
	mgr := newTestTeamManager(t)
	list, _ := todo.NewTaskList(nil)
	tool := &TeamTodoWriteTool{TeamMgr: mgr, Fallback: list}
	ctx := context.Background()
	result := tool.Execute(ctx, map[string]any{"todos": []any{map[string]any{"subject": "private"}}})
	if result.IsError || !strings.Contains(result.Output, `"boardId": "private:`) {
		t.Fatal(result)
	}
	createTestTeam(t, mgr, "one")
	createTestTeam(t, mgr, "two")
	if result := tool.Execute(ctx, map[string]any{}); !result.IsError || !strings.Contains(result.Output, "Multiple teams") {
		t.Fatal(result)
	}
	result = tool.Execute(ctx, map[string]any{"team_name": "two", "todos": []any{map[string]any{"subject": "team"}}})
	if result.IsError || !strings.Contains(result.Output, `"boardId": "team:two"`) {
		t.Fatal(result)
	}
}
func TestDeleteTeamUnregistersMembers(t *testing.T) {
	mgr := newTestTeamManager(t)
	team := createTestTeam(t, mgr, "myteam")
	team.Members["alice"] = &Member{Name: "alice"}
	GetNameRegistry().Register("alice", "alice")
	mgr.DeleteTeam("myteam")
	if mgr.GetTeam("myteam") != nil || GetNameRegistry().Resolve("alice") != "" {
		t.Fatal("team or member registration retained")
	}
}

func createTestTeam(t *testing.T, manager *TeamManager, name string) *Team {
	t.Helper()
	team, err := manager.CreateTeam(name, "", "")
	if err != nil {
		t.Fatal(err)
	}
	return team
}
func createTestTeamFull(t *testing.T, manager *TeamManager, name string, leader, description string) *Team {
	t.Helper()
	team, err := manager.CreateTeam(name, leader, description)
	if err != nil {
		t.Fatal(err)
	}
	return team
}

func TestSubscribeLeaderTasksFallback(t *testing.T) {
	mgr := newTestTeamManager(t)
	fallback, err := todo.NewTaskList(nil)
	if err != nil {
		t.Fatal(err)
	}
	type call struct {
		tasks   []*todo.Task
		boardID string
	}
	var mu sync.Mutex
	var calls []call
	unsubscribe := SubscribeLeaderTasks(mgr, fallback, func(tasks []*todo.Task, boardID string) {
		mu.Lock()
		calls = append(calls, call{tasks, boardID})
		mu.Unlock()
	})
	defer unsubscribe()

	mu.Lock()
	if len(calls) == 0 {
		mu.Unlock()
		t.Fatal("expected an initial broadcast on subscribe")
	}
	first := calls[0]
	mu.Unlock()
	if !strings.HasPrefix(first.boardID, PrivateBoardIDPrefix) {
		t.Fatalf("boardID = %q, want %q prefix", first.boardID, PrivateBoardIDPrefix)
	}
	if len(first.tasks) != 0 {
		t.Fatalf("initial tasks = %v, want empty", first.tasks)
	}

	if _, err := fallback.Write(map[string]any{"todos": []any{map[string]any{"subject": "write tests", "status": "pending"}}}); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(calls) < 2 {
		t.Fatalf("expected a broadcast after write, got %d calls", len(calls))
	}
	last := calls[len(calls)-1]
	if len(last.tasks) != 1 || last.tasks[0].Subject != "write tests" {
		t.Fatalf("last tasks = %#v", last.tasks)
	}
	if !strings.HasPrefix(last.boardID, PrivateBoardIDPrefix) {
		t.Fatalf("boardID = %q, want %q prefix", last.boardID, PrivateBoardIDPrefix)
	}
}

func TestSubscribeLeaderTasksTeamAggregation(t *testing.T) {
	mgr := newTestTeamManager(t)
	fallback, err := todo.NewTaskList(nil)
	if err != nil {
		t.Fatal(err)
	}
	type call struct {
		tasks   []*todo.Task
		boardID string
	}
	var mu sync.Mutex
	var calls []call
	unsubscribe := SubscribeLeaderTasks(mgr, fallback, func(tasks []*todo.Task, boardID string) {
		mu.Lock()
		calls = append(calls, call{tasks, boardID})
		mu.Unlock()
	})
	defer unsubscribe()

	createTestTeam(t, mgr, "alpha")
	alphaStore, err := mgr.GetTaskStore("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := alphaStore.Write(map[string]any{"todos": []any{map[string]any{"subject": "team task", "status": "pending"}}}, todo.WriteOptions{}); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		last := calls[len(calls)-1]
		mu.Unlock()
		if strings.HasPrefix(last.boardID, TeamBoardIDPrefix) && len(last.tasks) == 1 {
			if last.tasks[0].Subject != "team task" {
				t.Fatalf("subject = %q, want 'team task'", last.tasks[0].Subject)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("did not observe team aggregation; last = %#v", calls[len(calls)-1])
}

func TestPruneTerminatedMembers(t *testing.T) {
	mgr := newTestTeamManager(t)
	team, err := mgr.CreateTeam("prune-team", "", "")
	if err != nil {
		t.Fatal(err)
	}
	team.mu.Lock()
	for i := 0; i < MaxRetainedTerminatedMembers+5; i++ {
		memberName := fmt.Sprintf("member-%03d", i)
		m := &Member{Name: memberName, AgentID: memberName, Active: false, Progress: NewTeammateProgress(memberName, team.Name, TeammateSpinnerVerb)}
		m.Progress.SetStatus("stopped")
		team.Members[memberName] = m
		team.memberOrder = append(team.memberOrder, memberName)
	}
	team.pruneTerminatedMembers()
	remaining := len(team.memberOrder)
	first := team.memberOrder[0]
	team.mu.Unlock()
	if remaining != MaxRetainedTerminatedMembers {
		t.Fatalf("remaining = %d, want %d", remaining, MaxRetainedTerminatedMembers)
	}
	if first != "member-005" {
		t.Fatalf("first remaining = %q, want member-005 (oldest evicted)", first)
	}
}

func TestListTeamNamesAndRestoreFromDisk(t *testing.T) {
	mgr := newTestTeamManager(t)
	if _, err := mgr.CreateTeam("team-alpha", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.CreateTeam("team-beta", "", ""); err != nil {
		t.Fatal(err)
	}

	names := ListTeamNames(mgr.cwd)
	found := map[string]bool{}
	for _, n := range names {
		found[n] = true
	}
	if !found["team-alpha"] || !found["team-beta"] {
		t.Fatalf("ListTeamNames = %v, want team-alpha and team-beta", names)
	}

	// A fresh manager for the same cwd starts with no in-memory teams; restoring
	// from disk must hydrate both.
	mgr2 := NewTeamManager(mgr.cwd)
	if got := mgr2.ListTeams(); len(got) != 0 {
		t.Fatalf("fresh manager should have no teams, got %v", got)
	}
	mgr2.RestoreFromDisk()
	restored := map[string]bool{}
	for _, n := range mgr2.ListTeams() {
		restored[n] = true
	}
	if !restored["team-alpha"] || !restored["team-beta"] {
		t.Fatalf("RestoreFromDisk hydrated %v, want team-alpha and team-beta", mgr2.ListTeams())
	}
}
