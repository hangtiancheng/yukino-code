// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package todo

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// TaskCreateTool creates a new task in the todo list.
type TaskCreateTool struct {
	List *TaskList
}

func (t *TaskCreateTool) Name() string { return "TaskCreate" }

// CategoryRead matches the TS tool's `category = "read"` (tools.ts:41).
func (t *TaskCreateTool) Category() tools.ToolCategory { return tools.CategoryRead }

func (t *TaskCreateTool) Description() string {
	return "Create a new task to track work."
}

func (t *TaskCreateTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"subject":     map[string]any{"type": "string", "description": "Brief task title"},
				"description": map[string]any{"type": "string", "description": "What needs to be done"},
				"activeForm": map[string]any{
					"type":        "string",
					"description": "Present continuous form for spinner",
				},
				// Go extension (TS Task carries metadata but the TS tool schema
				// does not expose it).
				"metadata": map[string]any{
					"type":        "object",
					"description": "Arbitrary metadata to attach to the task",
				},
			},
			"required": []string{"subject", "description"},
		},
	}
}

func (t *TaskCreateTool) Execute(_ context.Context, args map[string]any) tools.ToolResult {
	subject, _ := args["subject"].(string)
	// TS execute() only enforces subject; description rides through as-is
	// (tools.ts:72-81).
	if subject == "" {
		return tools.ToolResult{Output: "Error: subject is required", IsError: true}
	}
	description, _ := args["description"].(string)

	activeForm, _ := args["activeForm"].(string)
	metadata, _ := args["metadata"].(map[string]any)

	task, err := t.List.Create(subject, description, activeForm, metadata)
	if err != nil {
		return tools.ToolResult{Output: fmt.Sprintf("Error creating task: %s", err), IsError: true}
	}

	return tools.ToolResult{Output: fmt.Sprintf("Task #%s created successfully: %s", task.ID, task.Subject)}
}

// TaskGetTool retrieves a task by ID.
type TaskGetTool struct {
	List *TaskList
}

func (t *TaskGetTool) Name() string                 { return "TaskGet" }
func (t *TaskGetTool) Category() tools.ToolCategory { return tools.CategoryRead }

func (t *TaskGetTool) Description() string {
	return "Get a task by its ID."
}

func (t *TaskGetTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"taskId": map[string]any{"type": "string", "description": "Task ID"},
			},
			"required": []string{"taskId"},
		},
	}
}

func (t *TaskGetTool) Execute(_ context.Context, args map[string]any) tools.ToolResult {
	taskID, _ := args["taskId"].(string)

	task, err := t.List.Get(taskID)
	if err != nil {
		return tools.ToolResult{Output: fmt.Sprintf("Error: %s", err), IsError: true}
	}
	if task == nil {
		return tools.ToolResult{Output: "Task not found", IsError: true}
	}

	// TS returns the task as pretty-printed JSON (tools.ts:121-124).
	data, err := json.MarshalIndent(task, "", "  ")
	if err != nil {
		return tools.ToolResult{Output: fmt.Sprintf("Error: %s", err), IsError: true}
	}
	return tools.ToolResult{Output: string(data)}
}

// TaskListTool lists all tasks.
type TaskListTool struct {
	List *TaskList
}

func (t *TaskListTool) Name() string                 { return "TaskList" }
func (t *TaskListTool) Category() tools.ToolCategory { return tools.CategoryRead }

func (t *TaskListTool) Description() string {
	return "List all tasks."
}

func (t *TaskListTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}
}

func (t *TaskListTool) Execute(_ context.Context, _ map[string]any) tools.ToolResult {
	tasks, err := t.List.List()
	if err != nil {
		return tools.ToolResult{Output: fmt.Sprintf("Error: %s", err), IsError: true}
	}
	if len(tasks) == 0 {
		return tools.ToolResult{Output: "No tasks found"}
	}

	// TS renders `#id. [status] subject (owner)` and nothing else
	// (tools.ts:152-156); the dependency links stay in the data model.
	lines := make([]string, 0, len(tasks))
	for _, task := range tasks {
		line := fmt.Sprintf("#%s. [%s] %s", task.ID, task.Status, task.Subject)
		if task.Owner != "" {
			line += fmt.Sprintf(" (%s)", task.Owner)
		}
		lines = append(lines, line)
	}
	return tools.ToolResult{Output: strings.Join(lines, "\n")}
}

