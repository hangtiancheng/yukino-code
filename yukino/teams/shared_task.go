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

package teams

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
)

// SharedTask is a single task on the team shared task board, with dependency
// relations (Blocks / BlockedBy) and ownership (Assignee).
type SharedTask struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Status      string   `json:"status"` // pending | in_progress | completed | blocked
	Assignee    string   `json:"assignee"`
	Blocks      []string `json:"blocks"`
	BlockedBy   []string `json:"blocked_by"`
	CreatedBy   string   `json:"created_by"`
}

// storeData is the overall structure of tasks.json: the next available ID plus
// the task list.
type storeData struct {
	NextID int          `json:"next_id"`
	Tasks  []SharedTask `json:"tasks"`
}

// SharedTaskStore persists to a JSON file (tasks.json) for all members of the
// same team to read and write. The file is reloaded before every read so that
// teammates in other processes always see the latest data.
type SharedTaskStore struct {
	mu     sync.Mutex
	path   string
	nextID int
	tasks  []SharedTask
}

// NewSharedTaskStore opens (or initializes) the shared task store at the given
// path.
func NewSharedTaskStore(path string) *SharedTaskStore {
	s := &SharedTaskStore{path: path, nextID: 1}
	s.load()
	return s
}

// load re-reads the task list from disk; it stays empty if the file does not
// exist. TS applies the StoreDataSchema/SerializedTaskSchema defaults (missing
// description/status/assignee/blocks/blocked_by/created_by and a missing
// next_id fall back to their defaults) and drops the entire document when a
// required field is missing or has the wrong type, keeping the in-memory state
// intact. The caller must hold the lock.
func (s *SharedTaskStore) load() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		return
	}
	tasks, nextID, ok := parseStoreData(doc)
	if !ok {
		return
	}
	s.tasks = tasks
	s.nextID = nextID
}

// parseStoreData validates the on-disk document and materializes the zod
// defaults. ok=false means the document failed the schema (keep current state).
func parseStoreData(doc map[string]any) ([]SharedTask, int, bool) {
	nextID := 1 // next_id default
	if v, present := doc["next_id"]; present {
		f, isNum := v.(float64)
		if !isNum || f != math.Trunc(f) || f <= 0 {
			return nil, 0, false
		}
		nextID = int(f)
	}
	rawTasks := []any{}
	if v, present := doc["tasks"]; present {
		list, isList := v.([]any)
		if !isList {
			return nil, 0, false
		}
		rawTasks = list
	}
	tasks := make([]SharedTask, 0, len(rawTasks))
	for _, entry := range rawTasks {
		m, isMap := entry.(map[string]any)
		if !isMap {
			return nil, 0, false
		}
		id, isStr := m["id"].(string)
		if !isStr {
			return nil, 0, false
		}
		title, isStr := m["title"].(string)
		if !isStr {
			return nil, 0, false
		}
		description, ok := defaultedString(m, "description", "")
		if !ok {
			return nil, 0, false
		}
		status, ok := defaultedString(m, "status", "pending")
		if !ok {
			return nil, 0, false
		}
		assignee, ok := defaultedString(m, "assignee", "")
		if !ok {
			return nil, 0, false
		}
		blocks, ok := defaultedStringList(m, "blocks")
		if !ok {
			return nil, 0, false
		}
		blockedBy, ok := defaultedStringList(m, "blocked_by")
		if !ok {
			return nil, 0, false
		}
		createdBy, ok := defaultedString(m, "created_by", "")
		if !ok {
			return nil, 0, false
		}
		tasks = append(tasks, SharedTask{
			ID:          id,
			Title:       title,
			Description: description,
			Status:      status,
			Assignee:    assignee,
			Blocks:      blocks,
			BlockedBy:   blockedBy,
			CreatedBy:   createdBy,
		})
	}
	return tasks, nextID, true
}

// defaultedString applies a zod `.default(...)`: an absent key takes the
// default, a present non-string (null included) fails the schema.
func defaultedString(m map[string]any, key, def string) (string, bool) {
	v, present := m[key]
	if !present {
		return def, true
	}
	s, ok := v.(string)
	return s, ok
}

