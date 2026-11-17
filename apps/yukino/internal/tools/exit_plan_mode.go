package tools

import (
	"context"
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/plan_file"
)

type ExitPlanModeTool struct {
	SubmitTeammatePlan     func(string) (string, error)
	RequiresLeaderApproval bool
}

func (t *ExitPlanModeTool) Name() string           { return "ExitPlanMode" }
func (t *ExitPlanModeTool) Description() string    { return ExitPlanModeDescription }
func (t *ExitPlanModeTool) Category() ToolCategory { return CategoryRead }
func (t *ExitPlanModeTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}}
}
func (t *ExitPlanModeTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	plan := PlanningContext(ctx)
	if plan == nil || plan.IsPlanMode == nil || !plan.IsPlanMode() {
		if plan != nil && plan.Owner != nil && plan_file.PlanExists(plan.Owner) {
			return ToolResult{Output: NotInPlanModeContinueError, IsError: true}
		}
		return ToolResult{Output: NotInPlanModeError, IsError: true}
	}
	content, err := plan_file.LoadPlan(plan.Owner)
	if err != nil {
		return ToolResult{Output: err.Error(), IsError: true}
	}
	if !plan_file.PlanExists(plan.Owner) || strings.TrimSpace(content) == "" {
		return ToolResult{Output: NoPlanFileError, IsError: true}
	}
	if plan.IsTeammate {
		if t.SubmitTeammatePlan == nil {
			return ToolResult{Output: NoPlanApprovalHandlerError, IsError: true}
		}
		id, err := t.SubmitTeammatePlan(content)
		if err != nil {
			return ToolResult{Output: err.Error(), IsError: true}
		}
		policy := "The host will automatically approve the plan and resume execution under current tool permissions."
		if t.RequiresLeaderApproval {
			policy = "Stay in plan mode until the leader reviews it and responds. The host will resume you with approval or revision feedback."
		}
		return ToolResult{Output: fmt.Sprintf("Plan submitted. Request ID: %s. %s End this turn now.", id, policy)}
	}
	if plan.IsSubagent {
		return ToolResult{Output: "Plan ready for the parent agent:\n\n" + content + "\n\nEnd this turn now. This subagent remains read-only; the parent decides how to proceed."}
	}
	return ToolResult{Output: "Plan mode will be exited after this turn. The user will be shown the plan approval dialog. Do not call any more tools — end your turn now."}
}
