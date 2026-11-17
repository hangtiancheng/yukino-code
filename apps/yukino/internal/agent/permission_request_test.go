package agent

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type writeMockTool struct {
	executions int
}

func (t *writeMockTool) Name() string                 { return "WriteFile" }
func (t *writeMockTool) Description() string          { return "mock write" }
func (t *writeMockTool) Category() tools.ToolCategory { return tools.CategoryWrite }
func (t *writeMockTool) Schema() map[string]any {
	return map[string]any{
		"name": "WriteFile", "description": "mock",
		"input_schema": map[string]any{"type": "object", "properties": map[string]any{}},
	}
}
func (t *writeMockTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	t.executions++
	return tools.ToolResult{Output: "written"}
}

func newAskAgent(t *testing.T, client llm.Client, tool *writeMockTool) (*Agent, string) {
	t.Helper()
	dir := t.TempDir()
	reg := tools.NewRegistry()
	reg.Register(tool)
	ag := New(client, reg, "anthropic")
	ag.Checker = permissions.NewChecker(permissions.NewPathSandbox(dir, true), permissions.NewRuleEngine(dir), permissions.ModeDefault)
	return ag, filepath.Join(dir, "a.txt")
}

func writeCallResponses(path string, rounds int) [][]llm.StreamEvent {
	responses := make([][]llm.StreamEvent, 0, rounds+1)
	for i := 0; i < rounds; i++ {
		responses = append(responses, []llm.StreamEvent{
			llm.ToolCallStart{ToolName: "WriteFile", ToolID: "w" + string(rune('1'+i))},
			llm.ToolCallComplete{ToolID: "w" + string(rune('1'+i)), ToolName: "WriteFile", Arguments: map[string]any{"file_path": path, "content": "x"}},
			llm.StreamEnd{StopReason: "tool_use"},
		})
	}
	return append(responses, []llm.StreamEvent{
		llm.TextDelta{Text: "ok"},
		llm.StreamEnd{StopReason: "end_turn"},
	})
}

// TestPermissionDenyKeepsPlainRejection pins the reference deny path: the
// tool does not run and the paired tool_result is the plain rejection.
func TestPermissionDenyKeepsPlainRejection(t *testing.T) {
	tool := &writeMockTool{}
	client := &mockClient{}
	ag, path := newAskAgent(t, client, tool)
	client.responses = writeCallResponses(path, 1)

	conv := conversation.NewManager()
	conv.AddUserMessage("write it")
	asked := false
	var results []ToolResultEvent
	for ev := range ag.Run(context.Background(), conv) {
		switch e := ev.(type) {
		case PermissionRequestEvent:
			asked = true
			e.ResponseCh <- PermissionReply{Response: PermDeny}
		case ToolResultEvent:
			results = append(results, e)
		}
	}
	if !asked {
		t.Fatal("expected a permission request for a write tool in default mode")
	}
	if tool.executions != 0 {
		t.Error("tool must not run after the user denies it")
	}
	if len(results) != 1 || !results[0].IsError || results[0].Output != conversation.RejectedToolResult {
		t.Fatalf("results = %+v", results)
	}
}

// TestPermissionAbortWhileWaitingRejects pins requestToolPermission's race:
// an abort while the request is pending resolves as "deny" (plain rejection),
// the tool does not run, and the loop still completes as interrupted.
func TestPermissionAbortWhileWaitingRejects(t *testing.T) {
	tool := &writeMockTool{}
	client := &mockClient{}
	ag, path := newAskAgent(t, client, tool)
	client.responses = writeCallResponses(path, 1)

	conv := conversation.NewManager()
	conv.AddUserMessage("write it")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var results []ToolResultEvent
	var complete LoopComplete
	sawComplete := false
	for ev := range ag.Run(ctx, conv) {
		switch e := ev.(type) {
		case PermissionRequestEvent:
			cancel()
		case ToolResultEvent:
			results = append(results, e)
		case LoopComplete:
			complete = e
			sawComplete = true
		}
	}
	if tool.executions != 0 {
		t.Error("tool must not run after the request is aborted")
	}
	if len(results) != 1 || !results[0].IsError || results[0].Output != conversation.RejectedToolResult {
		t.Fatalf("results = %+v, want the plain rejection", results)
	}
	if !sawComplete || complete.StopReason != "interrupted" {
		t.Fatalf("complete = %+v (saw=%v), want interrupted", complete, sawComplete)
	}
}

// TestPermissionAllowAlwaysPersistsDisplayedScopes pins the reference
// allow-always path: the patterns captured before the wait are persisted, so
// an identical second call is auto-approved without another dialog.
func TestPermissionAllowAlwaysPersistsDisplayedScopes(t *testing.T) {
	tool := &writeMockTool{}
	client := &mockClient{}
	ag, path := newAskAgent(t, client, tool)
	client.responses = writeCallResponses(path, 2)

	conv := conversation.NewManager()
	conv.AddUserMessage("write it twice")
	asks := 0
	for ev := range ag.Run(context.Background(), conv) {
		if e, ok := ev.(PermissionRequestEvent); ok {
			asks++
			if len(e.Decision.RememberPatterns) == 0 {
				t.Fatal("request must carry the displayed remember patterns")
			}
			e.ResponseCh <- PermissionReply{Response: PermAllowAlways}
		}
	}
	if asks != 1 {
		t.Fatalf("asks = %d, want exactly 1 (the second call is remembered)", asks)
	}
	if tool.executions != 2 {
		t.Fatalf("executions = %d, want 2", tool.executions)
	}
}
