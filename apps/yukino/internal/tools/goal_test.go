package tools

import (
	"context"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/goal"
)

func newGoalManager(t *testing.T) *goal.GoalManager {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	return goal.NewGoalManager(t.TempDir(), "goal-tool-test")
}

func TestGoalToolNoManager(t *testing.T) {
	tool := &GoalTool{}
	res := tool.Execute(context.Background(), map[string]any{"action": "get"})
	if !res.IsError || res.Output != "Error: "+GoalMainSessionOnly {
		t.Fatalf("expected main-session-only error, got %+v", res)
	}
}

func TestGoalToolNilManagerResolver(t *testing.T) {
	tool := &GoalTool{Manager: func() *goal.GoalManager { return nil }}
	res := tool.Execute(context.Background(), map[string]any{"action": "get"})
	if !res.IsError || res.Output != "Error: "+GoalMainSessionOnly {
		t.Fatalf("expected main-session-only error, got %+v", res)
	}
}

func TestGoalToolGet(t *testing.T) {
	m := newGoalManager(t)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"action": "get"})
	if res.IsError || res.Output != goal.NoGoalMessage {
		t.Fatalf("expected no-goal message, got %+v", res)
	}
	_ = m.Set("obj", nil, false)
	res = tool.Execute(context.Background(), map[string]any{"action": "get"})
	if res.IsError || !strings.Contains(res.Output, "Goal: obj") {
		t.Fatalf("expected goal status, got %+v", res)
	}
}

func TestGoalToolUpdate(t *testing.T) {
	m := newGoalManager(t)
	_ = m.Set("obj", nil, false)
	m.BeginTurn()
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"action": "update", "status": "in_progress", "reason": "progress"})
	if res.IsError || !strings.HasPrefix(res.Output, "Goal: obj") {
		t.Fatalf("expected status output, got %+v", res)
	}
}

func TestGoalToolUpdateMissingStatusReason(t *testing.T) {
	m := newGoalManager(t)
	_ = m.Set("obj", nil, false)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"action": "update"})
	if !res.IsError || res.Output != "Error: "+GoalUpdateRequiresStatusReason {
		t.Fatalf("expected requires-status-reason error, got %+v", res)
	}
}

func TestGoalToolInvalidAction(t *testing.T) {
	m := newGoalManager(t)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"action": "frob"})
	if !res.IsError || res.Output != "Error: "+GoalInvalidArgsError {
		t.Fatalf("expected invalid-args error, got %+v", res)
	}
}

func TestGoalToolMissingAction(t *testing.T) {
	m := newGoalManager(t)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"status": "complete"})
	if !res.IsError || res.Output != "Error: "+GoalInvalidArgsError {
		t.Fatalf("expected invalid-args error, got %+v", res)
	}
}

func TestGoalToolInvalidStatus(t *testing.T) {
	m := newGoalManager(t)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"action": "update", "status": "done", "reason": "x"})
	if !res.IsError || res.Output != "Error: "+GoalInvalidStatusError {
		t.Fatalf("expected invalid-status error, got %+v", res)
	}
}

func TestGoalToolStatusPrecedenceOverArgs(t *testing.T) {
	m := newGoalManager(t)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	// Both an unknown key (args error) and a bad status (status error): status wins.
	res := tool.Execute(context.Background(), map[string]any{"action": "update", "status": "nope", "extra": 1})
	if !res.IsError || res.Output != "Error: "+GoalInvalidStatusError {
		t.Fatalf("expected invalid-status precedence, got %+v", res)
	}
}

func TestGoalToolUnknownKey(t *testing.T) {
	m := newGoalManager(t)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"action": "get", "extra": true})
	if !res.IsError || res.Output != "Error: "+GoalInvalidArgsError {
		t.Fatalf("expected invalid-args for unknown key, got %+v", res)
	}
}

func TestGoalToolEmptyReason(t *testing.T) {
	m := newGoalManager(t)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"action": "update", "status": "blocked", "reason": "   "})
	if !res.IsError || res.Output != "Error: "+GoalInvalidArgsError {
		t.Fatalf("expected invalid-args for blank reason, got %+v", res)
	}
}

func TestGoalToolNullStatusInvalid(t *testing.T) {
	m := newGoalManager(t)
	tool := &GoalTool{Manager: func() *goal.GoalManager { return m }}
	res := tool.Execute(context.Background(), map[string]any{"action": "update", "status": nil, "reason": "x"})
	if !res.IsError || res.Output != "Error: "+GoalInvalidStatusError {
		t.Fatalf("expected invalid-status for null status, got %+v", res)
	}
}

func TestGoalToolSchema(t *testing.T) {
	tool := &GoalTool{}
	schema := tool.Schema()
	if schema["name"] != "Goal" {
		t.Fatalf("unexpected name: %v", schema["name"])
	}
	in, ok := schema["input_schema"].(map[string]any)
	if !ok {
		t.Fatalf("missing input_schema")
	}
	props, ok := in["properties"].(map[string]any)
	if !ok {
		t.Fatalf("missing properties")
	}
	for _, key := range []string{"action", "status", "reason"} {
		if _, ok := props[key]; !ok {
			t.Fatalf("missing property %q", key)
		}
	}
	if in["additionalProperties"] != false {
		t.Fatalf("expected additionalProperties false")
	}
}

func TestGoalToolNotConcurrencySafe(t *testing.T) {
	tool := &GoalTool{}
	if tool.IsConcurrencySafe(nil) {
		t.Fatalf("GoalTool must not be concurrency safe")
	}
}
