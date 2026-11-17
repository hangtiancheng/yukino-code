package todo

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func testList(t *testing.T) *TaskList {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	store, err := NewStore("test")
	if err != nil {
		t.Fatal(err)
	}
	list, err := NewTaskList(store)
	if err != nil {
		t.Fatal(err)
	}
	return list
}
func writeTodos(t *testing.T, list *TaskList, input map[string]any) []*Task {
	t.Helper()
	tasks, err := list.Write(input)
	if err != nil {
		t.Fatal(err)
	}
	return tasks
}
func TestTodoIncrementalTransactionsAndRollback(t *testing.T) {
	list := testList(t)
	writeTodos(t, list, map[string]any{"todos": []any{map[string]any{"subject": " first ", "priority": "low", "metadata": map[string]any{"remove": 1, "keep": 2, "nested": map[string]any{"old": true}}}, map[string]any{"subject": "second"}, map[string]any{"subject": "third"}}})
	tasks := writeTodos(t, list, map[string]any{"todos": []any{map[string]any{"id": "2", "blockedBy": []string{"1"}, "status": "in_progress"}, map[string]any{"id": "1", "status": "completed", "priority": "high", "metadata": map[string]any{"remove": nil, "nested": map[string]any{"new": true}}}, map[string]any{"id": "3", "blockedBy": []string{"2", "2"}}}})
	if tasks[0].Subject != "first" || tasks[0].Priority != "high" || tasks[0].Metadata["keep"] != float64(2) || tasks[0].Metadata["remove"] != nil || !reflect.DeepEqual(tasks[0].Blocks, []string{"2"}) || !reflect.DeepEqual(tasks[2].BlockedBy, []string{"2"}) {
		t.Fatal(tasks)
	}
	if Progress(tasks) != "DONE 1/3" {
		t.Fatal(Progress(tasks))
	}
	before := list.List()
	for _, input := range []map[string]any{
		{"deleteIds": []string{"3"}, "todos": []any{map[string]any{"subject": "new"}, map[string]any{"id": "1", "blocks": []string{"999"}}}},
		{"todos": []any{map[string]any{"id": "1", "blockedBy": []string{"3"}}}},
		{"todos": []any{map[string]any{"id": "3", "status": "in_progress"}}},
		{"todos": []any{map[string]any{"id": "1", "blocks": []string{"3"}}, map[string]any{"id": "3", "blockedBy": []string{}}}},
		{"todos": []any{map[string]any{"subject": "new", "blocks": []string{"2"}}}},
		{"todos": []any{map[string]any{"subject": "new"}, map[string]any{"id": "4", "description": "cannot update a newly-created ID in this call"}}},
		{"deleteIds": []string{"3", "3"}},
		{"todos": []any{map[string]any{"id": "1", "blocks": []string{"1"}}}},
	} {
		if _, err := list.Write(input); err == nil {
			t.Fatal("invalid transaction accepted", input)
		}
		if !reflect.DeepEqual(list.List(), before) {
			t.Fatal("failed batch changed state")
		}
	}
	tasks = writeTodos(t, list, map[string]any{"deleteIds": []string{"3"}, "todos": []any{map[string]any{"id": "1", "priority": "medium"}, map[string]any{"subject": "fourth", "blockedBy": []string{"1"}}}})
	if tasks[len(tasks)-1].ID != "4" || len(tasks[1].Blocks) != 0 {
		t.Fatal(tasks)
	}
	reloaded, err := NewTaskList(list.store)
	if err != nil || !reflect.DeepEqual(reloaded.List(), list.List()) {
		t.Fatal(err)
	}
	tasks[0].Metadata["keep"] = "changed"
	if list.Get("1").Metadata["keep"] == "changed" {
		t.Fatal("caller mutated board")
	}
}
func TestTodoPersistencePublishesOnlyCommittedSnapshots(t *testing.T) {
	list := testList(t)
	changes := 0
	unsubscribe := list.Subscribe(func(tasks []*Task) {
		changes++
		if len(tasks) > 0 {
			tasks[0].Subject = "observer cannot mutate board"
		}
	})
	defer unsubscribe()
	writeTodos(t, list, map[string]any{"todos": []any{map[string]any{"subject": "first"}, map[string]any{"subject": "second"}}})
	if changes != 2 {
		t.Fatal(changes)
	}
	writeTodos(t, list, map[string]any{"todos": []any{}, "deleteIds": []string{}})
	if changes != 2 {
		t.Fatal("empty edit emitted change")
	}
	writeTodos(t, list, map[string]any{"deleteIds": []string{"2"}, "todos": []any{map[string]any{"id": "1", "status": "completed"}, map[string]any{"subject": "third"}}})
	if changes != 3 || list.Get("1").Subject != "first" {
		t.Fatal(changes, list.List())
	}
	originalPath := list.store.path
	list.store.path = t.TempDir()
	before := list.List()
	if _, err := list.Write(map[string]any{"todos": []any{map[string]any{"subject": "uncommitted"}}}); err == nil {
		t.Fatal("save to directory succeeded")
	}
	if changes != 3 || !reflect.DeepEqual(before, list.List()) {
		t.Fatal("failed save published state")
	}
	list.store.path = originalPath
	tasks := writeTodos(t, list, map[string]any{"todos": []any{map[string]any{"subject": "after failure"}}})
	if tasks[len(tasks)-1].ID != "4" {
		t.Fatal(tasks)
	}
	other, err := NewStore("other")
	if err != nil {
		t.Fatal(err)
	}
	if err := list.UseStore(other); err != nil {
		t.Fatal(err)
	}
	if len(list.List()) != 0 || list.BoardID() != "private:other" {
		t.Fatal(list.BoardID(), list.List())
	}
}
func TestTodoStrictSnapshotsAndInput(t *testing.T) {
	list := testList(t)
	tasks := writeTodos(t, list, map[string]any{"todos": []any{map[string]any{"subject": "first"}}})
	valid, err := json.Marshal(Snapshot{NextID: 2, Tasks: tasks})
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		`[]`, `{"nextId":0,"tasks":[]}`, `{"nextId":1.5,"tasks":[]}`, `{"nextId":9007199254740992,"tasks":[]}`,
		strings.Replace(string(valid), `"nextId":2`, `"nextId":1`, 1), strings.Replace(string(valid), `"id":"1"`, `"id":"01"`, 1), strings.Replace(string(valid), `"blocks":[]`, `"blocks":["01"]`, 1), strings.Replace(string(valid), `"blocks":[]`, `"blocks":["2"]`, 1), strings.Replace(string(valid), `"owner":""`, `"owner":null`, 1), strings.Replace(string(valid), `"owner":""`, `"owner":"","priority":""`, 1), strings.Replace(string(valid), `"subject":"first"`, `"subject":null`, 1),
	} {
		if err := storage.WritePrivateFileSync(list.store.path, []byte(invalid), os.O_WRONLY|os.O_TRUNC); err != nil {
			t.Fatal(err)
		}
		if _, err := NewTaskList(list.store); err == nil {
			t.Fatal("invalid snapshot accepted", invalid)
		}
		actual, err := os.ReadFile(list.store.path)
		if err != nil || string(actual) != invalid {
			t.Fatal("corrupt snapshot changed", err)
		}
	}
	for _, input := range []map[string]any{{"unknown": true}, {"todos": nil}, {"deleteIds": nil}, {"deleteIds": []string{"01"}}, {"todos": []any{nil}}, {"todos": []any{map[string]any{}}}, {"todos": []any{map[string]any{"subject": " "}}}, {"todos": []any{map[string]any{"subject": "a", "priority": "urgent"}}}, {"todos": []any{map[string]any{"subject": "a", "status": "deleted"}}}, {"todos": []any{map[string]any{"subject": "a", "activeForm": "legacy"}}}} {
		if _, err := ParseWrite(input); err == nil {
			t.Fatal("invalid input accepted", input)
		}
	}
}
