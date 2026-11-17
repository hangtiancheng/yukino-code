package teams

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/prompt"
)

func TestCoordinatorBlocksCodeTools(t *testing.T) {
	blocked := []string{"ReadFile", "WriteFile", "EditFile", "Glob", "Grep", "Bash"}
	for _, name := range blocked {
		if IsCoordinatorTool(name) {
			t.Errorf("%s must not appear in the coordinator tool set; reading and editing code should be delegated to workers", name)
		}
	}
}

func TestCoordinatorAllowsSchedulingTools(t *testing.T) {
	for _, name := range []string{"Agent", "SendMessage", "TaskStop", "SyntheticOutput", "TodoWrite", "TeamCreate", "TeamList"} {
		if !IsCoordinatorTool(name) {
			t.Errorf("%s is required for orchestration; without it the Lead cannot operate", name)
		}
	}
}

func TestCoordinatorKeepsTeamDeleteToAvoidLockIn(t *testing.T) {
	if !IsCoordinatorTool("TeamDelete") {
		t.Fatal("TeamDelete must be allowed, otherwise the Lead is locked into coordinator mode")
	}
}

func TestCoordinatorToolFilterIsStatic(t *testing.T) {
	filter := CoordinatorToolFilter(true)
	if filter == nil {
		t.Fatal("enabled=true should return a filter")
	}

	if filter("Bash") || filter("ReadFile") {
		t.Error("when enabled only the whitelist passes, regardless of whether a team exists")
	}
	if !filter("Agent") || !filter("SendMessage") {
		t.Error("orchestration tools should always pass")
	}
}

func TestCoordinatorActiveFnTracksToolFilter(t *testing.T) {
	filter := CoordinatorToolFilter(true)
	active := CoordinatorActiveFn(true)
	if active == nil {
		t.Fatal("enabled=true should return the predicate")
	}
	if !active() {
		t.Error("when enabled the predicate should always be active")
	}
	if active() != !filter("Bash") {
		t.Error("reminder injection and tool narrowing disagree on the condition")
	}
}

func TestCoordinatorDisabledReturnsNil(t *testing.T) {
	if CoordinatorToolFilter(false) != nil {
		t.Error("disabled should not return a filter")
	}
	if CoordinatorActiveFn(false) != nil {
		t.Error("disabled should not return the predicate")
	}
}

func TestTaskStopStopsTeammate(t *testing.T) {
	useTempHome(t)
	mgr := NewTeamManager(t.TempDir())
	team := createTestTeam(t, mgr, "squad")
	member, err := team.AddMember("scout")
	if err != nil {
		t.Fatal(err)
	}
	member.Active = true
	stopped := false
	member.Cancel = func() { stopped = true }

	tool := &TaskStopTool{TeamMgr: mgr}
	res := tool.Execute(context.Background(), map[string]any{"teammate": "scout"})
	if res.IsError {
		t.Fatalf("stopping a running teammate must not error: %s", res.Output)
	}
	if !stopped {
		t.Error("the teammate Cancel was not called")
	}
	if member.Active {
		t.Error("Active must be false after stopping")
	}
}

func TestTaskStopOnUnknownTeammate(t *testing.T) {
	useTempHome(t)
	mgr := NewTeamManager(t.TempDir())
	createTestTeam(t, mgr, "squad")

	tool := &TaskStopTool{TeamMgr: mgr}
	res := tool.Execute(context.Background(), map[string]any{"teammate": "ghost"})
	if !res.IsError {
		t.Error("stopping a nonexistent teammate should error")
	}
}

func TestTaskStopOnIdleTeammate(t *testing.T) {
	useTempHome(t)
	mgr := NewTeamManager(t.TempDir())
	team := createTestTeam(t, mgr, "squad")
	if _, err := team.AddMember("scout"); err != nil {
		t.Fatal(err)
	}

	tool := &TaskStopTool{TeamMgr: mgr}
	res := tool.Execute(context.Background(), map[string]any{"teammate": "scout"})
	if res.IsError {
		t.Errorf("stopping an idle teammate must not error: %s", res.Output)
	}
}

func TestCoordinatorPromptUsesRealSubagentType(t *testing.T) {
	p := prompt.CoordinatorReminder(1)
	if strings.Contains(p, `subagent_type: "worker"`) || strings.Contains(p, "subagent_type `worker`") {
		t.Error("the prompt mentions a nonexistent subagent_type")
	}
}

