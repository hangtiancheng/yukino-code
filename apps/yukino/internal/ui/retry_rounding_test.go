package ui

import (
	"strings"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
)

// TestRetryDelayRounding verifies the retry status and system message round the
// delay with Math.round (half-up) semantics like the reference, not Go's %.0f
// half-to-even: a 2.5s delay must render as "3s", not "2s".
func TestRetryDelayRounding(t *testing.T) {
	m := newChatModel(t)
	next, _ := m.handleAgentEvent(agent.RetryEvent{Reason: "rate limited", Wait: 2500 * time.Millisecond})
	m = asModel(t, next)

	if !strings.Contains(m.retryStatus, "(3s delay)") {
		t.Errorf("retryStatus = %q, want it to contain (3s delay)", m.retryStatus)
	}
	found := false
	for _, msg := range m.chatMessages {
		if strings.Contains(msg.content, "(waiting 3s)") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a system message containing (waiting 3s); messages = %v", m.chatMessages)
	}
}
