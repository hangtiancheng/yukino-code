package ui

import (
	"context"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
)

func newPermDialogModel(t *testing.T) (Model, chan agent.PermissionReply) {
	t.Helper()
	m := newChatModel(t)
	ch := make(chan agent.PermissionReply, 1)
	next, _ := m.handleAgentEvent(agent.PermissionRequestEvent{ToolName: "Bash", Desc: "rm -rf build", ResponseCh: ch})
	return asModel(t, next), ch
}
func pressKey(m Model, key tea.KeyMsg) Model { next, _ := m.handlePermDialog(key); return next.(Model) }
func TestPermissionOptionsRequireRememberScopes(t *testing.T) {
	m, ch := newPermDialogModel(t)
	if len(m.permissionOptions()) != 2 {
		t.Fatal("offered remember without a scope")
	}
	m = pressKey(m, tea.KeyMsg{Type: tea.KeyUp})
	m = pressKey(m, tea.KeyMsg{Type: tea.KeyEnter})
	if reply := <-ch; reply.Response != agent.PermDeny {
		t.Fatal(reply)
	}
	m, ch = newPermDialogModel(t)
	m.permissionCurrent.Decision = permissions.Decision{RememberPatterns: []string{"Bash(go test*)"}}
	if len(m.permissionOptions()) != 3 {
		t.Fatal("remember scope omitted")
	}
	m = pressKey(m, tea.KeyMsg{Type: tea.KeyDown})
	m = pressKey(m, tea.KeyMsg{Type: tea.KeyEnter})
	if reply := <-ch; reply.Response != agent.PermAllowAlways {
		t.Fatal(reply)
	}
}
func TestPermissionRequestsStayFIFOAndCancel(t *testing.T) {
	m, first := newPermDialogModel(t)
	second := make(chan agent.PermissionReply, 1)
	third := make(chan agent.PermissionReply, 1)
	ctx, cancel := context.WithCancel(context.Background())
	m.enqueuePermission(agent.PermissionRequestEvent{Context: ctx, ToolName: "second", ResponseCh: second})
	m.enqueuePermission(agent.PermissionRequestEvent{ToolName: "third", ResponseCh: third})
	if m.permToolName != "Bash" {
		t.Fatal("active request overwritten")
	}
	cancel()
	m = pressKey(m, tea.KeyMsg{Type: tea.KeyEnter})
	if (<-first).Response != agent.PermAllow || (<-second).Response != agent.PermDeny || m.permToolName != "third" {
		t.Fatal("FIFO/cancellation mismatch")
	}
	m.streaming = true
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	m = asModel(t, next)
	if m.permDialog || m.permRespCh != nil || (<-third).Response != agent.PermDeny {
		t.Fatal("interrupt left pending permission")
	}
}
func TestPermissionFrameShowsScopeAndKeepsFocusVisible(t *testing.T) {
	m, _ := newPermDialogModel(t)
	m.width = 40
	m.height = 12
	m.permissionCurrent.Decision.RememberPatterns = []string{"Bash(go test*)", "Bash(go vet*)"}
	m.permCursor = 2
	rendered := plainTerminalText(m.renderPermDialog())
	if !strings.Contains(rendered, "→ No") || !strings.Contains(rendered, "main: Bash requires approval") {
		t.Fatalf("focus/title missing: %q", rendered)
	}
	if strings.Contains(rendered, "what to do differently") {
		t.Fatal("obsolete feedback editor")
	}
}

func TestPermissionDialogShowsSourceAndArgs(t *testing.T) {
	m := newChatModel(t)
	ch := make(chan agent.PermissionReply, 1)
	next, _ := m.handleAgentEvent(agent.PermissionRequestEvent{AgentName: "plan", Cwd: "/tmp/project", ToolName: "Bash", Args: map[string]any{"command": "go test"}, Decision: permissions.Decision{Reason: "Approval required"}, Desc: "ignored", ResponseCh: ch})
	m = asModel(t, next)
	m.width = 80
	m.height = 24
	rendered := plainTerminalText(m.renderPermDialog())
	if !strings.Contains(rendered, "plan: Bash requires approval") || !strings.Contains(rendered, "/tmp/project") || !strings.Contains(rendered, "go test") {
		t.Fatalf("source/args missing: %q", rendered)
	}
}