func TestCoordinatorPromptListsOnlyAllowedTools(t *testing.T) {
	p := prompt.CoordinatorReminder(1)
	toolsSection := p[strings.Index(p, "## Tools"):strings.Index(p, "## Delegation")]
	for name := range CoordinatorAllowedTools {
		// The reference allows Goal in coordinator mode but does not document it
		// in the prompt's Tools list; mirror that omission.
		if name == "Goal" {
			continue
		}
		if !strings.Contains(toolsSection, "**"+name+"**") {
			t.Errorf("whitelisted %s is missing from the prompt tool list", name)
		}
	}
	for _, name := range []string{"ReadFile", "Bash", "Grep"} {
		if strings.Contains(toolsSection, "**"+name+"**") {
			t.Errorf("the prompt tool list contains filtered-out %s", name)
		}
	}
}

func TestCoordinatorPromptMatchesTeamNotificationFormat(t *testing.T) {
	p := prompt.CoordinatorReminder(1)
	if !strings.Contains(p, "<task-notification") || !strings.Contains(p, "from=") {
		t.Error("the reminder should describe the real <task-notification> and from= format")
	}
	if strings.Contains(p, "<task_id>") {
		t.Error("the reminder describes the background subagent channel, not the teammate reply channel")
	}
}

func TestCoordinatorReminderGoesSparseAfterFirstTurn(t *testing.T) {
	full := prompt.CoordinatorReminder(1)
	second := prompt.CoordinatorReminder(2)
	if len(second) >= len(full) {
		t.Fatalf("the second turn should send the sparse version, got %d bytes vs %d for the first", len(second), len(full))
	}
	for _, must := range []string{"cannot read files", "TaskStop", "from="} {
		if !strings.Contains(second, must) {
			t.Errorf("the sparse version lost a key constraint: %s", must)
		}
	}
	var sawFull bool
	for i := 2; i <= 12; i++ {
		if prompt.CoordinatorReminder(i) == full {
			sawFull = true
			break
		}
	}
	if !sawFull {
		t.Error("long sessions should periodically repeat the full text")
	}
}

func TestCoordinatorWiringIsSameAcrossEntrypoints(t *testing.T) {
	roots := map[string][]string{
		"ui":     {"../ui"},
		"remote": {"../remote/server.go"},
		"print":  {"../../cmd/yukino/print.go"},
	}
	required := []string{
		"teams.TeamCreateTool",
		"teams.TeamDeleteTool",
		"teams.TaskStopTool",
		"tools.SyntheticOutputTool",
		"CoordinatorToolFilter",
		"CoordinatorActiveFn",
		"DrainLeadMailbox",
	}
	for entry, path := range roots {
		src := readEntrySource(t, path)
		for _, want := range required {
			if !strings.Contains(src, want) {
				t.Errorf("%s entrypoint is missing %s; the coordinator is incomplete there", entry, want)
			}
		}
	}
}

// readEntrySource concatenates the Go sources of an entrypoint, which may be
// a single file or a whole package directory.
func readEntrySource(t *testing.T, paths []string) string {
	t.Helper()
	var sb strings.Builder
	for _, path := range paths {
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			entries, err := os.ReadDir(path)
			if err != nil {
				t.Fatalf("cannot read %s: %v", path, err)
			}
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
					continue
				}
				data, err := os.ReadFile(filepath.Join(path, e.Name()))
				if err != nil {
					t.Fatalf("cannot read %s: %v", e.Name(), err)
				}
				sb.Write(data)
			}
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("cannot read %s: %v", path, err)
		}
		sb.Write(data)
	}
	return sb.String()
}

func TestTaskStopSchemaTaskIDDescriptions(t *testing.T) {
	tool := &TaskStopTool{TeamMgr: newTestTeamManager(t)}
	delegated, ok := tool.ForSubagent().(*TaskStopTool)
	if !ok || !delegated.Delegated {
		t.Fatal("ForSubagent must produce a delegated TaskStopTool")
	}
	delegatedProps := delegated.Schema()["input_schema"].(map[string]any)["properties"].(map[string]any)
	if got := delegatedProps["task_id"].(map[string]any)["description"]; got != "ID of this agent's background task" {
		t.Fatalf("delegated task_id description = %q", got)
	}
	if _, hasTeammate := delegatedProps["teammate"]; hasTeammate {
		t.Fatal("delegated schema must not expose teammate")
	}
	leaderProps := tool.Schema()["input_schema"].(map[string]any)["properties"].(map[string]any)
	if got := leaderProps["task_id"].(map[string]any)["description"]; got != "ID of a background task (Agent, Bash, PowerShell)" {
		t.Fatalf("leader task_id description = %q", got)
	}
}
