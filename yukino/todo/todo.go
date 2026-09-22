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
	"strconv"
	"sync"
)

type TaskStatus string

const (
	StatusPending    TaskStatus = "pending"
	StatusInProgress TaskStatus = "in_progress"
	StatusCompleted  TaskStatus = "completed"
)

type Task struct {
	// Field order mirrors the TS Task JSON shape: created tasks serialize as
	// id, subject, description, status, activeForm, blocks, blockedBy,
	// metadata; `owner` is only added by updates, and JS object spread appends
	// it last — so Owner sits after Metadata to keep TaskGet's key order equal.
	ID          string         `json:"id"`
	Subject     string         `json:"subject"`
	Description string         `json:"description"`
	Status      TaskStatus     `json:"status"`
	ActiveForm  string         `json:"activeForm,omitempty"`
	Blocks      []string       `json:"blocks"`
	BlockedBy   []string       `json:"blockedBy"`
	Metadata    map[string]any `json:"metadata"`
	Owner       string         `json:"owner,omitempty"`
}

type TaskList struct {
	mu    sync.Mutex
	store *Store
	// nextID mirrors the TS TaskList's session-scoped counter: it is seeded
	// once from the store (max numeric id + 1) and then only ever increments,
	// so deleting the highest task does not recycle its id.
	nextID int
	seeded bool
}

func NewTaskList(store *Store) *TaskList {
	return &TaskList{store: store}
}

func (tl *TaskList) Create(subject, description, activeForm string, metadata map[string]any) (*Task, error) {
	tl.mu.Lock()
	defer tl.mu.Unlock()

	tasks, err := tl.store.Load()
	if err != nil {
		tasks = nil
	}
	if !tl.seeded {
		maxID := 0
		for _, t := range tasks {
			if n, err := strconv.Atoi(t.ID); err == nil && n > maxID {
				maxID = n
			}
		}
		tl.nextID = maxID + 1
		tl.seeded = true
	}

	task := &Task{
		ID:          strconv.Itoa(tl.nextID),
		Subject:     subject,
		Description: description,
		ActiveForm:  activeForm,
		Status:      StatusPending,
		Blocks:      []string{},
		BlockedBy:   []string{},
		// TS always persists `metadata: {}`; an absent map would serialize as
		// null and change the TaskGet JSON shape.
		Metadata: metadataOrEmpty(metadata),
	}
	tl.nextID++

	tasks = append(tasks, task)
	if err := tl.store.Save(tasks); err != nil {
		return nil, err
	}
	return task, nil
}

func (tl *TaskList) Get(id string) (*Task, error) {
	tl.mu.Lock()
	defer tl.mu.Unlock()

	tasks, err := tl.store.Load()
	if err != nil {
		return nil, err
	}
	for _, t := range tasks {
		if t.ID == id {
			return t, nil
		}
	}
	return nil, nil
}

func (tl *TaskList) List() ([]*Task, error) {
	tl.mu.Lock()
	defer tl.mu.Unlock()

	tasks, err := tl.store.Load()
	if err != nil {
		return nil, err
	}

	var visible []*Task
	for _, t := range tasks {
		if t.Metadata != nil {
			if _, internal := t.Metadata["_internal"]; internal {
				continue
			}
		}
		visible = append(visible, t)
	}
	return visible, nil
}

