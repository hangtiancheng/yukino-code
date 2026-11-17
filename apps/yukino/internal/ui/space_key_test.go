package ui

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func TestSpaceKeyInComposerAndDialogFields(t *testing.T) {
	for _, space := range []tea.KeyMsg{
		{Type: tea.KeySpace, Runes: []rune{' '}},
		{Type: tea.KeySpace},
		{Type: tea.KeyRunes, Runes: []rune{' '}},
	} {
		m := newChatModel(t)
		m.editor.SetValue("helloworld")
		m.editor.col = 5
		next, _ := m.Update(space)
		m = asModel(t, next)
		if got := m.editor.Value(); got != "hello world" || m.editor.col != 6 {
			t.Fatalf("composer lost space: %q, col %d", got, m.editor.col)
		}
		editor := newInputEditor()
		editor.SetValue("hello")
		editTextField(&editor, space, true)
		editTextField(&editor, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("world")}, true)
		if got := editor.Value(); got != "hello world" {
			t.Fatalf("dialog lost space: %q", got)
		}
		if got := updateSelectorQuery("hello", space); got != "hello " {
			t.Fatalf("selector lost space: %q", got)
		}
	}
}

type rawInputProbe struct{ model Model }

func (p rawInputProbe) Init() tea.Cmd { return nil }
func (p rawInputProbe) View() string  { return "" }
func (p rawInputProbe) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok && key.Type == tea.KeyEnter {
		return p, tea.Quit
	}
	model, cmd := p.model.Update(msg)
	p.model = model.(Model)
	return p, cmd
}
func TestTerminalDecodedSpacesReachComposer(t *testing.T) {
	m := newChatModel(t)
	input, writer := io.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	program := tea.NewProgram(rawInputProbe{m}, tea.WithContext(ctx), tea.WithInput(input), tea.WithOutput(io.Discard), tea.WithoutRenderer(), tea.WithoutSignalHandler(), tea.WithoutCatchPanics())
	go func() {
		defer writer.Close()
		for _, chunk := range []string{"hello", " ", "world", " ", " ", "中文", "\r"} {
			if _, err := io.WriteString(writer, chunk); err != nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	result, err := program.Run()
	if err != nil {
		t.Fatal(err)
	}
	got := result.(rawInputProbe).model.editor.Value()
	if got != "hello world  中文" {
		t.Fatalf("decoded terminal input lost spaces: %q", got)
	}
	if strings.TrimSpace(got) == "" {
		t.Fatal("empty draft")
	}
}
