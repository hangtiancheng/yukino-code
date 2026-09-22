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
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *SharedTaskStore {
	t.Helper()
	return NewSharedTaskStore(filepath.Join(t.TempDir(), "tasks.json"))
}

//go:fix inline
func strptr(s string) *string { return new(s) }

// mustCreate wraps Create for tests: persistence failures are fatal here.
func mustCreate(t *testing.T, store *SharedTaskStore, title, description, assignee string, blocks, blockedBy []string, createdBy string) SharedTask {
	t.Helper()
	task, err := store.Create(title, description, assignee, blocks, blockedBy, createdBy)
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}
	return task
}

func TestSharedTaskCreateAssignsStringIDsAndPending(t *testing.T) {
	store := newTestStore(t)
	t1 := mustCreate(t, store, "first", "", "", nil, nil, "lead")
	t2 := mustCreate(t, store, "second", "desc", "alice", nil, nil, "lead")

	if t1.ID != "1" || t2.ID != "2" {
		t.Fatalf("ids = %q,%q, want 1,2", t1.ID, t2.ID)
	}
	if t1.Status != "pending" {
		t.Fatalf("status = %q, want pending", t1.Status)
	}
	if t2.Assignee != "alice" || t2.Description != "desc" || t2.CreatedBy != "lead" {
		t.Fatalf("unexpected task2 fields: %+v", t2)
	}
}

func TestSharedTaskGetAndList(t *testing.T) {
	store := newTestStore(t)
	mustCreate(t, store, "a", "", "alice", nil, nil, "")
	b := mustCreate(t, store, "b", "", "bob", nil, nil, "")
	if _, err := store.Update(b.ID, TaskUpdate{Status: new("completed")}); err != nil {
		t.Fatal(err)
	}

	if store.Get("999") != nil {
		t.Fatalf("get missing should be nil")
	}
	if len(store.ListTasks("", "")) != 2 {
		t.Fatalf("list all should be 2")
	}
	if len(store.ListTasks("completed", "")) != 1 {
		t.Fatalf("filter by status failed")
	}
	if len(store.ListTasks("", "alice")) != 1 {
		t.Fatalf("filter by assignee failed")
	}
	if len(store.ListTasks("completed", "alice")) != 0 {
		t.Fatalf("combined filter failed")
	}
}

func TestSharedTaskUpdateAndDeps(t *testing.T) {
	store := newTestStore(t)
	task := mustCreate(t, store, "task", "", "", nil, nil, "")
	updated, err := store.Update(task.ID, TaskUpdate{
		Status:       new("in_progress"),
		Assignee:     new("carol"),
		Description:  new("new desc"),
		AddBlocks:    []string{"2"},
		AddBlockedBy: []string{"3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated == nil || updated.Status != "in_progress" || updated.Assignee != "carol" {
		t.Fatalf("update result unexpected: %+v", updated)
	}
	if len(updated.Blocks) != 1 || updated.Blocks[0] != "2" {
		t.Fatalf("blocks not appended: %+v", updated.Blocks)
	}
	// Appending the same dependency again is deduplicated.
	again, err := store.Update(task.ID, TaskUpdate{AddBlocks: []string{"2"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Blocks) != 1 {
		t.Fatalf("dedup failed: %+v", again.Blocks)
	}
	if missing, err := store.Update("nope", TaskUpdate{Status: new("completed")}); err != nil || missing != nil {
		t.Fatalf("update missing should be (nil, nil), got (%v, %v)", missing, err)
	}
}

func TestSharedTaskPersistenceAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.json")
	store1 := NewSharedTaskStore(path)
	mustCreate(t, store1, "persisted", "", "", nil, nil, "lead")

	// A second instance (simulating a teammate process) reads the same file.
	store2 := NewSharedTaskStore(path)
	if len(store2.ListTasks("", "")) != 1 {
		t.Fatalf("store2 should see 1 task")
	}
	// After store2 writes, store1 reloads before reading.
	mustCreate(t, store2, "from-teammate", "", "", nil, nil, "bob")
	if got := store1.Get("2"); got == nil || got.Title != "from-teammate" {
		t.Fatalf("store1 did not reload teammate task: %+v", got)
	}
}

func TestSharedTaskInitEmpty(t *testing.T) {
	store := newTestStore(t)
	mustCreate(t, store, "x", "", "", nil, nil, "")
	if err := store.InitEmpty(); err != nil {
		t.Fatal(err)
	}
	if len(store.ListTasks("", "")) != 0 {
		t.Fatalf("initEmpty did not clear")
	}
	if mustCreate(t, store, "y", "", "", nil, nil, "").ID != "1" {
		t.Fatalf("nextID not reset")
	}
}
