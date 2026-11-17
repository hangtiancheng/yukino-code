package ui

import (
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
)

// TestOrphanToolResultLandsInCommittedSummary pins the reference turnToolCalls
// semantics: a tool_result without a preceding tool_use never enters the live
// viewport but still lands in the committed turn_summary card.
func TestOrphanToolResultLandsInCommittedSummary(t *testing.T) {
	m := newChatModel(t)
	next, _ := m.handleAgentEvent(agent.ToolResultEvent{ToolID: "orphan", ToolName: "Bash", Output: "orphan output", IsError: true, Elapsed: time.Second})
	m = asModel(t, next)
	if len(m.toolBlocks) != 0 {
		t.Fatalf("orphan must not enter the live viewport: %#v", m.toolBlocks)
	}
	next, _ = m.handleAgentEvent(agent.TurnComplete{})
	m = asModel(t, next)
	if len(m.chatMessages) != 1 || len(m.chatMessages[0].toolGroup) != 1 {
		t.Fatalf("orphan not committed: %#v", m.chatMessages)
	}
	entry := m.chatMessages[0].toolGroup[0]
	if entry.toolID != "orphan" || entry.output != "orphan output" || !entry.isError {
		t.Fatalf("orphan entry = %#v", entry)
	}
}

// TestSummaryOrderWithOrphan pins the insertion order: tool_use ids keep
// their arrival position and orphan results append where they arrive.
func TestSummaryOrderWithOrphan(t *testing.T) {
	m := newChatModel(t)
	for _, ev := range []agent.AgentEvent{
		agent.ToolUseEvent{ToolID: "one", ToolName: "Bash", Args: map[string]any{"command": "first"}},
		agent.ToolResultEvent{ToolID: "orphan", ToolName: "Grep", Output: "orphan output"},
		agent.ToolResultEvent{ToolID: "one", ToolName: "Bash", Output: "first output"},
	} {
		next, _ := m.handleAgentEvent(ev)
		m = asModel(t, next)
	}
	next, _ := m.handleAgentEvent(agent.TurnComplete{})
	m = asModel(t, next)
	if len(m.chatMessages) != 1 || len(m.chatMessages[0].toolGroup) != 2 {
		t.Fatalf("summary not committed: %#v", m.chatMessages)
	}
	group := m.chatMessages[0].toolGroup
	if group[0].toolID != "one" || group[1].toolID != "orphan" {
		t.Fatalf("summary order = [%s %s], want [one orphan]", group[0].toolID, group[1].toolID)
	}
	if len(m.toolBlocks) != 0 {
		t.Fatalf("viewport must be empty after the commit: %#v", m.toolBlocks)
	}
}

// TestDuplicateToolResultLastWins pins the reference Map.set overwrite: a
// repeated tool_result replaces the summary entry without duplicating it.
func TestDuplicateToolResultLastWins(t *testing.T) {
	m := newChatModel(t)
	for _, ev := range []agent.AgentEvent{
		agent.ToolUseEvent{ToolID: "one", ToolName: "Bash", Args: map[string]any{"command": "first"}},
		agent.ToolResultEvent{ToolID: "one", ToolName: "Bash", Output: "stale"},
		agent.ToolResultEvent{ToolID: "one", ToolName: "Bash", Output: "fresh"},
		agent.TurnComplete{},
	} {
		next, _ := m.handleAgentEvent(ev)
		m = asModel(t, next)
	}
	if len(m.chatMessages) != 1 || len(m.chatMessages[0].toolGroup) != 1 {
		t.Fatalf("summary = %#v", m.chatMessages)
	}
	if got := m.chatMessages[0].toolGroup[0].output; got != "fresh" {
		t.Fatalf("output = %q, want the last result", got)
	}
}

// TestInterruptCommitsInterruptedToolCards pins the reference interrupt flow:
// Esc only aborts and dismisses prompts; the event stream keeps being
// consumed, so the interrupted tool result completes its card and the
// loop_complete commit lands the partial text plus the interrupted card —
// with no "(response interrupted)" marker on the normal path.
func TestInterruptCommitsInterruptedToolCards(t *testing.T) {
	m := newChatModel(t)
	ch := make(chan agent.AgentEvent, 8)
	m.streaming = true
	m.agentCh = ch
	m.cancelStream = func() {}
	next, _ := m.handleAgentEvent(agent.StreamText{Text: "partial answer"})
	m = asModel(t, next)
	next, _ = m.handleAgentEvent(agent.ToolUseEvent{ToolID: "one", ToolName: "Bash", Args: map[string]any{"command": "sleep 10"}})
	m = asModel(t, next)

	m.interruptForeground()
	if len(m.chatMessages) != 0 {
		t.Fatalf("interrupt must not commit synchronously: %#v", m.chatMessages)
	}
	if !m.streaming {
		t.Fatal("interrupt must keep streaming until the loop settles")
	}

	next, _ = m.handleAgentEvent(agent.ToolResultEvent{ToolID: "one", ToolName: "Bash", Output: "Error: command interrupted", IsError: true})
	m = asModel(t, next)
	next, _ = m.handleAgentEvent(agent.LoopComplete{StopReason: "interrupted"})
	m = asModel(t, next)

	if m.streaming {
		t.Fatal("loop_complete must end streaming")
	}
	var assistant, summary int
	for _, msg := range m.chatMessages {
		if msg.role == "assistant" && msg.content == "partial answer" {
			assistant++
		}
		if msg.role == "turn_summary" && len(msg.toolGroup) == 1 && msg.toolGroup[0].toolID == "one" && msg.toolGroup[0].isError {
			summary++
		}
		if msg.content == "(response interrupted)" {
			t.Fatal("the normal interrupt path must not add the interrupted marker")
		}
	}
	if assistant != 1 || summary != 1 {
		t.Fatalf("expected the partial text and the interrupted card committed: %#v", m.chatMessages)
	}
}
