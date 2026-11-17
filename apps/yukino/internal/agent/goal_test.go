package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func newGoalManager(t *testing.T, sid string) *goal.GoalManager {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	return goal.NewGoalManager(t.TempDir(), sid)
}

func convHasUserContaining(conv *conversation.Manager, needle string) bool {
	for _, m := range conv.GetMessages() {
		if m.Role == "user" && strings.Contains(m.ContentText(), needle) {
			return true
		}
	}
	return false
}

func TestGoalContinuationDrivesExtraTurn(t *testing.T) {
	gm := newGoalManager(t, "goal-cont")
	if err := gm.Set("objective", nil, false); err != nil {
		t.Fatalf("set failed: %v", err)
	}

	client := &dynamicMock{handlers: []func([]conversation.Message) []llm.StreamEvent{
		func([]conversation.Message) []llm.StreamEvent {
			return []llm.StreamEvent{llm.TextDelta{Text: "turn1"}, llm.StreamEnd{StopReason: "end_turn"}}
		},
		func([]conversation.Message) []llm.StreamEvent {
			_, _ = gm.Update("complete", "done")
			return []llm.StreamEvent{llm.TextDelta{Text: "turn2"}, llm.StreamEnd{StopReason: "end_turn"}}
		},
	}}

	ag := New(client, tools.NewRegistry(), "anthropic")
	ag.GoalManager = gm
	conv := conversation.NewManager()
	conv.AddUserMessage("start")
	events := collectEvents(ag.Run(context.Background(), conv))

	text := getStreamText(events)
	if !strings.Contains(text, "turn1") || !strings.Contains(text, "turn2") {
		t.Fatalf("expected both turns to run, got %q", text)
	}
	if !convHasUserContaining(conv, "Continue working toward the persistent goal: objective") {
		t.Fatalf("expected continuation prompt in conversation")
	}
	if gm.Get().Status != "complete" {
		t.Fatalf("expected complete status, got %s", gm.Get().Status)
	}
	if gm.Get().TurnsExecuted != 2 {
		t.Fatalf("expected 2 turns executed, got %d", gm.Get().TurnsExecuted)
	}
	// The run must terminate with a loop_complete.
	last := events[len(events)-1]
	if _, ok := last.(LoopComplete); !ok {
		t.Fatalf("expected final LoopComplete, got %T", last)
	}
}

func TestGoalContinuationSkippedWhenShouldContinueFalse(t *testing.T) {
	gm := newGoalManager(t, "goal-nocont")
	_ = gm.Set("objective", nil, false)

	client := &mockClient{responses: [][]llm.StreamEvent{{
		llm.TextDelta{Text: "only"}, llm.StreamEnd{StopReason: "end_turn"},
	}}}
	ag := New(client, tools.NewRegistry(), "anthropic")
	ag.GoalManager = gm
	ag.ShouldContinueGoal = func() bool { return false }
	conv := conversation.NewManager()
	conv.AddUserMessage("start")
	events := collectEvents(ag.Run(context.Background(), conv))

	if convHasUserContaining(conv, "Continue working toward the persistent goal") {
		t.Fatalf("continuation should be skipped when ShouldContinueGoal is false")
	}
	if gm.Get().TurnsExecuted != 1 {
		t.Fatalf("expected only the initial turn, got %d", gm.Get().TurnsExecuted)
	}
	if _, ok := events[len(events)-1].(LoopComplete); !ok {
		t.Fatalf("expected final LoopComplete")
	}
}

func TestGoalReminderInjected(t *testing.T) {
	gm := newGoalManager(t, "goal-rem")
	_ = gm.Set("objective", nil, false)

	client := &mockClient{responses: [][]llm.StreamEvent{{
		llm.TextDelta{Text: "ok"}, llm.StreamEnd{StopReason: "end_turn"},
	}}}
	ag := New(client, tools.NewRegistry(), "anthropic")
	ag.GoalManager = gm
	conv := conversation.NewManager()
	conv.AddUserMessage("start")
	collectEvents(ag.Run(context.Background(), conv))

	if !conv.HasReminderContaining(goal.PersistentGoalMarker) {
		t.Fatalf("expected persistent-goal reminder in conversation")
	}
}

func TestGoalBudgetLimitedSummaryFlow(t *testing.T) {
	gm := newGoalManager(t, "goal-budget")
	budget := float64(10)
	if err := gm.Set("objective", &budget, false); err != nil {
		t.Fatalf("set failed: %v", err)
	}

	client := &mockClient{responses: [][]llm.StreamEvent{
		{llm.TextDelta{Text: "working"}, llm.StreamEnd{StopReason: "end_turn", Usage: llm.UsageInfo{InputTokens: 100}}},
		{llm.TextDelta{Text: "summary"}, llm.StreamEnd{StopReason: "end_turn"}},
	}}
	ag := New(client, tools.NewRegistry(), "anthropic")
	ag.GoalManager = gm
	conv := conversation.NewManager()
	conv.AddUserMessage("start")
	events := collectEvents(ag.Run(context.Background(), conv))

	// Final event must be a budget_limited loop_complete.
	lc, ok := events[len(events)-1].(LoopComplete)
	if !ok {
		t.Fatalf("expected final LoopComplete, got %T", events[len(events)-1])
	}
	if lc.StopReason != "budget_limited" {
		t.Fatalf("expected budget_limited stop reason, got %q", lc.StopReason)
	}
	// The budget summary prompt must have been injected for the final turn.
	if !convHasUserContaining(conv, "<goal-budget-limit>") {
		t.Fatalf("expected budget-limit summary prompt in conversation")
	}
	// The closing status text is streamed before the loop_complete.
	if !strings.Contains(getStreamText(events), "Status: budget_limited") {
		t.Fatalf("expected budget_limited status in stream text, got %q", getStreamText(events))
	}
	if gm.Get().Status != "budget_limited" {
		t.Fatalf("expected budget_limited status, got %s", gm.Get().Status)
	}
}

func TestGoalEndRunClearsActiveSince(t *testing.T) {
	gm := newGoalManager(t, "goal-endrun")
	_ = gm.Set("objective", nil, false)
	client := &mockClient{responses: [][]llm.StreamEvent{{
		llm.TextDelta{Text: "ok"}, llm.StreamEnd{StopReason: "end_turn"},
	}}}
	ag := New(client, tools.NewRegistry(), "anthropic")
	ag.GoalManager = gm
	conv := conversation.NewManager()
	conv.AddUserMessage("start")
	collectEvents(ag.Run(context.Background(), conv))
	// After the run, EndRun must have stopped the active timer.
	if gm.Get() == nil {
		t.Fatalf("expected goal to persist")
	}
}
