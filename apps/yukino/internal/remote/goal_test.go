package remote

import (
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/session"
)

func TestServerGoalLazyPerSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Chdir(t.TempDir())
	s := &Server{}
	s.sessionID = session.NewID()

	g1 := s.goal()
	if g1 == nil || g1.SessionID() != s.sessionID {
		t.Fatalf("expected goal manager for session %s, got %+v", s.sessionID, g1)
	}
	if g2 := s.goal(); g2 != g1 {
		t.Fatalf("expected the same goal manager within a session")
	}

	s.sessionID = session.NewID()
	g3 := s.goal()
	if g3 == g1 || g3.SessionID() != s.sessionID {
		t.Fatalf("expected a fresh goal manager after a session change")
	}
}

func TestServerGoalReloadsPersistedState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Chdir(t.TempDir())
	s := &Server{}
	s.sessionID = session.NewID()

	g := s.goal()
	if err := g.Set("persisted objective", nil, false); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	// A fresh manager for the same session must reload the persisted goal.
	s.goalManager = nil
	reloaded := s.goal()
	if reloaded.Get() == nil || reloaded.Get().Objective != "persisted objective" {
		t.Fatalf("expected reloaded goal, got %+v", reloaded.Get())
	}
}
