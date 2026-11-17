package ui

import (
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/config"
)

func TestClearResetsSession(t *testing.T) {
	provider := config.ProviderConfig{
		Name:     "test",
		Protocol: "anthropic",
		Model:    "claude-sonnet-4-20250514",
		APIKey:   "test-key",
	}
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", true)

	m.chatMessages = []chatMessage{
		{role: "user", content: "hello"},
		{role: "assistant", content: "hi"},
	}
	m.committedUpTo = 2
	m.totalInput = 1000
	m.totalOutput = 500
	oldSessionID := m.sessionID

	updated, _ := m.executeCommand("/clear", nil)
	m = updated.(Model)

	if len(m.chatMessages) != 0 {
		t.Errorf("chatMessages should be empty after /clear, got %d", len(m.chatMessages))
	}

	if m.committedUpTo != 0 {
		t.Errorf("committedUpTo should be 0 after /clear, got %d", m.committedUpTo)
	}

	if m.sessionID == oldSessionID {
		t.Errorf("sessionID should change after /clear, still %s", m.sessionID)
	}
	if m.sessionID == "" {
		t.Error("sessionID should not be empty after /clear")
	}

	if m.totalInput != 0 {
		t.Errorf("totalInput should be 0 after /clear, got %d", m.totalInput)
	}
	if m.totalOutput != 0 {
		t.Errorf("totalOutput should be 0 after /clear, got %d", m.totalOutput)
	}

	if m.conversation == nil {
		t.Error("conversation should not be nil after /clear")
	}
}
