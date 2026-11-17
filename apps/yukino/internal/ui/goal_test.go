package ui

import (
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/session"
)

func newGoalTestModel(t *testing.T) Model {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", true)
	m.sessionID = session.NewID()
	return m
}

func TestGoalBinderLazyPerSession(t *testing.T) {
	m := newGoalTestModel(t)
	g1 := m.currentGoal()
	if g1 == nil || g1.SessionID() != m.sessionID {
		t.Fatalf("expected goal manager for session %s, got %+v", m.sessionID, g1)
	}
	if g2 := m.currentGoal(); g2 != g1 {
		t.Fatalf("expected the same goal manager within a session")
	}
	m.sessionID = session.NewID()
	g3 := m.currentGoal()
	if g3 == g1 || g3.SessionID() != m.sessionID {
		t.Fatalf("expected a fresh goal manager after a session change")
	}
	if m.goalBinder.get() != g3 {
		t.Fatalf("expected the binder to hold the latest manager")
	}
}

func TestGoalCommandStatusNoGoal(t *testing.T) {
	m := newGoalTestModel(t)
	updated, _ := m.executeCommand("/goal status", nil)
	m = updated.(Model)
	if len(m.chatMessages) == 0 {
		t.Fatalf("expected a system message")
	}
	last := m.chatMessages[len(m.chatMessages)-1]
	if last.role != "system" || last.content != goal.NoGoalMessage {
		t.Fatalf("expected no-goal system message, got %+v", last)
	}
}

func TestGoalCommandSetRecordsGoal(t *testing.T) {
	m := newGoalTestModel(t)
	updated, _ := m.executeCommand("/goal make it so", nil)
	m = updated.(Model)
	g := m.currentGoal()
	if g.Get() == nil || g.Get().Objective != "make it so" {
		t.Fatalf("expected the goal to be set, got %+v", g.Get())
	}
	// No client/agent is active in this model, so the run must not start.
	if m.streaming {
		t.Fatalf("expected no streaming without an active agent")
	}
}

func TestGoalCommandClearThenStatus(t *testing.T) {
	m := newGoalTestModel(t)
	updated, _ := m.executeCommand("/goal make it so", nil)
	m = updated.(Model)
	updated, _ = m.executeCommand("/goal clear", nil)
	m = updated.(Model)
	if g := m.currentGoal().Get(); g != nil {
		t.Fatalf("expected goal cleared, got %+v", g)
	}
}

func TestSessionClearRebindsGoal(t *testing.T) {
	m := newGoalTestModel(t)
	_ = m.currentGoal()
	oldSession := m.sessionID
	updated, _ := m.executeCommand("/clear", nil)
	m = updated.(Model)
	if m.sessionID == oldSession {
		t.Fatalf("expected the session to change after /clear")
	}
	if g := m.currentGoal(); g.SessionID() != m.sessionID {
		t.Fatalf("expected goal manager for new session %s, got %s", m.sessionID, g.SessionID())
	}
}
