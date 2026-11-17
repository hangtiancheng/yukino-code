package todo

import (
	"context"
	"encoding/json"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type TodoWriteTool struct{ Board Board }

func (t *TodoWriteTool) Name() string                          { return "TodoWrite" }
func (t *TodoWriteTool) Description() string                   { return WriteDescription }
func (t *TodoWriteTool) Category() tools.ToolCategory          { return tools.CategoryRead }
func (t *TodoWriteTool) IsConcurrencySafe(map[string]any) bool { return true }
func (t *TodoWriteTool) ForList(list *TaskList) *TodoWriteTool { return &TodoWriteTool{Board: list} }
func (t *TodoWriteTool) Schema() map[string]any {
	id := func() map[string]any { return map[string]any{"type": "string", "pattern": `^[1-9]\d*$`} }
	ids := func() map[string]any { return map[string]any{"type": "array", "items": id()} }
	fields := map[string]any{
		"id": id(), "subject": map[string]any{"type": "string", "minLength": 1}, "description": map[string]any{"type": "string"}, "status": map[string]any{"type": "string", "enum": []string{"pending", "in_progress", "completed", "blocked", "cancelled"}}, "owner": map[string]any{"type": "string"}, "priority": map[string]any{"type": "string", "enum": []string{"high", "medium", "low"}}, "metadata": map[string]any{"type": "object", "propertyNames": map[string]any{"type": "string"}, "additionalProperties": map[string]any{}}, "blocks": ids(), "blockedBy": ids(),
	}
	descriptions := map[string]string{
		"id":          "Existing task ID: a positive decimal integer string. Omit to create a task.",
		"subject":     "Brief task title; required when creating a task.",
		"description": "What needs to be done; defaults to an empty string for new tasks.",
		"status":      "Task status; defaults to pending for new tasks. Use deleteIds to remove tasks.",
		"owner":       "Task owner. Only the leader may assign other teammates; an empty string unassigns.",
		"priority":    "Task priority, available during both creation and updates.",
		"metadata":    "Merge top-level context keys; null removes a key. Omitted keys are retained; nested values are replaced.",
		"blocks":      "Replace the list of existing task IDs this task blocks; [] removes these links.",
		"blockedBy":   "Replace the list of existing task IDs blocking this task; [] removes these links.",
	}
	for key, description := range descriptions {
		fields[key].(map[string]any)["description"] = description
	}
	deleteIDs := ids()
	deleteIDs["maxItems"] = MaxWriteItems
	deleteIDs["description"] = "Existing task IDs to delete atomically, removing their dependency links."
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{"type": "object", "properties": map[string]any{"todos": map[string]any{"type": "array", "maxItems": MaxWriteItems, "items": map[string]any{"type": "object", "properties": fields, "additionalProperties": false}}, "deleteIds": deleteIDs}, "additionalProperties": false}}
}
func (t *TodoWriteTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	if _, err := ParseWrite(args); err != nil {
		return tools.ToolResult{Output: err.Error(), IsError: true}
	}
	if ctx.Err() != nil {
		return tools.ToolResult{Output: "Error: " + ctx.Err().Error(), IsError: true}
	}
	todos, err := t.Board.Write(args)
	if err != nil {
		return tools.ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	output, err := json.MarshalIndent(map[string]any{"boardId": t.Board.BoardID(), "todos": todos, "progress": Progress(todos)}, "", "  ")
	if err != nil {
		return tools.ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	return tools.ToolResult{Output: string(output)}
}
func (t *TodoWriteTool) ForSubagent() tools.Tool { list, _ := NewTaskList(nil); return t.ForList(list) }
