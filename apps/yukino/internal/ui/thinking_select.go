package ui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/llm"
)

func (m Model) openThinkingDialog() (tea.Model, tea.Cmd) {
	control, ok := m.client.(llm.ThinkingLevelControl)
	if !ok {
		return m, nil
	}
	m.thinkingDialog = true
	m.thinkingLevels = append([]string(nil), control.GetSupportedThinkingLevels()...)
	m.thinkingCursor = 0
	for i, level := range m.thinkingLevels {
		if level == m.thinkingLevel() {
			m.thinkingCursor = i
		}
	}
	return m, nil
}
func (m Model) handleThinkingDialog(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "esc":
		m.thinkingDialog = false
	case "up", "left", "down", "right":
		if len(m.thinkingLevels) > 0 {
			direction := 1
			if key.String() == "up" || key.String() == "left" {
				direction = -1
			}
			m.thinkingCursor = (m.thinkingCursor + direction + len(m.thinkingLevels)) % len(m.thinkingLevels)
		}
	case "enter":
		if len(m.thinkingLevels) > 0 {
			level := m.thinkingLevels[m.thinkingCursor]
			// The reference dialog closes and replays the selection through
			// handleSlashCommand(`/thinking ${level}`).
			m.thinkingDialog = false
			return m.executeCommand("/thinking "+level, nil)
		}
	}
	return m, nil
}
func (m Model) renderThinkingDialog() string {
	rows := m.dialogAvailableRows()
	width := max(1, m.width-boolColumn(m.width > 2)*2)
	count := max(0, min(len(m.thinkingLevels), rows-selectorChrome(rows, true).height))
	start := getListWindowStart(len(m.thinkingLevels), m.thinkingCursor, count)
	subtitle := "No levels available"
	if len(m.thinkingLevels) > 0 {
		subtitle = ThinkingDescriptions[m.thinkingLevels[m.thinkingCursor]]
	}
	var lines []string
	if count == 0 && len(m.thinkingLevels) > 0 {
		lines = append(lines, paint(truncateToWidth(TerminalTooShort, width, "…"), Theme.Muted))
	}
	for i := start; i < min(len(m.thinkingLevels), start+count); i++ {
		level := m.thinkingLevels[i]
		focused := i == m.thinkingCursor
		pointer := ""
		if width > 2 {
			pointer = "  "
			if focused {
				pointer = Icons.Arrow + " "
			}
		}
		marker := ""
		if level == m.thinkingLevel() && width >= len(level)+4 {
			marker = " " + Icons.Success
		}
		labelWidth := max(0, width-visibleWidth(pointer+marker))
		descriptionWidth := labelWidth - visibleWidth(level) - 2
		label := truncateToWidth(level, labelWidth, "…")
		if focused {
			label = ansiStyle(label, "\x1b[1m", "\x1b[22m")
		}
		line := paint(pointer, Theme.Accent) + paint(label, string(thinkingLevelColor(level))) + paint(marker, Theme.Success)
		if descriptionWidth >= 12 {
			line += paint("  "+truncateToWidth(ThinkingDescriptions[level], descriptionWidth, "…"), Theme.Muted)
		}
		if focused {
			line = lipgloss.NewStyle().Background(lipgloss.Color(Theme.SelectedBg)).Width(width).Render(line)
		}
		lines = append(lines, line)
	}
	return m.renderSelectorFrame(selectorFrameParams{title: "Thinking level", subtitle: subtitle, hint: "↑↓/←→ navigate · Enter select · Esc cancel", content: strings.Join(lines, "\n"), width: m.width, rows: rows, scrollKey: "thinking"})
}
