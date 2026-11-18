package consumer_test

import (
	"context"
	_ "github.com/yukino-js/yukino/yukino/a2a"
	_ "github.com/yukino-js/yukino/yukino/bootstrap"
	_ "github.com/yukino-js/yukino/yukino/commands"
	_ "github.com/yukino-js/yukino/yukino/compact"
	_ "github.com/yukino-js/yukino/yukino/config"
	_ "github.com/yukino-js/yukino/yukino/file_history"
	_ "github.com/yukino-js/yukino/yukino/frontmatter"
	_ "github.com/yukino-js/yukino/yukino/goal"
	_ "github.com/yukino-js/yukino/yukino/history"
	_ "github.com/yukino-js/yukino/yukino/hooks"
	_ "github.com/yukino-js/yukino/yukino/images"
	_ "github.com/yukino-js/yukino/yukino/logger"
	_ "github.com/yukino-js/yukino/yukino/mcp"
	_ "github.com/yukino-js/yukino/yukino/memory"
	_ "github.com/yukino-js/yukino/yukino/permissions"
	_ "github.com/yukino-js/yukino/yukino/plan_file"
	_ "github.com/yukino-js/yukino/yukino/prompt"
	_ "github.com/yukino-js/yukino/yukino/recover"
	_ "github.com/yukino-js/yukino/yukino/remote"
	_ "github.com/yukino-js/yukino/yukino/sandbox"
	_ "github.com/yukino-js/yukino/yukino/skills"
	_ "github.com/yukino-js/yukino/yukino/storage"
	_ "github.com/yukino-js/yukino/yukino/subagent"
	_ "github.com/yukino-js/yukino/yukino/teams"
	_ "github.com/yukino-js/yukino/yukino/telemetry"
	_ "github.com/yukino-js/yukino/yukino/todo"
	_ "github.com/yukino-js/yukino/yukino/tool_result"
	_ "github.com/yukino-js/yukino/yukino/update"
	_ "github.com/yukino-js/yukino/yukino/utils"
	_ "github.com/yukino-js/yukino/yukino/version"
	_ "github.com/yukino-js/yukino/yukino/vscode"
	_ "github.com/yukino-js/yukino/yukino/workflow"
	_ "github.com/yukino-js/yukino/yukino/worktree"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/agent"
	"github.com/yukino-js/yukino/yukino/conversation"
	"github.com/yukino-js/yukino/yukino/llm"
	"github.com/yukino-js/yukino/yukino/session"
	"github.com/yukino-js/yukino/yukino/tools"
)

type provider struct{ turn int }

func (*provider) SetSystemPrompt(string) {}
func (p *provider) Stream(ctx context.Context, conv *conversation.Manager, schemas []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	events := make(chan llm.StreamEvent, 3)
	failures := make(chan error)
	if p.turn == 0 {
		events <- llm.ToolCallComplete{ToolID: "call-1", ToolName: "Echo", Arguments: map[string]any{}}
		events <- llm.StreamEnd{StopReason: "tool_use"}
	} else {
		events <- llm.TextDelta{Text: "done"}
		events <- llm.StreamEnd{StopReason: "end_turn"}
	}
	p.turn++
	close(events)
	close(failures)
	return events, failures
}

type echo struct{}

func (*echo) Name() string                 { return "Echo" }
func (*echo) Description() string          { return "Return a fixed message." }
func (*echo) Category() tools.ToolCategory { return tools.CategoryRead }
func (*echo) Schema() map[string]any {
	return map[string]any{"name": "Echo", "description": "Echo", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}}
}
func (*echo) Execute(context.Context, map[string]any) tools.ToolResult {
	return tools.ToolResult{Output: "echo-result"}
}

var _ llm.Client = (*provider)(nil)
var _ tools.Tool = (*echo)(nil)

func TestToolLoopAndSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	registry := tools.NewRegistry()
	defer registry.Dispose()
	registry.Register(&echo{})
	runner := agent.New(&provider{}, registry, "anthropic")
	runner.WorkDir = t.TempDir()
	runner.MaxIterations = 3
	runner.SessionID = session.NewID()
	runner.TranscriptPath = session.SessionFilePath(runner.WorkDir, runner.SessionID)
	conv := conversation.NewManager()
	conv.AddUserMessage("Run Echo")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var text string
	var result, complete bool
	for event := range runner.Run(ctx, conv) {
		switch event := event.(type) {
		case agent.StreamText:
			text += event.Text
		case agent.ToolResultEvent:
			result = event.Output == "echo-result" && !event.IsError
		case agent.LoopComplete:
			complete = true
		case agent.ErrorEvent:
			t.Fatal(event.Message)
		}
	}
	if text != "done" || !result || !complete {
		t.Fatalf("text=%q tool=%v complete=%v", text, result, complete)
	}
	saved, err := session.LoadSession(runner.WorkDir, runner.SessionID)
	if err != nil || len(session.RebuildFromSession(saved, false)) == 0 {
		t.Fatalf("session round trip: %v, messages=%d", err, len(saved))
	}
}

func TestCancellation(t *testing.T) {
	registry := tools.NewRegistry()
	defer registry.Dispose()
	runner := agent.New(&provider{}, registry, "anthropic")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var stopped bool
	for event := range runner.Run(ctx, conversation.NewManager()) {
		if event, ok := event.(agent.LoopComplete); ok {
			stopped = event.StopReason == "interrupted"
		}
	}
	if !stopped {
		t.Fatal("cancelled run did not report interruption")
	}
}