// TaskUpdateTool updates an existing task.
type TaskUpdateTool struct {
	List *TaskList
}

func (t *TaskUpdateTool) Name() string { return "TaskUpdate" }

// CategoryRead matches the TS tool's `category = "read"` (tools.ts:163).
func (t *TaskUpdateTool) Category() tools.ToolCategory { return tools.CategoryRead }

func (t *TaskUpdateTool) Description() string {
	return "Update a task's status, subject, or other fields."
}

func (t *TaskUpdateTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"taskId":  map[string]any{"type": "string", "description": "Task ID"},
				"subject": map[string]any{"type": "string", "description": "New subject"},
				// TS spells the status enum through zod validation at execute
				// time, not in the schema (tools.ts:179-182,276).
				"status": map[string]any{
					"type":        "string",
					"description": "New status: pending, in_progress, completed, deleted",
				},
				"description": map[string]any{"type": "string", "description": "New description"},
				"owner":       map[string]any{"type": "string", "description": "New owner"},
				"addBlocks": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Tasks this one blocks",
				},
				"addBlockedBy": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Tasks blocking this one",
				},
				// Go extension (documented): mergeable metadata with
				// null-deletes-key semantics.
				"metadata": map[string]any{
					"type":        "object",
					"description": "Metadata keys to merge. Set a key to null to delete it.",
				},
			},
			"required": []string{"taskId"},
		},
	}
}

func (t *TaskUpdateTool) Execute(_ context.Context, args map[string]any) tools.ToolResult {
	taskID, _ := args["taskId"].(string)
	if taskID == "" {
		return tools.ToolResult{Output: "Error: taskId is required", IsError: true}
	}

	// Reject invalid statuses up front, mirroring the TS zod enum parse
	// (tools.ts:206-212,276). The TS failure text is the serialized zod issue
	// list, which has no stable Go equivalent; the Go wording is a documented
	// migration difference.
	status, hasStatus := args["status"].(string)
	if hasStatus && !validUpdateStatus(status) {
		return tools.ToolResult{
			Output:  fmt.Sprintf("Error: invalid status %v: must be one of pending, in_progress, completed, deleted", args["status"]),
			IsError: true,
		}
	}

	// TS handles the delete before any update and unconditionally reports
	// success (tools.ts:231-237).
	if hasStatus && status == "deleted" {
		_, _ = t.List.Delete(taskID)
		return tools.ToolResult{Output: fmt.Sprintf("Task #%s deleted", taskID)}
	}

	// TS builds the updates object only from truthy fields (tools.ts:243-256);
	// empty strings are skipped, not applied.
	updates := map[string]any{}
	if hasStatus && status != "" {
		updates["status"] = status
	}
	if s, ok := args["subject"].(string); ok && s != "" {
		updates["subject"] = s
	}
	if s, ok := args["description"].(string); ok && s != "" {
		updates["description"] = s
	}
	if s, ok := args["owner"].(string); ok && s != "" {
		updates["owner"] = s
	}
	// TS validates both arrays with z.array(z.string()): a non-string element
	// fails the whole call (the Go wording stands in for the zod issue dump).
	for _, field := range []string{"addBlocks", "addBlockedBy"} {
		raw, present := args[field]
		if !present {
			continue
		}
		list, ok := raw.([]any)
		if !ok {
			return tools.ToolResult{
				Output:  fmt.Sprintf("Error: %s must be an array of strings", field),
				IsError: true,
			}
		}
		ids := make([]string, 0, len(list))
		for _, item := range list {
			s, ok := item.(string)
			if !ok {
				return tools.ToolResult{
					Output:  fmt.Sprintf("Error: %s must be an array of strings", field),
					IsError: true,
				}
			}
			ids = append(ids, s)
		}
		if len(ids) > 0 {
			updates[field] = raw
		}
	}
	// Go extension: metadata merge (null deletes a key).
	if m, ok := args["metadata"].(map[string]any); ok {
		updates["metadata"] = m
	}

	task, _, err := t.List.Update(taskID, updates)
	if err != nil {
		return tools.ToolResult{Output: fmt.Sprintf("Error: %s", err), IsError: true}
	}
	if task == nil {
		return tools.ToolResult{Output: "Task not found", IsError: true}
	}

	// TS always reports the same success line once the update call returns a
	// task, regardless of which fields actually changed (tools.ts:268).
	return tools.ToolResult{Output: fmt.Sprintf("Updated task #%s status", taskID)}
}
