package workflow

import (
	"context"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// WorkflowTool exposes the Workflow service to the model, mirroring
// WorkflowTool.
type WorkflowTool struct {
	Service *WorkflowService
}

var _ tools.Tool = (*WorkflowTool)(nil)

func (t *WorkflowTool) Name() string { return WorkflowToolName }

func (t *WorkflowTool) Description() string { return WorkflowToolPrompt }

func (t *WorkflowTool) Category() tools.ToolCategory { return tools.CategoryCommand }

func (t *WorkflowTool) Dispose() error { return t.Service.Shutdown() }

func (t *WorkflowTool) IsConcurrencySafe(args map[string]any) bool { return true }

func (t *WorkflowTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"script": map[string]any{
					"type":        "string",
					"minLength":   1,
					"description": "Self-contained plain JavaScript workflow source.",
				},
				"name": map[string]any{
					"type":        "string",
					"minLength":   1,
					"description": "Named workflow in .yukino/workflows/<name>.js|mjs|ts.",
				},
				"scriptPath": map[string]any{
					"type":        "string",
					"minLength":   1,
					"description": "Path to a workflow script file.",
				},
				"args": map[string]any{
					"description": "Actual JSON input passed to the script, never stringified JSON.",
				},
				"resumeFromRunId": map[string]any{
					"type":        "string",
					"pattern":     RunIDRe.String(),
					"description": "Resume a prior run using its saved script, arguments and journal; source and arguments may be overridden.",
				},
				"description": map[string]any{
					"type":        "string",
					"description": "Short description of this invocation.",
				},
				"title": map[string]any{
					"type":        "string",
					"description": "Progress viewer title.",
				},
				"maxConcurrency": map[string]any{
					"type":        "number",
					"minimum":     1,
					"maximum":     MaxConcurrencyCap,
					"description": "Concurrent agents, default 3, maximum 16. Honor the user's requested concurrency.",
				},
			},
		},
	}
}

func (t *WorkflowTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	launch, err := t.Service.Launch(args, ctx)
	if err != nil {
		return tools.ToolResult{Output: ErrorString(err), IsError: true}
	}
	return tools.ToolResult{Output: FormatWorkflowLaunch(launch)}
}