// defaultedStringList applies a zod `.array(z.string()).default([])`: an absent
// key yields an empty list, a present non-list (or a list with non-string
// elements) fails the schema.
func defaultedStringList(m map[string]any, key string) ([]string, bool) {
	v, present := m[key]
	if !present {
		return []string{}, true
	}
	list, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		s, ok := item.(string)
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

// save writes the current task list back to disk, returning the mkdir/marshal/
// write failure so callers surface it — TS's save() lets those throw. The
// bytes mirror TS's JSON.stringify(data, null, 2): no HTML escaping. The
// caller must hold the lock.
func (s *SharedTaskStore) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	sd := storeData{NextID: s.nextID, Tasks: s.tasks}
	if s.tasks == nil {
		sd.Tasks = []SharedTask{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(sd); err != nil {
		return err
	}
	return os.WriteFile(s.path, bytes.TrimSuffix(buf.Bytes(), []byte("\n")), 0o644)
}

// Create creates a shared task and returns it. A persistence failure is
// returned to the caller, mirroring TS's save() throwing out of create().
func (s *SharedTaskStore) Create(title, description, assignee string, blocks, blockedBy []string, createdBy string) (SharedTask, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if blocks == nil {
		blocks = []string{}
	}
	if blockedBy == nil {
		blockedBy = []string{}
	}
	task := SharedTask{
		ID:          strconv.Itoa(s.nextID),
		Title:       title,
		Description: description,
		Status:      "pending",
		Assignee:    assignee,
		Blocks:      blocks,
		BlockedBy:   blockedBy,
		CreatedBy:   createdBy,
	}
	s.nextID++
	s.tasks = append(s.tasks, task)
	if err := s.save(); err != nil {
		return task, err
	}
	return task, nil
}

// Get returns the task with the given ID, reloading first to get the latest
// data. It returns nil if the task is not found.
func (s *SharedTaskStore) Get(id string) *SharedTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	for i := range s.tasks {
		if s.tasks[i].ID == id {
			t := s.tasks[i]
			return &t
		}
	}
	return nil
}

// ListTasks lists tasks, optionally filtered by status and assignee.
func (s *SharedTaskStore) ListTasks(status, assignee string) []SharedTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	var result []SharedTask
	for _, t := range s.tasks {
		if status != "" && t.Status != status {
			continue
		}
		if assignee != "" && t.Assignee != assignee {
			continue
		}
		result = append(result, t)
	}
	return result
}

// TaskUpdate describes a single update; a nil pointer leaves the corresponding
// field unchanged.
type TaskUpdate struct {
	Status       *string
	Assignee     *string
	Description  *string
	AddBlocks    []string
	AddBlockedBy []string
}

// Update modifies a task according to TaskUpdate; AddBlocks / AddBlockedBy
// append dependencies (deduplicated). It returns nil if the task does not
// exist.
func (s *SharedTaskStore) Update(id string, upd TaskUpdate) (*SharedTask, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	for i := range s.tasks {
		if s.tasks[i].ID != id {
			continue
		}
		t := &s.tasks[i]
		if upd.Status != nil {
			t.Status = *upd.Status
		}
		if upd.Assignee != nil {
			t.Assignee = *upd.Assignee
		}
		if upd.Description != nil {
			t.Description = *upd.Description
		}
		t.Blocks = appendUnique(t.Blocks, upd.AddBlocks)
		t.BlockedBy = appendUnique(t.BlockedBy, upd.AddBlockedBy)
		if err := s.save(); err != nil {
			return nil, err
		}
		updated := *t
		return &updated, nil
	}
	return nil, nil
}

// InitEmpty clears the task store and persists it, used when initializing a
// newly created team. The persistence failure propagates like TS's save().
func (s *SharedTaskStore) InitEmpty() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks = []SharedTask{}
	s.nextID = 1
	return s.save()
}

// appendUnique appends elements from add that are not yet in base and returns
// the new slice.
func appendUnique(base, add []string) []string {
	for _, v := range add {
		found := slices.Contains(base, v)
		if !found {
			base = append(base, v)
		}
	}
	if base == nil {
		base = []string{}
	}
	return base
}
