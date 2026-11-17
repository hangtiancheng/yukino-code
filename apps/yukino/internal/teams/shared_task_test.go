package teams

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/todo"
)

func newTestStore(t *testing.T) *SharedTaskStore {
	t.Helper()
	store, err := NewSharedTaskStore(filepath.Join(t.TempDir(), "tasks.json"))
	if err != nil {
		t.Fatal(err)
	}
	return store
}
func sharedWrite(t *testing.T, store *SharedTaskStore, input map[string]any, options todo.WriteOptions) []*todo.Task {
	t.Helper()
	tasks, err := store.Write(input, options)
	if err != nil {
		t.Fatal(err)
	}
	return tasks
}
func TestSharedTaskTransactionsReloadAndOwnership(t *testing.T) {
	store := newTestStore(t)
	second, err := NewSharedTaskStore(store.path)
	if err != nil {
		t.Fatal(err)
	}
	tasks := sharedWrite(t, store, map[string]any{"todos": []any{map[string]any{"subject": "first", "owner": "alice"}, map[string]any{"subject": "second"}}}, todo.WriteOptions{})
	if tasks[0].ID != "1" || tasks[1].ID != "2" || tasks[0].CreatedBy == nil {
		t.Fatal(tasks)
	}
	sharedWrite(t, store, map[string]any{"todos": []any{map[string]any{"id": "1", "status": "completed"}}}, todo.WriteOptions{})
	tasks = sharedWrite(t, second, map[string]any{"todos": []any{map[string]any{"id": "2", "status": "in_progress", "blockedBy": []string{"1"}}}}, todo.WriteOptions{Actor: "bob"})
	if tasks[0].Status != todo.StatusCompleted || tasks[1].Owner != "bob" || len(tasks[0].Blocks) != 1 {
		t.Fatal(tasks)
	}
	for _, input := range []map[string]any{{"deleteIds": []string{"2"}}, {"todos": []any{map[string]any{"id": "2", "priority": "high"}}}, {"todos": []any{map[string]any{"subject": "new", "owner": "alice"}}}} {
		if _, err := store.Write(input, todo.WriteOptions{Actor: "mallory"}); err == nil {
			t.Fatal("ownership bypassed", input)
		}
	}
	released, err := store.ReleaseOwner("bob")
	if err != nil || len(released) != 1 || released[0].Status != todo.StatusPending || released[0].Owner != "" {
		t.Fatal(released, err)
	}
	if _, err := store.Get("999"); err != nil {
		t.Fatal(err)
	}
	for _, filter := range []struct {
		status, owner string
		count         int
	}{{"", "", 2}, {"completed", "", 1}, {"", "alice", 1}, {"completed", "bob", 0}} {
		tasks, err := store.ListTasks(filter.status, filter.owner)
		if err != nil || len(tasks) != filter.count {
			t.Fatal(tasks, err)
		}
	}
	if err := store.InitEmpty(); err != nil {
		t.Fatal(err)
	}
	tasks = sharedWrite(t, store, map[string]any{"todos": []any{map[string]any{"subject": "reset"}}}, todo.WriteOptions{})
	if tasks[0].ID != "1" {
		t.Fatal(tasks)
	}
}
func TestSharedTaskConcurrentWritersAndUnreadableState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.json")
	failures := make(chan error, 20)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			store, err := NewSharedTaskStore(path)
			if err == nil {
				_, err = store.Write(map[string]any{"todos": []any{map[string]any{"subject": "parallel"}}}, todo.WriteOptions{})
			}
			if err != nil {
				failures <- err
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	store, err := NewSharedTaskStore(path)
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := store.ListTasks("", "")
	if err != nil || len(tasks) != 20 {
		t.Fatal(len(tasks), err)
	}
	corrupt := []byte(`{"nextId":2,"tasks":[{"id":"1","subject":"bad","description":"","status":"pending","owner":"","metadata":{},"blocks":["2"],"blockedBy":[],"createdBy":""}]}`)
	if err := os.WriteFile(path, corrupt, 0600); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{func() error { _, err := store.ListTasks("", ""); return err }, func() error { _, err := store.Get("1"); return err }, func() error {
		_, err := store.Write(map[string]any{"todos": []any{map[string]any{"subject": "new"}}}, todo.WriteOptions{})
		return err
	}, store.InitEmpty} {
		if err := operation(); err == nil {
			t.Fatal("corrupt board accepted")
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != string(corrupt) {
			t.Fatal("corrupt board was overwritten", err)
		}
	}
}

func TestSharedTaskProcessWriter(t *testing.T) {
	path := os.Getenv("YUKINO_SHARED_TASK_TEST_PATH")
	if path == "" {
		return
	}
	for range 5 {
		store, err := NewSharedTaskStore(path)
		if err == nil {
			_, err = store.Write(map[string]any{"todos": []any{map[string]any{"subject": "process"}}}, todo.WriteOptions{})
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}
func TestSharedTaskCrossProcessWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.json")
	failures := make(chan error, 4)
	var writers sync.WaitGroup
	for range 4 {
		writers.Add(1)
		go func() {
			defer writers.Done()
			command := exec.Command(os.Args[0], "-test.run=^TestSharedTaskProcessWriter$")
			command.Env = append(os.Environ(), "YUKINO_SHARED_TASK_TEST_PATH="+path)
			if output, err := command.CombinedOutput(); err != nil {
				failures <- fmt.Errorf("%w: %s", err, output)
			}
		}()
	}
	writers.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	finalStore, err := NewSharedTaskStore(path)
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := finalStore.ListTasks("", "")
	if err != nil || len(tasks) != 20 {
		t.Fatal(len(tasks), err)
	}
	seen := map[string]bool{}
	for _, task := range tasks {
		if seen[task.ID] {
			t.Fatal("duplicate ID", task.ID)
		}
		seen[task.ID] = true
	}
}

func TestNewSharedTaskStoreFailsOnUnreadableBoard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.json")
	if err := os.WriteFile(path, []byte("{corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := NewSharedTaskStore(path)
	if err == nil || !strings.Contains(err.Error(), "Cannot load an unreadable shared task board") {
		t.Fatalf("expected the unreadable-board error at construction, got %v", err)
	}
}
