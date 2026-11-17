package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type deferredMockTool struct{ name string }

func (t *deferredMockTool) Name() string                 { return t.name }
func (t *deferredMockTool) Description() string          { return "deferred mock" }
func (t *deferredMockTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (t *deferredMockTool) ShouldDefer() bool            { return true }
func (t *deferredMockTool) Schema() map[string]any {
	return map[string]any{"name": t.name, "input_schema": map[string]any{"type": "object"}}
}
func (t *deferredMockTool) Execute(context.Context, map[string]any) tools.ToolResult {
	return tools.ToolResult{Output: "ok"}
}

func countDeferredReminders(conv *conversation.Manager) int {
	n := 0
	for _, m := range conv.GetMessages() {
		if m.Role == "user" && strings.Contains(m.Content, prompt.DeferredGuidanceMarker) {
			n++
		}
	}
	return n
}

func TestDeferredReminderNotRepeatedAcrossIterations(t *testing.T) {
	toolTurn := func(id string) []llm.StreamEvent {
		return []llm.StreamEvent{
			llm.ToolCallStart{ToolName: "Glob", ToolID: id},
			llm.ToolCallComplete{ToolID: id, ToolName: "Glob", Arguments: map[string]any{"pattern": "*"}},
			llm.StreamEnd{StopReason: "tool_use"},
		}
	}
	client := &mockClient{responses: [][]llm.StreamEvent{
		toolTurn("t1"), toolTurn("t2"), toolTurn("t3"),
		{llm.TextDelta{Text: "done"}, llm.StreamEnd{StopReason: "end_turn"}},
	}}

	reg := tools.NewRegistry()
	reg.ExposeToolSearch = true
	reg.Register(&tools.ToolSearchTool{Registry: reg})
	reg.Register(&mockTool{name: "Glob", result: "ok"})
	reg.Register(&deferredMockTool{name: "mcp__linear__create_issue"})
	reg.Register(&deferredMockTool{name: "mcp__sentry__resolve_issue"})

	ag := New(client, reg, "anthropic")
	conv := conversation.NewManager()
	runConversationRound(ag, conv, "do three things")

	if client.callIdx != 4 {
		t.Fatalf("main loop should run 4 times, got %d", client.callIdx)
	}
	if got := countDeferredReminders(conv); got != 1 {
		t.Errorf("the reminder should be injected once across four turns, got %d", got)
	}
}

func TestDeferredReminderReannouncedWhenPoolChanges(t *testing.T) {
	client := &mockClient{responses: [][]llm.StreamEvent{
		{llm.TextDelta{Text: "one"}, llm.StreamEnd{StopReason: "end_turn"}},
		{llm.TextDelta{Text: "two"}, llm.StreamEnd{StopReason: "end_turn"}},
	}}
	reg := tools.NewRegistry()
	reg.ExposeToolSearch = true
	reg.Register(&tools.ToolSearchTool{Registry: reg})
	reg.Register(&deferredMockTool{name: "mcp__linear__create_issue"})

	ag := New(client, reg, "anthropic")
	conv := conversation.NewManager()

	runConversationRound(ag, conv, "first round")
	if got := countDeferredReminders(conv); got != 1 {
		t.Fatalf("first round should inject once, got %d", got)
	}

	reg.Register(&deferredMockTool{name: "mcp__infra__scale_service"})
	runConversationRound(ag, conv, "second round")
	if got := countDeferredReminders(conv); got != 2 {
		t.Errorf("pool change should trigger one more injection, total %d", got)
	}
}

func TestDeferredReminderReannouncedAfterHistoryWiped(t *testing.T) {
	client := &mockClient{responses: [][]llm.StreamEvent{
		{llm.TextDelta{Text: "one"}, llm.StreamEnd{StopReason: "end_turn"}},
		{llm.TextDelta{Text: "two"}, llm.StreamEnd{StopReason: "end_turn"}},
	}}
	reg := tools.NewRegistry()
	reg.ExposeToolSearch = true
	reg.Register(&tools.ToolSearchTool{Registry: reg})
	reg.Register(&deferredMockTool{name: "mcp__linear__create_issue"})

	ag := New(client, reg, "anthropic")
	conv := conversation.NewManager()

	runConversationRound(ag, conv, "first round")
	if got := countDeferredReminders(conv); got != 1 {
		t.Fatalf("first round should inject once, got %d", got)
	}

	conv.TruncateTo(0)
	conv.AddUserMessage("summary of earlier conversation")

	runConversationRound(ag, conv, "second round")
	if got := countDeferredReminders(conv); got != 1 {
		t.Errorf("after history compaction the reminder should be re-announced once, got %d", got)
	}
}

func TestDeferredToolNamesSorted(t *testing.T) {
	reg := tools.NewRegistry()
	reg.ExposeToolSearch = true
	reg.Register(&tools.ToolSearchTool{Registry: reg})
	for _, n := range []string{"mcp__z__b", "mcp__a__c", "mcp__m__a"} {
		reg.Register(&deferredMockTool{name: n})
	}
	first := reg.GetDeferredToolNames()
	want := []string{"mcp__a__c", "mcp__m__a", "mcp__z__b"}
	if strings.Join(first, ",") != strings.Join(want, ",") {
		t.Fatalf("expected lexicographic order, got %v", first)
	}
	for i := 0; i < 20; i++ {
		if strings.Join(reg.GetDeferredToolNames(), ",") != strings.Join(want, ",") {
			t.Fatalf("call %d changed the order", i)
		}
	}
}

func TestNoDeferredReminderWithoutDeferredTools(t *testing.T) {
	client := &mockClient{responses: [][]llm.StreamEvent{
		{llm.TextDelta{Text: "hi"}, llm.StreamEnd{StopReason: "end_turn"}},
	}}
	ag := New(client, tools.NewRegistry(), "anthropic")
	conv := conversation.NewManager()
	runConversationRound(ag, conv, "hi")
	if got := countDeferredReminders(conv); got != 0 {
		t.Errorf("no injection without deferred tools, got %d", got)
	}
}
