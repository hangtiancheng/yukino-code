package ui

import (
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// The reference opens the agents dialog on Down only when the draft is not
// navigating history (historyIndex === -1). While in history, Down must keep
// walking toward the draft. Regression for the ordering bug where a running
// background task hijacked every Down press.
func TestDownNavigatesHistoryBeforeOpeningAgents(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)

	taskMgr := subagent.NewTaskManager()
	if err := taskMgr.UseSession(session.NewID()); err != nil {
		t.Fatal(err)
	}
	block := make(chan struct{})
	bgID, err := taskMgr.Create("bg", func(string) (string, error) { <-block; return "", nil }, func() {}, tools.TaskOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Unblock the task at teardown and wait for its goroutine to leave running so
	// its session-dir writes settle before t.TempDir cleanup removes the tree.
	defer func() {
		close(block)
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if task := taskMgr.Get(bgID); task == nil || task.Status != "running" {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	m.taskMgr = taskMgr
	if len(m.agentEntries()) == 0 {
		t.Fatal("expected a running background task entry")
	}

	m.historyEntries = []string{"older", "newer"}
	m.historyUp()
	m.historyUp()
	if m.historyIndex != 2 {
		t.Fatalf("historyIndex = %d, want 2", m.historyIndex)
	}

	down := tea.KeyMsg{Type: tea.KeyDown}

	next, _ := m.Update(down)
	m = asModel(t, next)
	if m.agentsDialog {
		t.Fatal("down while navigating history must not open the agents dialog")
	}
	if m.historyIndex != 1 {
		t.Fatalf("historyIndex = %d, want 1 after down", m.historyIndex)
	}

	next, _ = m.Update(down)
	m = asModel(t, next)
	if m.agentsDialog {
		t.Fatal("down to the draft must not open the agents dialog")
	}
	if m.historyIndex != 0 {
		t.Fatalf("historyIndex = %d, want 0 after down", m.historyIndex)
	}

	next, _ = m.Update(down)
	m = asModel(t, next)
	if !m.agentsDialog {
		t.Fatal("down with a clean draft and running agents must open the agents dialog")
	}
}
