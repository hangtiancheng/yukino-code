package ui

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/yukino-js/yukino/yukino/internal/vscode"
)

type ideConnectedMsg struct {
	connection *vscode.IdeConnection
	cancel     context.CancelFunc
}

type ideAtMentionMsg struct {
	mention vscode.IdeAtMention
}

// connectIde mirrors the useIdeInput effect: detect and connect the IDE
// extension in the background and deliver at-mentions to the input.
func (m Model) connectIde() tea.Cmd {
	ch := m.ideMentionCh
	if ch == nil {
		return nil
	}
	wd, _ := os.Getwd()
	return func() tea.Msg {
		ctx, cancel := context.WithCancel(context.Background())
		connection, err := vscode.ConnectToIde(ctx, vscode.ConnectToIdeOptions{
			Cwd: wd,
			OnAtMentioned: func(mention vscode.IdeAtMention) {
				select {
				case ch <- mention:
				case <-ctx.Done():
				}
			},
		})
		if err != nil || connection == nil {
			cancel()
			return nil
		}
		return ideConnectedMsg{connection: connection, cancel: cancel}
	}
}

func (m Model) listenForIdeMentions() tea.Cmd {
	ch := m.ideMentionCh
	if ch == nil {
		return nil
	}
	return func() tea.Msg {
		mention, ok := <-ch
		if !ok {
			return nil
		}
		return ideAtMentionMsg{mention: mention}
	}
}

// ideMentionText builds the insertion text for an at-mention, mirroring the
// reference relative-path + #L<start>-<end> format.
func ideMentionText(cwd string, mention vscode.IdeAtMention) string {
	shown := mention.FilePath
	if rel, err := filepath.Rel(cwd, mention.FilePath); err == nil && rel != "" && !strings.HasPrefix(rel, "..") {
		shown = rel
	}
	text := "@" + shown
	if mention.LineStart != nil {
		text += "#L" + strconv.Itoa(*mention.LineStart)
		if mention.LineEnd != nil && *mention.LineEnd != *mention.LineStart {
			text += "-" + strconv.Itoa(*mention.LineEnd)
		}
	}
	return text + " "
}
