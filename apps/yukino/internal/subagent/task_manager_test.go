package subagent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestTaskLifecycleWaitAndLateCancellation(t *testing.T) {
	manager := NewTaskManager()
	started := make(chan struct{})
	release := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	id, err := manager.Create("test", func(string) (string, error) { close(started); <-release; return "late success", nil }, func() { cancelled <- struct{}{} }, tools.TaskOptions{})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if err := manager.Clear(); err == nil {
		t.Fatal("pending tasks cleared")
	}
	task, timedOut, err := manager.Wait(context.Background(), id, 0)
	if err != nil || !timedOut || task.Status != "running" || len(drainAll(t, manager)) != 0 {
		t.Fatal(task, timedOut, err)
	}
	if stopped, err := manager.Stop(id); !stopped || err != nil {
		t.Fatal("running task not stopped")
	}
	<-cancelled
	if manager.HasNotifications() {
		t.Fatal("notification published before runner settled")
	}
	close(release)
	task, _, err = manager.Wait(context.Background(), id, time.Second)
	if err != nil || task.Status != "cancelled" || task.Output != "Stopped by user" {
		t.Fatal(task, err)
	}
	if len(drainAll(t, manager)) != 1 || len(drainAll(t, manager)) != 0 {
		t.Fatal("notification replayed")
	}
	if stopped, err := manager.Stop(id); stopped || err != nil {
		t.Fatal("finished task stopped")
	}
}

func drainAll(t *testing.T, manager *TaskManager) []tools.BackgroundTask {
	t.Helper()
	tasks, err := manager.DrainNotifications()
	if err != nil {
		t.Fatal(err)
	}
	return tasks
}
func TestTaskFailurePreservesFormattedOutputAndSessionRecovery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := NewTaskManager()
	if err := manager.UseSession("tasks-session"); err != nil {
		t.Fatal(err)
	}
	id, err := manager.Create("shell", func(string) (string, error) {
		return "", &tools.TaskFailure{Output: "$ command\ncaptured\nExit code 7"}
	}, nil, tools.TaskOptions{Kind: "shell", IDPrefix: "bash"})
	if err != nil {
		t.Fatal(err)
	}
	task, _, err := manager.Wait(context.Background(), id, time.Second)
	if err != nil || task.Status != "failed" || !strings.Contains(task.Output, "captured") {
		t.Fatal(task, err)
	}
	recovered := NewTaskManager()
	if err := recovered.UseSession("tasks-session"); err != nil {
		t.Fatal(err)
	}
	if got := recovered.Get(id); got == nil || got.Output != task.Output {
		t.Fatal(got)
	}
	if len(drainAll(t, recovered)) != 1 {
		t.Fatal("unnotified result lost")
	}
	reloaded := NewTaskManager()
	if err := reloaded.UseSession("tasks-session"); err != nil {
		t.Fatal(err)
	}
	if reloaded.HasNotifications() {
		t.Fatal("persisted notification replayed")
	}
	store, err := newBackgroundTaskStore("interrupted-session")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.save(storedBackgroundTask{BackgroundTask: tools.BackgroundTask{ID: "agent-5000", Name: "interrupted", Status: "running", Output: "partial", StartedAt: 1}}); err != nil {
		t.Fatal(err)
	}
	if err := reloaded.UseSession("interrupted-session"); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Get("agent-5000"); got == nil || got.Status != "failed" || !strings.Contains(got.Output, "session restored") {
		t.Fatal(got)
	}
	newID, err := reloaded.Create("next", func(string) (string, error) { return "ok", nil }, nil, tools.TaskOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if taskIDNumber(newID) <= 5000 {
		t.Fatal("restored task ID reused")
	}
	_ = reloaded.WaitAll(context.Background(), nil)
	dir, _ := storage.SessionPath("interrupted-session", "background-tasks")
	if err := storage.WritePrivateFileSync(filepath.Join(dir, "agent-5001.json"), []byte(`{"id":"agent-5"}`), os.O_CREATE|os.O_WRONLY); err != nil {
		t.Fatal(err)
	}
	if err := NewTaskManager().UseSession("interrupted-session"); err == nil {
		t.Fatal("invalid task record accepted")
	}
}
func TestCancelledTaskFailureAndWaitCancellation(t *testing.T) {
	manager := NewTaskManager()
	started := make(chan struct{})
	release := make(chan struct{})
	id, _ := manager.Create("failure", func(string) (string, error) {
		close(started)
		<-release
		return "", &tools.TaskFailure{Output: "captured on stop"}
	}, func() { close(release) }, tools.TaskOptions{Kind: "shell"})
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := manager.Wait(ctx, id, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := manager.StopAndWait(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if got := manager.Get(id); got.Status != "cancelled" || got.Output != "captured on stop" {
		t.Fatal(got)
	}
}
