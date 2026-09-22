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
	"strings"
	"testing"
)

func newTestList(t *testing.T) *TaskList {
	t.Helper()
	return NewTaskList(NewStore(t.TempDir(), "test-session"))
}

// The four tool descriptions must be byte-identical to the TS todo/tools.ts
// descriptions (model-visible contract).
func TestToolDescriptionsMatchTS(t *testing.T) {
	list := newTestList(t)
	if got, want := (&TaskCreateTool{List: list}).Description(), "Create a new task to track work."; got != want {
		t.Errorf("TaskCreate description = %q, want %q", got, want)
	}
	if got, want := (&TaskGetTool{List: list}).Description(), "Get a task by its ID."; got != want {
		t.Errorf("TaskGet description = %q, want %q", got, want)
	}
	if got, want := (&TaskListTool{List: list}).Description(), "List all tasks."; got != want {
		t.Errorf("TaskList description = %q, want %q", got, want)
	}
	if got, want := (&TaskUpdateTool{List: list}).Description(), "Update a task's status, subject, or other fields."; got != want {
		t.Errorf("TaskUpdate description = %q, want %q", got, want)
	}
}

// TS TaskCreateTool.execute only enforces subject (tools.ts:75-80); an
// omitted description rides through as an empty string.
func TestTaskCreateRequiresOnlySubject(t *testing.T) {
	list := newTestList(t)
	tool := &TaskCreateTool{List: list}

	res := tool.Execute(context.Background(), map[string]any{"description": "no subject"})
	if !res.IsError || res.Output != "Error: subject is required" {
		t.Fatalf("missing subject: %+v", res)
	}

	res = tool.Execute(context.Background(), map[string]any{"subject": "ship it"})
	if res.IsError {
		t.Fatalf("description is optional in TS: %+v", res)
	}
	if want := "Task #1 created successfully: ship it"; res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
}

// TaskGet renders the task as pretty JSON with the TS key order; owner (added
// by updates) serializes last, matching the JS object-spread append.
func TestTaskGetJSONShape(t *testing.T) {
	list := newTestList(t)
	created, err := list.Create("subject", "desc", "shipping", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, _, err := list.Update(created.ID, map[string]any{"owner": "alice"}); err != nil {
		t.Fatalf("update: %v", err)
	}

	res := (&TaskGetTool{List: list}).Execute(context.Background(), map[string]any{"taskId": created.ID})
	if res.IsError {
		t.Fatalf("TaskGet errored: %s", res.Output)
	}
	var order []string
	dec := json.NewDecoder(strings.NewReader(res.Output))
	tok, err := dec.Token() // opening {
	if err != nil || tok != json.Delim('{') {
		t.Fatalf("expected a JSON object, got %v (%v)", tok, err)
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			t.Fatalf("decode key: %v", err)
		}
		order = append(order, keyTok.(string))
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			t.Fatalf("decode value: %v", err)
		}
	}
	want := []string{"id", "subject", "description", "status", "activeForm", "blocks", "blockedBy", "metadata", "owner"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Errorf("key order = %v, want %v", order, want)
	}
}

// TaskList renders `#id. [status] subject (owner)` (TS tools.ts:152-156).
func TestTaskListLineFormat(t *testing.T) {
	list := newTestList(t)
	if _, err := list.Create("first", "d", "", nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := list.Create("second", "d", "", nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, _, err := list.Update("2", map[string]any{"owner": "bob", "status": "in_progress"}); err != nil {
		t.Fatalf("update: %v", err)
	}

	res := (&TaskListTool{List: list}).Execute(context.Background(), nil)
	want := "#1. [pending] first\n#2. [in_progress] second (bob)"
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
}

// TS TaskUpdateTool: "deleted" removes the task and reports success even when
// the id is unknown (tools.ts:231-237); empty-string fields are skipped, not
// applied (tools.ts:243-256).
func TestTaskUpdateSemantics(t *testing.T) {
	list := newTestList(t)
	tool := &TaskUpdateTool{List: list}

	res := tool.Execute(context.Background(), map[string]any{"taskId": "99", "status": "deleted"})
	if res.IsError || res.Output != "Task #99 deleted" {
		t.Fatalf("deleting an unknown task must still report success (TS): %+v", res)
	}

	created, _ := list.Create("keep", "desc", "", nil)
	res = tool.Execute(context.Background(), map[string]any{
		"taskId":  created.ID,
		"status":  "in_progress",
		"subject": "",
	})
	if res.IsError || res.Output != "Updated task #"+created.ID+" status" {
		t.Fatalf("update: %+v", res)
	}
	task, _ := list.Get(created.ID)
	if task.Subject != "keep" {
		t.Errorf("empty subject must be skipped (TS falsy guard), got %q", task.Subject)
	}
	if task.Status != StatusInProgress {
		t.Errorf("status = %q, want in_progress", task.Status)
	}

	res = tool.Execute(context.Background(), map[string]any{"taskId": created.ID, "status": "bogus"})
	if !res.IsError || !strings.Contains(res.Output, "invalid status") {
		t.Fatalf("invalid status must be rejected: %+v", res)
	}
}
