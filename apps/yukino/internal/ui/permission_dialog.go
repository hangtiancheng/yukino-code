package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

func (m Model) permissionOptions() []PermissionOption {
	var options []PermissionOption
	for _, option := range PermissionOptions {
		if option.Action == "allowAlways" && (m.permissionCurrent == nil || len(m.permissionCurrent.Decision.RememberPatterns) == 0) {
			continue
		}
		options = append(options, option)
	}
	return options
}

func (m Model) handlePermDialog(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	options := m.permissionOptions()
	switch msg.String() {
	case "up":
		m.permCursor = (m.permCursor + len(options) - 1) % len(options)
	case "down":
		m.permCursor = (m.permCursor + 1) % len(options)
	case "enter":
		response := agent.PermDeny
		switch options[m.permCursor].Action {
		case "allow":
			response = agent.PermAllow
		case "allowAlways":
			response = agent.PermAllowAlways
		}
		return m.replyPermission(agent.PermissionReply{Response: response})
	case "esc":
		return m.replyPermission(agent.PermissionReply{Response: agent.PermDeny})
	}
	return m, nil
}

func (m Model) replyPermission(reply agent.PermissionReply) (tea.Model, tea.Cmd) {
	if m.permRespCh != nil {
		select {
		case m.permRespCh <- reply:
		default:
		}
	}
	m.closePermDialog()
	m.presentNextPermission()
	return m, nil
}
func (m *Model) closePermDialog() {
	m.permDialog = false
	m.permCursor = 0
	m.permRespCh = nil
	m.permissionCurrent = nil
}
func (m Model) renderPermDialog() string {
	width := max(1, m.width-boolColumn(m.width > 2)*2)
	agentName := "main"
	cwd, summary, reason := "", "", m.permDesc
	var patterns []string
	if request := m.permissionCurrent; request != nil {
		if request.AgentName != "" {
			agentName = request.AgentName
		}
		cwd = request.Cwd
		summary = utils.FormatToolArgs(request.Args)
		if request.Decision.Reason != "" {
			reason = request.Decision.Reason
		}
		patterns = request.Decision.RememberPatterns
	}
	detail := strings.Join(nonEmpty(cwd, summary, reason), " · ")
	var lines []string
	for _, pattern := range patterns {
		lines = append(lines, wrapTerminalTextOptions("Remember scope: "+plainTerminalText(pattern), width, true, false)...)
	}
	focus := len(lines) + m.permCursor
	if width <= 2 {
		focus = max(0, len(lines)-1)
	}
	for i, option := range m.permissionOptions() {
		if width <= 2 {
			continue
		}
		prefix, color := "  ", Theme.Muted
		if i == m.permCursor {
			prefix, color = Icons.Arrow+" ", Theme.Accent
		}
		line := " " + paint(truncateToWidth(prefix+option.Label, max(0, width-2), "…"), color)
		if i == m.permCursor {
			line = lipgloss.NewStyle().Background(lipgloss.Color(Theme.SelectedBg)).Width(width).Render(line)
		}
		lines = append(lines, line)
	}
	return m.renderSelectorFrame(selectorFrameParams{title: fmt.Sprintf("%s: %s requires approval", agentName, m.permToolName), subtitle: truncateToWidth(detail, 160, "…"), hint: "↑↓ navigate · Enter select · Escape deny", content: strings.Join(lines, "\n"), width: m.width, rows: m.dialogAvailableRows(), focusRow: focus, scrollKey: "perm"})
}

func nextPermissionMode(current permissions.PermissionMode) permissions.PermissionMode {
	switch current {
	case permissions.ModeDefault:
		return permissions.ModeAcceptEdits
	case permissions.ModeAcceptEdits:
		return permissions.ModeBypass
	case permissions.ModePlan:
		return permissions.ModeDefault
	case permissions.ModeBypass:
		return permissions.ModeDefault
	default:
		return permissions.ModeDefault
	}
}

func permissionModeInfo(mode permissions.PermissionMode) (string, string) {
	switch mode {
	case permissions.ModeDefault:
		return "Default", "Writes and commands require approval."
	case permissions.ModeAcceptEdits:
		return "Accept Edits", "File edits auto-approved; commands still require approval."
	case permissions.ModePlan:
		return "Plan", "Read-only mode. No writes or commands executed."
	case permissions.ModeBypass:
		return "YOLO", "All tools auto-approved. Use with caution."
	default:
		return string(mode), ""
	}
}
