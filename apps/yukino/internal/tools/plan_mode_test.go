package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/plan_file"
)

type planningOwner struct {
	path   string
	active bool
}

func (o *planningOwner) CurrentPlanPath() string     { return o.path }
func (o *planningOwner) SetPlanFilePath(path string) { o.path = path }
func planningRuntime(owner *planningOwner, subagent, teammate bool) context.Context {
	return WithExecutionContext(context.Background(), ExecutionContext{Plan: &PlanContext{Owner: owner, IsPlanMode: func() bool { return owner.active }, EnterPlanMode: func() { owner.active = true }, IsSubagent: subagent, IsTeammate: teammate}})
}

type builtinPlanTool struct {
	mockNormalTool
	result ToolResult
	called bool
}

func (t *builtinPlanTool) RunBuiltin(ctx context.Context, name, prompt string) ToolResult {
	t.called = true
	return t.result
}
func TestEnterPlanModePersistsOnlySuccessfulPlan(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, output := range []string{"complete plan", "", "[No output]", "partial\n[Interrupted]"} {
		t.Run(output, func(t *testing.T) {
			owner := &planningOwner{}
			runner := &builtinPlanTool{mockNormalTool: mockNormalTool{name: "Agent"}, result: ToolResult{Output: output}}
			registry := NewRegistry()
			registry.Register(runner)
			result := (&EnterPlanModeTool{Registry: registry}).Execute(planningRuntime(owner, false, false), map[string]any{})
			if output == "complete plan" {
				saved, err := plan_file.LoadPlan(owner)
				if result.IsError || err != nil || saved != output || !owner.active {
					t.Fatal(result, saved, err)
				}
			} else if !result.IsError || plan_file.PlanExists(owner) {
				t.Fatal(result, "invalid plan saved")
			}
		})
	}
	owner := &planningOwner{}
	runner := &builtinPlanTool{mockNormalTool: mockNormalTool{name: "Agent"}}
	registry := NewRegistry()
	registry.Register(runner)
	result := (&EnterPlanModeTool{Registry: registry}).Execute(planningRuntime(owner, true, false), nil)
	if !result.IsError || runner.called || owner.active {
		t.Fatal("delegated plan entered", result)
	}
}
func TestExitPlanModeValidatesContentAndDelegation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	owner := &planningOwner{active: true}
	ctx := planningRuntime(owner, false, false)
	tool := &ExitPlanModeTool{}
	plan_file.SavePlan(owner, "  \n")
	if result := tool.Execute(ctx, nil); !result.IsError || result.Output != NoPlanFileError {
		t.Fatal(result)
	}
	plan_file.SavePlan(owner, "a real plan")
	if result := tool.Execute(planningRuntime(owner, true, false), nil); result.IsError || !strings.Contains(result.Output, "parent agent") || !owner.active {
		t.Fatal(result)
	}
	if result := tool.Execute(planningRuntime(owner, true, true), nil); !result.IsError || result.Output != NoPlanApprovalHandlerError {
		t.Fatal(result)
	}
	tool.SubmitTeammatePlan = func(content string) (string, error) {
		if content != "a real plan" {
			t.Fatal(content)
		}
		return "request-id", nil
	}
	if result := tool.Execute(planningRuntime(owner, true, true), nil); result.IsError || !strings.Contains(result.Output, "automatically approve") {
		t.Fatal(result)
	}
	owner.active = false
	if result := tool.Execute(ctx, nil); !result.IsError || result.Output != NotInPlanModeContinueError {
		t.Fatal(result)
	}
	if err := os.Remove(owner.path); err != nil {
		t.Fatal(err)
	}
	owner.path = filepath.Join(t.TempDir(), "missing.md")
	if result := tool.Execute(ctx, nil); !result.IsError || result.Output != NotInPlanModeError {
		t.Fatal(result)
	}
}
