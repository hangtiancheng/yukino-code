package commands

import (
	"context"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type fakeAgentTool struct {
	result  tools.ToolResult
	gotArgs map[string]any
	gotID   string
}

func (f *fakeAgentTool) Name() string                          { return "Agent" }
func (f *fakeAgentTool) Description() string                   { return "fake agent" }
func (f *fakeAgentTool) Category() tools.ToolCategory          { return tools.CategoryCommand }
func (f *fakeAgentTool) Schema() map[string]any                { return map[string]any{"name": "Agent"} }
func (f *fakeAgentTool) IsConcurrencySafe(map[string]any) bool { return false }

func (f *fakeAgentTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	f.gotArgs = args
	if execution, ok := tools.RuntimeContext(ctx); ok {
		f.gotID = execution.ToolCallID
	}
	return f.result
}

func drainEvents(events <-chan agent.AgentEvent) []agent.AgentEvent {
	var got []agent.AgentEvent
	for event := range events {
		got = append(got, event)
	}
	return got
}

// TestRunSubagentCommandEventSequence pins the reference runSubagentCommand
// contract: the recorded user/assistant messages and the
// tool_use → tool_result → stream_text → turn_complete → loop_complete event
// sequence with the reference's args, elapsed time, content blocks, and
// stopReason mapping.
func TestRunSubagentCommandEventSequence(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	wd := t.TempDir()
	sessionID := session.NewID()
	registry := tools.NewRegistry()
	blocks := []map[string]any{{"type": "text", "text": "agent says hi"}}
	fake := &fakeAgentTool{result: tools.ToolResult{Output: "agent says hi", ContentBlocks: blocks}}
	registry.Register(fake)
	conv := conversation.NewManager()

	events := drainEvents(RunSubagentCommand(context.Background(), "general-purpose", "do the thing", "/agent do the thing", registry, nil, conv, wd, sessionID, nil))
	if len(events) != 5 {
		t.Fatalf("got %d events: %#v", len(events), events)
	}
	use, ok := events[0].(agent.ToolUseEvent)
	if !ok || use.ToolName != "Agent" || use.ToolID == "" {
		t.Fatalf("event 0 = %#v", events[0])
	}
	for key, want := range map[string]any{
		"kind": "subagent", "subagent_type": "general-purpose", "fork": false,
		"description": "/agent do the thing", "prompt": "do the thing", "run_in_background": false,
	} {
		if use.Args[key] != want {
			t.Fatalf("args[%s] = %#v, want %#v", key, use.Args[key], want)
		}
	}
	result, ok := events[1].(agent.ToolResultEvent)
	if !ok || result.ToolID != use.ToolID || result.ToolName != "Agent" {
		t.Fatalf("event 1 = %#v", events[1])
	}
	if result.Output != "agent says hi" || result.IsError {
		t.Fatalf("result = %#v", result)
	}
	if len(result.ContentBlocks) != 1 || result.ContentBlocks[0]["text"] != "agent says hi" {
		t.Fatalf("content blocks not propagated: %#v", result.ContentBlocks)
	}
	if stream, ok := events[2].(agent.StreamText); !ok || stream.Text != "agent says hi" {
		t.Fatalf("event 2 = %#v", events[2])
	}
	if _, ok := events[3].(agent.TurnComplete); !ok {
		t.Fatalf("event 3 = %#v", events[3])
	}
	loop, ok := events[4].(agent.LoopComplete)
	if !ok || loop.StopReason != "end_turn" || loop.PlanReady {
		t.Fatalf("event 4 = %#v", events[4])
	}
	if fake.gotID != use.ToolID {
		t.Fatalf("tool context id = %q, want %q", fake.gotID, use.ToolID)
	}
	if conv.Len() != 2 {
		t.Fatalf("conversation len = %d, want the user + assistant records", conv.Len())
	}
	saved, err := session.LoadSession(wd, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 2 || saved[0].Role != "user" || saved[0].Content != "/agent do the thing" || saved[1].Role != "assistant" || saved[1].Content != "agent says hi" {
		t.Fatalf("saved = %#v", saved)
	}
}

// TestRunSubagentCommandErrorStopReason pins the reference stopReason mapping:
// a failed result completes the loop with "error".
func TestRunSubagentCommandErrorStopReason(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	wd := t.TempDir()
	registry := tools.NewRegistry()
	registry.Register(&fakeAgentTool{result: tools.ToolResult{Output: "boom", IsError: true}})
	events := drainEvents(RunSubagentCommand(context.Background(), "general-purpose", "prompt", "/agent prompt", registry, nil, conversation.NewManager(), wd, session.NewID(), nil))
	loop, ok := events[len(events)-1].(agent.LoopComplete)
	if !ok || loop.StopReason != "error" || loop.PlanReady {
		t.Fatalf("last event = %#v", events[len(events)-1])
	}
}

// TestRunSubagentCommandUnavailable pins the SUBAGENT_COMMAND_UNAVAILABLE
// error when the registry has no Agent tool.
func TestRunSubagentCommandUnavailable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	events := drainEvents(RunSubagentCommand(context.Background(), "general-purpose", "prompt", "/agent prompt", tools.NewRegistry(), nil, conversation.NewManager(), t.TempDir(), session.NewID(), nil))
	if len(events) != 1 {
		t.Fatalf("events = %#v", events)
	}
	if failure, ok := events[0].(agent.ErrorEvent); !ok || failure.Message != SubagentCommandUnavailable {
		t.Fatalf("event = %#v", events[0])
	}
}