func (tl *TaskList) Update(id string, updates map[string]any) (*Task, []string, error) {
	tl.mu.Lock()
	defer tl.mu.Unlock()

	tasks, err := tl.store.Load()
	if err != nil {
		return nil, nil, err
	}

	var target *Task
	for _, t := range tasks {
		if t.ID == id {
			target = t
			break
		}
	}
	if target == nil {
		return nil, nil, nil
	}

	var changed []string

	if v, ok := updates["subject"]; ok {
		if s, ok := v.(string); ok && s != target.Subject {
			target.Subject = s
			changed = append(changed, "subject")
		}
	}
	if v, ok := updates["description"]; ok {
		if s, ok := v.(string); ok && s != target.Description {
			target.Description = s
			changed = append(changed, "description")
		}
	}
	if v, ok := updates["activeForm"]; ok {
		if s, ok := v.(string); ok && s != target.ActiveForm {
			target.ActiveForm = s
			changed = append(changed, "activeForm")
		}
	}
	if v, ok := updates["status"]; ok {
		if s, ok := v.(string); ok {
			newStatus := TaskStatus(s)
			if newStatus != target.Status {
				target.Status = newStatus
				changed = append(changed, "status")
			}
		}
	}
	if v, ok := updates["owner"]; ok {
		if s, ok := v.(string); ok && s != target.Owner {
			target.Owner = s
			changed = append(changed, "owner")
		}
	}
	if v, ok := updates["addBlocks"]; ok {
		if ids, ok := toStringSlice(v); ok && len(ids) > 0 {
			for _, b := range ids {
				if !containsString(target.Blocks, b) {
					target.Blocks = append(target.Blocks, b)
				}
				// Maintain the reverse link on the blocked task (TS addBlocks,
				// index.ts:119-134).
				if blocked := findTask(tasks, b); blocked != nil && !containsString(blocked.BlockedBy, id) {
					blocked.BlockedBy = append(blocked.BlockedBy, id)
				}
			}
			changed = append(changed, "blocks")
		}
	}
	if v, ok := updates["addBlockedBy"]; ok {
		if ids, ok := toStringSlice(v); ok && len(ids) > 0 {
			for _, b := range ids {
				if !containsString(target.BlockedBy, b) {
					target.BlockedBy = append(target.BlockedBy, b)
				}
				// Maintain the reverse link on the blocking task (TS
				// addBlockedBy, index.ts:136-151).
				if blocker := findTask(tasks, b); blocker != nil && !containsString(blocker.Blocks, id) {
					blocker.Blocks = append(blocker.Blocks, id)
				}
			}
			changed = append(changed, "blockedBy")
		}
	}
	if v, ok := updates["metadata"]; ok {
		if m, ok := v.(map[string]any); ok {
			if target.Metadata == nil {
				target.Metadata = make(map[string]any)
			}
			for k, val := range m {
				if val == nil {
					delete(target.Metadata, k)
				} else {
					target.Metadata[k] = val
				}
			}
			changed = append(changed, "metadata")
		}
	}

	// TS TaskList.update persists unconditionally (index.ts:107), even when
	// nothing changed.
	if err := tl.store.Save(tasks); err != nil {
		return nil, nil, err
	}

	return target, changed, nil
}

// Delete removes a task and persists the list (TS TaskList.delete,
// index.ts:111-117).
func (tl *TaskList) Delete(id string) (bool, error) {
	tl.mu.Lock()
	defer tl.mu.Unlock()

	tasks, err := tl.store.Load()
	if err != nil {
		return false, err
	}
	var remaining []*Task
	found := false
	for _, t := range tasks {
		if t.ID == id {
			found = true
			continue
		}
		remaining = append(remaining, t)
	}
	if !found {
		return false, nil
	}
	if err := tl.store.Save(remaining); err != nil {
		return false, err
	}
	return true, nil
}

// metadataOrEmpty mirrors the TS Task creation `metadata: {}`: an absent map
// becomes an empty one so TaskGet's JSON always carries the key.
func metadataOrEmpty(metadata map[string]any) map[string]any {
	if metadata == nil {
		return map[string]any{}
	}
	return metadata
}

// validUpdateStatus reports whether s is accepted by TaskUpdate, mirroring the
// TS zod enum ["pending", "in_progress", "completed", "deleted"]
// (tools.ts:276). "deleted" is tool-level only: it removes the task.
func validUpdateStatus(s string) bool {
	switch s {
	case string(StatusPending), string(StatusInProgress), string(StatusCompleted), "deleted":
		return true
	}
	return false
}

func findTask(tasks []*Task, id string) *Task {
	for _, t := range tasks {
		if t.ID == id {
			return t
		}
	}
	return nil
}

func containsString(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func toStringSlice(v any) ([]string, bool) {
	if ss, ok := v.([]string); ok {
		return ss, true
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, false
	}
	result := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result, true
}
