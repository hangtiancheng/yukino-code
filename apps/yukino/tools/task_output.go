package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

type BackgroundTask struct {
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	Kind             string          `json:"kind,omitempty"`
	OriginToolCallID string          `json:"originToolCallId,omitempty"`
	Status           string          `json:"status"`
	Output           string          `json:"output"`
	Error            string          `json:"error,omitempty"`
	TranscriptPath   string          `json:"transcriptPath,omitempty"`
	StartedAt        int64           `json:"startedAt"`
	CompletedAt      int64           `json:"completedAt,omitempty"`
	Done             <-chan struct{} `json:"-"`
}
type TaskOptions struct{ TranscriptPath, OriginToolCallID, IDPrefix, Kind string }
type BackgroundTaskManager interface {
	Create(string, func(string) (string, error), func(), TaskOptions) (string, error)
	Get(string) *BackgroundTask
	Wait(context.Context, string, time.Duration) (*BackgroundTask, bool, error)
	StopAndWait(context.Context, string) (bool, error)
}
type TaskFailure struct{ Output string }

func (e *TaskFailure) Error() string { return e.Output }

func TaskManagerForContext(ctx context.Context, fallback BackgroundTaskManager) BackgroundTaskManager {
	execution, _ := ctx.Value(executionContextKey{}).(ExecutionContext)
	if execution.DisableBackground {
		return nil
	}
	if execution.TaskManager != nil {
		return execution.TaskManager
	}
	return fallback
}

type TaskOutputTool struct{ TaskManager BackgroundTaskManager }

func (t *TaskOutputTool) Name() string { return "TaskOutput" }
func (t *TaskOutputTool) Description() string {
	return "Inspect a background Agent/Bash/PowerShell task by its task_id, or wait once for at most timeout_ms (maximum 60000). This does not consume completion notifications or cancel timed-out tasks. Prefer automatic task notifications over repeated polling. TodoWrite item IDs belong to the separate TODO board and cannot be used here."
}
func (t *TaskOutputTool) Category() ToolCategory { return CategoryRead }
func (t *TaskOutputTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{"type": "object", "properties": map[string]any{
		"task_id": map[string]any{"type": "string"}, "wait": map[string]any{"type": "boolean", "default": false}, "timeout_ms": map[string]any{"type": "integer", "minimum": 0, "maximum": 60000, "default": 30000},
	}, "required": []string{"task_id"}, "additionalProperties": false}}
}
func (t *TaskOutputTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	id, _ := args["task_id"].(string)
	timeout := intArg(args, "timeout_ms", 30000)
	if id == "" || timeout < 0 || timeout > 60000 {
		return ToolResult{Output: "Error: task_id is required and timeout_ms must be between 0 and 60000", IsError: true}
	}
	for key := range args {
		if key != "task_id" && key != "wait" && key != "timeout_ms" {
			return ToolResult{Output: "Error: unknown parameter " + key, IsError: true}
		}
	}
	if _, ok := args["wait"]; ok {
		if _, ok := args["wait"].(bool); !ok {
			return ToolResult{Output: "Error: wait must be a boolean", IsError: true}
		}
	}
	if value, ok := args["timeout_ms"]; ok {
		switch n := value.(type) {
		case float64:
			if n != float64(timeout) {
				return ToolResult{Output: "Error: timeout_ms must be an integer", IsError: true}
			}
		case int, int64:
		default:
			return ToolResult{Output: "Error: timeout_ms must be an integer", IsError: true}
		}
	}
	if ctx.Err() != nil {
		return ToolResult{Output: "Error: " + ctx.Err().Error(), IsError: true}
	}
	manager := TaskManagerForContext(ctx, t.TaskManager)
	var task *BackgroundTask
	timedOut := false
	var err error
	if manager != nil {
		if wait, _ := args["wait"].(bool); wait {
			task, timedOut, err = manager.Wait(ctx, id, time.Duration(timeout)*time.Millisecond)
		} else {
			task = manager.Get(id)
		}
	}
	if err != nil {
		return ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	if task == nil {
		return ToolResult{Output: fmt.Sprintf("Error: background task '%s' not found in this agent's task registry", id), IsError: true}
	}
	kind := task.Kind
	if kind == "" {
		kind = "agent"
	}
	output := map[string]any{"task_id": task.ID, "name": task.Name, "kind": kind, "status": task.Status, "timed_out": timedOut, "output": task.Output, "started_at": task.StartedAt}
	if task.Error != "" {
		output["error"] = task.Error
	}
	if task.TranscriptPath != "" {
		output["transcript_path"] = task.TranscriptPath
	}
	if task.CompletedAt != 0 {
		output["completed_at"] = task.CompletedAt
	}
	data, err := json.MarshalIndent(output, "", "  ")
	if err != nil {
		return ToolResult{Output: err.Error(), IsError: true}
	}
	return ToolResult{Output: string(data)}
}
