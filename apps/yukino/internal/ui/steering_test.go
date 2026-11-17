package ui

import (
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestBusyTextSteersAndSlashCommandQueues(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)
	m.sessionID = "steering-ui"
	m.ag = agent.New(nil, tools.NewRegistry(), "anthropic")
	m.steeringAgent = m.ag
	m.streaming = true
	m.editor.SetValue("correction")
	next, _ := m.submitInput("correction")
	m = asModel(t, next)
	if len(m.pendingMessages) != 0 || len(m.steeringPending) != 1 || m.editor.Value() != "" {
		t.Fatal("text was not steered")
	}
	next, _ = m.submitInput("/help")
	m = asModel(t, next)
	if len(m.pendingMessages) != 1 || m.pendingMessages[0].text != "/help" {
		t.Fatal("command was not queued")
	}
	if text, ok := m.recallQueued(); !ok || text != "/help" {
		t.Fatal("follow-up must recall before steering")
	}
	if text, ok := m.recallQueued(); !ok || text != "correction" {
		t.Fatal("steering not recalled")
	}
	if len(m.ag.DrainSteering()) != 0 {
		t.Fatal("recalled steering still pending")
	}
}

func TestUndeliveredSteeringRetainsInputOnCleanup(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)
	m.sessionID = "steering-ui"
	m.ag = agent.New(nil, tools.NewRegistry(), "anthropic")
	m.steeringAgent = m.ag
	m.streaming = true
	next, _ := m.submitInput("keep me")
	m = asModel(t, next)
	input := m.steeringPending[0]
	ch := make(chan agent.AgentEvent)
	close(ch)
	m.settlingCh = ch
	m.streaming = false
	m.planApprovalDialog = true
	next, _ = m.Update(foregroundSettledMsg{ch: ch})
	m = asModel(t, next)
	if len(m.steeringPending) != 0 || len(m.pendingMessages) != 1 || m.pendingMessages[0].input == nil || m.pendingMessages[0].input.ID != input.ID {
		t.Fatal("cleanup lost input identity")
	}
}
