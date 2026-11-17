package ui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// The reference wires the agent's shouldContinueGoal to `!followUps.hasPending()`
// so a follow-up queued during a goal run pauses continuation at the next turn
// boundary. Go pushes the queue depth to the agent (SetPendingFollowUps) at the
// Update return points; this pins the gate and that sync.
func TestGoalContinuationGateReflectsFollowUpQueue(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)
	m.ag = agent.New(nil, tools.NewRegistry(), "anthropic")
	m.ag.ShouldContinueGoal = m.ag.NoPendingFollowUps

	if !m.ag.ShouldContinueGoal() {
		t.Fatal("gate must allow continuation with an empty queue")
	}

	// A slash command submitted while busy queues as a follow-up instead of
	// steering, and Update pushes the new depth to the agent.
	m.streaming = true
	m.editor.SetValue("/help")
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = asModel(t, next)
	if len(m.pendingMessages) != 1 {
		t.Fatalf("follow-up not queued: %d", len(m.pendingMessages))
	}
	if m.ag.ShouldContinueGoal() {
		t.Fatal("gate must pause goal continuation while a follow-up is queued")
	}

	// Clearing the queue (e.g. /clear, rewind, session switch) lifts the gate.
	m.pendingMessages = nil
	m.syncFollowUps()
	if !m.ag.ShouldContinueGoal() {
		t.Fatal("gate must allow continuation after the queue clears")
	}
}

// The agent gate is a pure function of the pushed depth.
func TestAgentNoPendingFollowUps(t *testing.T) {
	ag := agent.New(nil, tools.NewRegistry(), "anthropic")
	if !ag.NoPendingFollowUps() {
		t.Fatal("fresh agent must report no pending follow-ups")
	}
	ag.SetPendingFollowUps(2)
	if ag.NoPendingFollowUps() {
		t.Fatal("depth 2 must report pending follow-ups")
	}
	ag.SetPendingFollowUps(0)
	if !ag.NoPendingFollowUps() {
		t.Fatal("depth 0 must report no pending follow-ups")
	}
}
