package tools

import (
	"context"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/plan_file"
)

type EnterPlanModeTool struct{ Registry *Registry }

func (t *EnterPlanModeTool) Name() string                          { return "EnterPlanMode" }
func (t *EnterPlanModeTool) Description() string                   { return EnterPlanModeDescription }
func (t *EnterPlanModeTool) Category() ToolCategory                { return CategoryRead }
func (t *EnterPlanModeTool) IsConcurrencySafe(map[string]any) bool { return false }
func (t *EnterPlanModeTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "strict": true, "input_schema": map[string]any{"type": "object", "properties": map[string]any{}, "required": []string{}, "additionalProperties": false}}
}
func (t *EnterPlanModeTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	return RunPlanAgent(t.Registry, ctx, "Use the inherited conversation to investigate the user's current task and return a concrete implementation plan with relevant files, constraints, verification steps, and unresolved questions. Do not modify files. Return the complete plan directly; the parent host will save it and request user approval.")
}
func RunPlanAgent(registry *Registry, ctx context.Context, prompt string) ToolResult {
	planning := PlanningContext(ctx)
	if planning == nil || planning.Owner == nil {
		return ToolResult{Output: PlanModeUnavailableError, IsError: true}
	}
	if planning.IsSubagent || planning.IsTeammate {
		return ToolResult{Output: PlanModeDelegatedError, IsError: true}
	}
	runner, ok := registry.Get("Agent").(interface {
		RunBuiltin(context.Context, string, string) ToolResult
	})
	if !ok {
		return ToolResult{Output: "The built-in plan agent is unavailable.", IsError: true}
	}
	if err := ctx.Err(); err != nil {
		return ToolResult{Output: err.Error(), IsError: true}
	}
	planning.EnterPlanMode()
	result := runner.RunBuiltin(ctx, "plan", prompt)
	if result.IsError {
		return result
	}
	if ctx.Err() != nil || strings.Contains(result.Output, "[Interrupted]") {
		result.IsError = true
		return result
	}
	if strings.TrimSpace(result.Output) == "" || result.Output == "[No output]" {
		return ToolResult{Output: "The plan agent returned no plan.", IsError: true}
	}
	if err := plan_file.SavePlan(planning.Owner, result.Output); err != nil {
		return ToolResult{Output: err.Error(), IsError: true}
	}
	return result
}
