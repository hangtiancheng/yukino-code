package ui

import (
	"context"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestPrepareSubagentTurnKeepsRunningBackgroundOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", true)

	taskMgr := subagent.NewTaskManager()
	if err := taskMgr.UseSession(session.NewID()); err != nil {
		t.Fatal(err)
	}
	block := make(chan struct{})
	defer func() {
		close(block)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := taskMgr.WaitAll(ctx, nil); err != nil {
			t.Error(err)
		}
	}()
	runningID, err := taskMgr.Create("running", func(string) (string, error) { <-block; return "", nil }, func() {}, tools.TaskOptions{})
	if err != nil {
		t.Fatal(err)
	}
	doneID, err := taskMgr.Create("done", func(string) (string, error) { return "ok", nil }, func() {}, tools.TaskOptions{})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if task := taskMgr.Get(doneID); task != nil && task.Status != "running" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	m.taskMgr = taskMgr
	m.subagents = map[string]*subagentProgress{
		"fg-terminal": {role: "explore", status: "completed", output: "done"},
		"fg-running":  {role: "explore", status: "running"},
		"bg-running":  {role: "explore", status: "running", taskID: runningID},
		"bg-done":     {role: "explore", status: "completed", taskID: doneID},
	}
	m.prepareSubagentTurn()
	if _, ok := m.subagents["bg-running"]; !ok {
		t.Error("running background entry must survive the turn boundary")
	}
	for _, id := range []string{"fg-terminal", "fg-running", "bg-done"} {
		if _, ok := m.subagents[id]; ok {
			t.Errorf("entry %s must be dropped at the turn boundary", id)
		}
	}
}
