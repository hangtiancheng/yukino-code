package ui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

var escKey = tea.KeyMsg{Type: tea.KeyEsc}

func newChatModel(t *testing.T) Model {
	t.Helper()
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", true)
	m.state = stateChat
	m.width = 80
	m.height = 24
	return m
}

func asModel(t *testing.T, tm tea.Model) Model {
	t.Helper()
	switch v := tm.(type) {
	case Model:
		return v
	case *Model:
		return *v
	}
	t.Fatalf("unexpected model type %T", tm)
	return Model{}
}

func pressEsc(t *testing.T, m Model) Model {
	t.Helper()
	updated, _ := m.Update(escKey)
	return asModel(t, updated)
}

func TestEscKeyName(t *testing.T) {
	if escKey.String() != "esc" {
		t.Fatalf("bubbletea reports Esc as %q, handlers must match it", escKey.String())
	}
}

func TestEscClosesAtMenu(t *testing.T) {
	m := newChatModel(t)
	m.atMenuOpen = true
	m.atMatches = []string{"a.go"}
	m = pressEsc(t, m)
	if m.atMenuOpen || m.atMatches != nil {
		t.Error("esc should close the @ file menu")
	}
}

func TestEscClosesSlashMenu(t *testing.T) {
	m := newChatModel(t)
	m.slashMenuOpen = true
	m.slashMatches = []*commands.Command{{Name: "clear"}}
	m = pressEsc(t, m)
	if m.slashMenuOpen || m.slashMatches != nil {
		t.Error("esc should close the slash command menu")
	}
}

func TestEscClosesPlanApprovalDialog(t *testing.T) {
	m := newChatModel(t)
	m.planApprovalDialog = true
	m = pressEsc(t, m)
	if m.planApprovalDialog {
		t.Error("esc should close the plan approval dialog")
	}
}

func TestEscCancelsAskUserDialog(t *testing.T) {
	for _, onSubmit := range []bool{false, true} {
		m := newChatModel(t)
		ch := make(chan tools.QuestionResponse, 1)
		m.enqueueAsk(tools.AskUserRequest{Questions: []tools.Question{{Text: "q?", Options: []tools.QuestionOption{{Label: "a"}, {Label: "b"}}}}, ResponseCh: ch})
		m.askUserOnSubmit = onSubmit
		m = pressEsc(t, m)
		if m.askUserDialog {
			t.Errorf("esc should close the ask-user dialog (onSubmit=%v)", onSubmit)
		}
		select {
		case resp := <-ch:
			if resp.Answers["_declined"] != "true" {
				t.Errorf("esc should decline, got %+v", resp.Answers)
			}
		default:
			t.Errorf("esc should answer the pending question (onSubmit=%v)", onSubmit)
		}
	}
}

func TestEscClosesRewindDialog(t *testing.T) {
	m := newChatModel(t)
	m.rewindDialog = true
	m.rewindPhase = 1
	m = pressEsc(t, m)
	if !m.rewindDialog || m.rewindPhase != 0 {
		t.Error("esc in phase 1 should go back to the snapshot list")
	}
	m = pressEsc(t, m)
	if m.rewindDialog {
		t.Error("esc in phase 0 should close the rewind dialog")
	}
}

func TestEscLeavesResumeList(t *testing.T) {
	m := newChatModel(t)
	m.resumeDialog = true
	m = pressEsc(t, m)
	if m.resumeDialog {
		t.Error("esc should close the resume dialog")
	}
}

func TestEscCancelsForegroundWithoutBackgrounding(t *testing.T) {
	m := newChatModel(t)
	ch := make(chan agent.AgentEvent)
	close(ch)
	cancelled := false
	m.streaming = true
	m.agentCh = ch
	m.cancelStream = func() { cancelled = true }
	m = pressEsc(t, m)
	if !cancelled {
		t.Fatal("escape did not cancel the stream")
	}
	// Mirrors the reference: the run stays streaming until the loop settles;
	// the pending listener then delivers the channel close.
	if !m.streaming || m.agentCh == nil {
		t.Fatal("escape must keep consuming until the loop settles")
	}
	msg := m.listenForAgentEvents()()
	updated, _ := m.Update(msg)
	m = asModel(t, updated)
	if m.streaming || m.agentCh != nil {
		t.Fatal("the settled channel must end streaming")
	}
}
