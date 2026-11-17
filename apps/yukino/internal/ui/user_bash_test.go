package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestUserBashStoresHistoryAndExcludesDoubleBang(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, prefix := range []string{"!", "!!"} {
		t.Run(prefix, func(t *testing.T) {
			m := newChatModel(t)
			m.sessionID = session.NewID()
			m.editor.SetValue(prefix + " printf 'hello world'")
			next, cmd := m.submitInput(m.editor.Value())
			m = asModel(t, next)
			if cmd == nil || m.userBash == nil || m.editor.Value() != "" {
				t.Fatal("Bash command was not accepted")
			}
			next, _ = m.Update(cmd())
			m = asModel(t, next)
			if m.userBash != nil || len(m.chatMessages) != 1 || !strings.Contains(m.chatMessages[0].toolGroup[0].output, "hello world") {
				t.Fatalf("missing Bash result: %#v", m.chatMessages)
			}
			saved, _ := session.LoadSession(m.getWorkDir(), m.sessionID)
			if len(saved) != 1 || saved[0].UserBash == nil || saved[0].UserInput == nil {
				t.Fatalf("Bash history not persisted: %#v", saved)
			}
			if saved[0].UserBash.ExcludeFromContext != (prefix == "!!") {
				t.Fatal("incorrect exclusion")
			}
			if got := len(m.conversation.GetMessages()); got != boolColumn(prefix == "!") {
				t.Fatalf("context got %d messages for %s", got, prefix)
			}
		})
	}
}
func TestUserBashWarningPreservesDraftAndRunningCommand(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)
	m.sessionID = session.NewID()
	m.editor.SetValue("!!")
	next, cmd := m.submitInput("!!")
	m = asModel(t, next)
	if m.userBash != nil || m.editor.Value() != "!!" || !strings.Contains(m.chatMessages[0].content, "after !!.") {
		t.Fatal("empty command not rejected")
	}
	if cmd != nil {
		_ = cmd()
	}
	m.editor.SetValue("! printf done")
	next, cmd = m.submitInput(m.editor.Value())
	m = asModel(t, next)
	run := m.userBash
	m.editor.SetValue("! another")
	next, _ = m.submitInput(m.editor.Value())
	m = asModel(t, next)
	if m.userBash != run || m.editor.Value() != "! another" {
		t.Fatal("second command replaced active Bash")
	}
	next, _ = m.Update(cmd())
	m = asModel(t, next)
}
func TestUserBashDefersConversationMutationDuringAgentTurn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)
	m.sessionID = session.NewID()
	m.streaming = true
	next, cmd := m.submitInput("! printf deferred")
	m = asModel(t, next)
	next, _ = m.Update(cmd())
	m = asModel(t, next)
	if len(m.conversation.GetMessages()) != 0 || len(m.pendingBashRecords) != 1 {
		t.Fatal("Bash result changed an active agent conversation")
	}
	m.streaming = false
	m.flushUserBashRecords(true)
	if len(m.conversation.GetMessages()) != 1 || len(m.pendingBashRecords) != 0 {
		t.Fatal("Bash result did not flush after the turn")
	}
}
func TestAskUserOtherTextAndQueue(t *testing.T) {
	m := newChatModel(t)
	first, second := make(chan tools.QuestionResponse, 1), make(chan tools.QuestionResponse, 1)
	q := tools.Question{Text: "Choose", Options: []tools.QuestionOption{{Label: "a"}, {Label: "b"}}}
	m.enqueueAsk(tools.AskUserRequest{Questions: []tools.Question{q}, ResponseCh: first})
	m.enqueueAsk(tools.AskUserRequest{Questions: []tools.Question{q}, ResponseCh: second})
	keys := []tea.KeyMsg{{Type: tea.KeyUp}, {Type: tea.KeyEnter}, {Type: tea.KeyRunes, Runes: []rune("hello")}, {Type: tea.KeySpace}, {Type: tea.KeyRunes, Runes: []rune("world")}, {Type: tea.KeyEnter}}
	for _, key := range keys {
		next, _ := m.handleAskUserDialog(key)
		m = asModel(t, next)
	}
	if (<-first).Answers["Choose"] != "hello world" || m.askUserRespCh != second {
		t.Fatal("Other answer or FIFO lost")
	}
	m.denyAllInteractions()
	if len((<-second).Answers) != 0 {
		t.Fatal("canceled question did not receive empty answers")
	}
}
func TestAskUserNumericMultiSelectPreservesSelectionOrder(t *testing.T) {
	m := newChatModel(t)
	response := make(chan tools.QuestionResponse, 1)
	m.enqueueAsk(tools.AskUserRequest{Questions: []tools.Question{{Text: "Choose", MultiSelect: true, Options: []tools.QuestionOption{{Label: "a"}, {Label: "b"}}}}, ResponseCh: response})
	for _, key := range []tea.KeyMsg{{Type: tea.KeyRunes, Runes: []rune("2")}, {Type: tea.KeyRunes, Runes: []rune("1")}, {Type: tea.KeyEnter}, {Type: tea.KeyEnter}} {
		next, _ := m.handleAskUserDialog(key)
		m = asModel(t, next)
	}
	if got := (<-response).Answers["Choose"]; got != "b, a" {
		t.Fatalf("selection order changed: %q", got)
	}
}
