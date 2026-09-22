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
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module:"todo"})).
var log = logger.CreateChildLogger("todo")

type Store struct {
	path string
}

func NewStore(dir, listID string) *Store {
	return &Store{
		path: filepath.Join(dir, ".yukino", "tasks", listID+".json"),
	}
}

// Load reads the task list. TS parses the file with
// z.array(StoredTaskSchema): a missing file yields [], while an unreadable,
// corrupt or schema-violating file logs "todo operation failed" and also
// yields [] — one invalid entry discards the whole list.
func (s *Store) Load() ([]*Task, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return nil, nil
	}

	var raw []map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		log.Error("todo operation failed", "err", err)
		return nil, nil
	}
	tasks := make([]*Task, 0, len(raw))
	for _, entry := range raw {
		task, ok := storedTaskFromRecord(entry)
		if !ok {
			log.Error("todo operation failed", "err", "invalid stored task")
			return nil, nil
		}
		tasks = append(tasks, task)
	}
	return tasks, nil
}

// storedTaskFromRecord applies StoredTaskSchema: id/subject/description must
// be strings, status must be one of the three stored values, blocks/blockedBy
// string arrays, metadata a record, and owner/activeForm — when present —
// strings (zod's optional fields are not nullable).
func storedTaskFromRecord(m map[string]any) (*Task, bool) {
	id, ok := m["id"].(string)
	if !ok {
		return nil, false
	}
	subject, ok := m["subject"].(string)
	if !ok {
		return nil, false
	}
	description, ok := m["description"].(string)
	if !ok {
		return nil, false
	}
	status, ok := m["status"].(string)
	if !ok {
		return nil, false
	}
	switch status {
	case string(StatusPending), string(StatusInProgress), string(StatusCompleted):
	default:
		return nil, false
	}
	blocks, ok := storedStringArray(m["blocks"])
	if !ok {
		return nil, false
	}
	blockedBy, ok := storedStringArray(m["blockedBy"])
	if !ok {
		return nil, false
	}
	metadata, ok := m["metadata"].(map[string]any)
	if !ok {
		return nil, false
	}
	task := &Task{
		ID:          id,
		Subject:     subject,
		Description: description,
		Status:      TaskStatus(status),
		Blocks:      blocks,
		BlockedBy:   blockedBy,
		Metadata:    metadata,
	}
	if v, present := m["owner"]; present {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		task.Owner = s
	}
	if v, present := m["activeForm"]; present {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		task.ActiveForm = s
	}
	return task, true
}

// storedStringArray accepts a missing key (zod would reject it, but the
// caller already reports false for a present non-array), and rejects a list
// with non-string elements like z.array(z.string()).
func storedStringArray(v any) ([]string, bool) {
	if v == nil {
		return nil, false
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

func (s *Store) Save(tasks []*Task) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(tasks, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0o644)
}
