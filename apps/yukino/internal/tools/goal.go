package tools

import (
	"context"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/goal"
)

// GoalTool mirrors tools/goal.ts. The manager is resolved lazily so a session
// switch swaps the goal; delegated agents provide a nil resolver and receive the
// main-session-only error.
type GoalTool struct {
	Manager func() *goal.GoalManager
}

func (t *GoalTool) Name() string           { return "Goal" }
func (t *GoalTool) Description() string    { return GoalDescription }
func (t *GoalTool) Category() ToolCategory { return CategoryRead }

func (t *GoalTool) IsConcurrencySafe(map[string]any) bool { return false }

func (t *GoalTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{
					"type":        "string",
					"enum":        []string{"get", "update"},
					"description": GoalActionDescription,
				},
				"status": map[string]any{
					"type":        "string",
					"enum":        []string{"in_progress", "complete", "blocked"},
					"description": GoalStatusDescription,
				},
				"reason": map[string]any{
					"type":        "string",
					"description": GoalReasonDescription,
				},
			},
			"required":             []string{"action"},
			"additionalProperties": false,
		},
	}
}

type goalArgs struct {
	action string
	status string
	reason string
}

// parseGoalArgs mirrors the strict zod Args schema. It reports the invalid-status
// error with precedence over the generic invalid-args error, matching the
// reference's issue-path classification.
func parseGoalArgs(args map[string]any) (goalArgs, string) {
	var out goalArgs
	statusInvalid := false
	argsInvalid := false

	for k := range args {
		if k != "action" && k != "status" && k != "reason" {
			argsInvalid = true
		}
	}
	if a, ok := args["action"].(string); ok && (a == "get" || a == "update") {
		out.action = a
	} else {
		argsInvalid = true
	}
	if sv, present := args["status"]; present {
		if s, ok := sv.(string); ok && (s == "in_progress" || s == "complete" || s == "blocked") {
			out.status = s
		} else {
			statusInvalid = true
		}
	}
	if rv, present := args["reason"]; present {
		if s, ok := rv.(string); ok && strings.TrimSpace(s) != "" {
			out.reason = strings.TrimSpace(s)
		} else {
			argsInvalid = true
		}
	}

	if statusInvalid {
		return goalArgs{}, GoalInvalidStatusError
	}
	if argsInvalid {
		return goalArgs{}, GoalInvalidArgsError
	}
	return out, ""
}

func (t *GoalTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	if err := ctx.Err(); err != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	input, errMsg := parseGoalArgs(args)
	if errMsg != "" {
		return ToolResult{Output: "Error: " + errMsg, IsError: true}
	}
	if t.Manager == nil {
		return ToolResult{Output: "Error: " + GoalMainSessionOnly, IsError: true}
	}
	mgr := t.Manager()
	if mgr == nil {
		return ToolResult{Output: "Error: " + GoalMainSessionOnly, IsError: true}
	}
	if input.action == "get" {
		return ToolResult{Output: mgr.Format(), IsError: false}
	}
	if input.status == "" || input.reason == "" {
		return ToolResult{Output: "Error: " + GoalUpdateRequiresStatusReason, IsError: true}
	}
	out, err := mgr.Update(input.status, input.reason)
	if err != nil {
		return ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	return ToolResult{Output: out, IsError: false}
}
