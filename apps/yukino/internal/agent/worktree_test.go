package agent

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func initAgentWorktreeRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	repo, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.name", "Test"}, {"config", "user.email", "test@example.invalid"}, {"-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s %v", args, out, err)
		}
	}
	return repo
}

func TestWorktreeSwitchWithinBatchAndAcrossRuns(t *testing.T) {
	repo := initAgentWorktreeRepo(t)
	processCwd, _ := os.Getwd()
	registry := tools.NewRegistry()
	for _, tool := range []tools.Tool{&tools.EnterWorktreeTool{}, &tools.ExitWorktreeTool{}, &tools.WriteFileTool{}, &tools.ReadFileTool{}, &tools.BashTool{}} {
		registry.Register(tool)
	}
	call := func(id, name string, args map[string]any) llm.StreamEvent {
		return llm.ToolCallComplete{ToolID: id, ToolName: name, Arguments: args}
	}
	client := &mockClient{responses: [][]llm.StreamEvent{
		{call("enter", "EnterWorktree", map[string]any{"slug": "agent-loop"}), call("write-enter", "WriteFile", map[string]any{"file_path": "only-worktree.txt", "content": "isolated"}), call("read-enter", "ReadFile", map[string]any{"file_path": "only-worktree.txt"}), call("pwd-enter", "Bash", map[string]any{"command": "pwd"}), llm.StreamEnd{StopReason: "tool_use"}},
		{llm.StreamEnd{StopReason: "end_turn"}},
		{call("pwd-turn", "Bash", map[string]any{"command": "pwd"}), call("exit", "ExitWorktree", map[string]any{"action": "keep"}), call("write-exit", "WriteFile", map[string]any{"file_path": "only-original.txt", "content": "original"}), call("pwd-exit", "Bash", map[string]any{"command": "pwd"}), llm.StreamEnd{StopReason: "tool_use"}},
		{llm.StreamEnd{StopReason: "end_turn"}},
	}}
	checker := permissions.NewChecker(permissions.NewPathSandbox(repo, true), permissions.NewRuleEngine(repo), permissions.ModeAcceptEdits)
	conv := conversation.NewManager()
	outputs := map[string]string{}
	run := func(text string) {
		ag := New(client, registry, "anthropic")
		ag.WorkDir, ag.Checker = repo, checker
		conv.AddUserMessage(text)
		for event := range ag.Run(context.Background(), conv) {
			switch event := event.(type) {
			case PermissionRequestEvent:
				event.ResponseCh <- PermissionReply{Response: PermAllow}
			case ToolResultEvent:
				if event.IsError {
					t.Fatalf("%s: %s", event.ToolID, event.Output)
				}
				outputs[event.ToolID] = event.Output
			case ErrorEvent:
				t.Fatal(event.Message)
			}
		}
	}
	run("enter worktree")
	wt := checker.WorktreeSession()
	if wt == nil {
		t.Fatal("worktree not entered")
	}
	if !strings.Contains(outputs["pwd-enter"], wt.WorktreePath) || !strings.Contains(outputs["read-enter"], "isolated") {
		t.Fatalf("wrong tool cwd: %+v", outputs)
	}
	if _, err := os.Stat(filepath.Join(repo, "only-worktree.txt")); !os.IsNotExist(err) {
		t.Fatal("write reached parent")
	}
	run("exit and keep")
	if !strings.Contains(outputs["pwd-turn"], wt.WorktreePath) || !strings.Contains(outputs["pwd-exit"], repo) {
		t.Fatalf("wrong restored cwd: %+v", outputs)
	}
	if _, err := os.Stat(filepath.Join(wt.WorktreePath, "only-original.txt")); !os.IsNotExist(err) {
		t.Fatal("write reached kept worktree")
	}
	if data, _ := os.ReadFile(filepath.Join(repo, "only-original.txt")); string(data) != "original" {
		t.Fatal("parent write missing")
	}
	if checker.WorktreeSession() != nil || checker.Cwd() != repo {
		t.Fatal("checker not restored")
	}
	foundReminder := false
	for _, message := range conv.GetMessages() {
		if strings.Contains(message.Content, WorkingDirectoryMarker+"\nThe agent's current working directory is "+repo+".") {
			foundReminder = true
		}
	}
	if !foundReminder {
		t.Fatal("working-directory reminder not restored")
	}
	if cwd, _ := os.Getwd(); cwd != processCwd {
		t.Fatal("process cwd changed")
	}
}
