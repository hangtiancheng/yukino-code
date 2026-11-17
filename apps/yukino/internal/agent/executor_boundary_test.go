package agent

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// concurrentWriteTool is concurrency-safe but requires approval (category
// write in default mode), letting the tests observe the reference's
// prepare-then-execute ordering for parallel batches.
type concurrentWriteTool struct {
	mu   *sync.Mutex
	log  *[]string
	name string
}

func (t *concurrentWriteTool) Name() string                 { return t.name }
func (t *concurrentWriteTool) Description() string          { return "concurrent write" }
func (t *concurrentWriteTool) Category() tools.ToolCategory { return tools.CategoryWrite }
func (t *concurrentWriteTool) Schema() map[string]any {
	return map[string]any{"name": t.name, "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}}
}
func (t *concurrentWriteTool) IsConcurrencySafe(map[string]any) bool { return true }
func (t *concurrentWriteTool) Execute(context.Context, map[string]any) tools.ToolResult {
	t.mu.Lock()
	*t.log = append(*t.log, "exec:"+t.name)
	t.mu.Unlock()
	return tools.ToolResult{Output: "done " + t.name}
}

// TestParallelBatchPreparesPermissionsBeforeExecution pins the reference
// executeBatch contract: in a parallel batch every call's hooks/permissions
// are prepared sequentially before any approved call executes.
func TestParallelBatchPreparesPermissionsBeforeExecution(t *testing.T) {
	var mu sync.Mutex
	var log []string
	reg := tools.NewRegistry()
	reg.Register(&concurrentWriteTool{mu: &mu, log: &log, name: "WriteA"})
	reg.Register(&concurrentWriteTool{mu: &mu, log: &log, name: "WriteB"})

	client := &mockClient{responses: [][]llm.StreamEvent{
		{
			llm.ToolCallStart{ToolName: "WriteA", ToolID: "a1"},
			llm.ToolCallComplete{ToolID: "a1", ToolName: "WriteA", Arguments: map[string]any{"file_path": "a.txt"}},
			llm.ToolCallStart{ToolName: "WriteB", ToolID: "b1"},
			llm.ToolCallComplete{ToolID: "b1", ToolName: "WriteB", Arguments: map[string]any{"file_path": "b.txt"}},
			llm.StreamEnd{StopReason: "tool_use"},
		},
		{
			llm.TextDelta{Text: "ok"},
			llm.StreamEnd{StopReason: "end_turn"},
		},
	}}
	dir := t.TempDir()
	ag := New(client, reg, "anthropic")
	ag.Checker = permissions.NewChecker(permissions.NewPathSandbox(dir, true), permissions.NewRuleEngine(dir), permissions.ModeDefault)

	conv := conversation.NewManager()
	conv.AddUserMessage("write both")
	for ev := range ag.Run(context.Background(), conv) {
		if e, ok := ev.(PermissionRequestEvent); ok {
			mu.Lock()
			log = append(log, "ask:"+e.ToolName)
			mu.Unlock()
			e.ResponseCh <- PermissionReply{Response: PermAllow}
		}
	}

	mu.Lock()
	defer mu.Unlock()
	askB, firstExec := -1, -1
	asks := 0
	for i, entry := range log {
		if strings.HasPrefix(entry, "ask:") {
			asks++
			if entry == "ask:WriteB" {
				askB = i
			}
		}
		if firstExec < 0 && strings.HasPrefix(entry, "exec:") {
			firstExec = i
		}
	}
	if asks != 2 || askB < 0 {
		t.Fatalf("expected both permission asks, got %v", log)
	}
	if firstExec < 0 {
		t.Fatalf("expected executions, got %v", log)
	}
	if firstExec < askB {
		t.Fatalf("execution started before every permission was prepared: %v", log)
	}
}

// TestExecutePreparedCallGuards pins the reference executeCall branches:
// parse error, pre-start cancellation (EXECUTION_CANCELLED_ERROR), and the
// unknown-tool error, all without running anything.
func TestExecutePreparedCallGuards(t *testing.T) {
	reg := tools.NewRegistry()
	ag := New(&mockClient{}, reg, "anthropic")
	tool := &concurrentWriteTool{mu: &sync.Mutex{}, log: new([]string), name: "WriteA"}
	prep := &toolPreparation{tool: tool, arguments: map[string]any{}}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := ag.executePreparedCall(ctx, toolCallInfo{toolID: "t1", toolName: "WriteA"}, prep, nil)
	if !r.isError || r.output != tools.ExecutionCancelledError || r.elapsed != 0 {
		t.Fatalf("cancelled = %#v", r)
	}

	r = ag.executePreparedCall(context.Background(), toolCallInfo{toolID: "t2", toolName: "WriteA", parseError: "bad json"}, prep, nil)
	if !r.isError || r.output != "Error: bad json. The tool was not executed." || r.elapsed != 0 {
		t.Fatalf("parse error = %#v", r)
	}

	r = ag.executePreparedCall(context.Background(), toolCallInfo{toolID: "t3", toolName: "Nope"}, nil, nil)
	if !r.isError || r.output != "Error: unknown tool 'Nope'" || r.elapsed != 0 {
		t.Fatalf("unknown tool = %#v", r)
	}
}

// TestPrepareUnknownToolUsesCommandCategory pins the reference behavior that
// unknown tools still run through hooks and permissions with the "command"
// category fallback (plan mode denies them as mutations) instead of
// short-circuiting before the decision layers.
func TestPrepareUnknownToolUsesCommandCategory(t *testing.T) {
	reg := tools.NewRegistry()
	ag := New(&mockClient{}, reg, "anthropic")
	dir := t.TempDir()
	ag.Checker = permissions.NewChecker(permissions.NewPathSandbox(dir, true), permissions.NewRuleEngine(dir), permissions.ModePlan)

	prep, immediate := ag.prepareToolCall(context.Background(), nil, toolCallInfo{toolID: "u1", toolName: "Mystery", arguments: map[string]any{}})
	if prep != nil || immediate == nil {
		t.Fatalf("prep = %v, immediate = %v", prep, immediate)
	}
	if !immediate.isError || !strings.Contains(immediate.output, "Plan mode forbids mutations") {
		t.Fatalf("immediate = %#v", immediate)
	}
}
