package ui

import (
	"fmt"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func (m Model) askAllAnswered() bool { return len(m.askUserAnswered) == len(m.askUserQuestions) }
func (m Model) askHideSubmit() bool {
	return len(m.askUserQuestions) == 1 && !m.askUserQuestions[0].MultiSelect
}
func (m *Model) toggleAskOption(index int) {
	q := m.askUserQIdx
	selected := m.askUserSelected[q]
	selected[index] = !selected[index]
	order := m.askUserSelectionOrder[q]
	if selected[index] {
		order = append(order, index)
	} else {
		for i, value := range order {
			if value == index {
				order = append(order[:i], order[i+1:]...)
				break
			}
		}
	}
	m.askUserSelectionOrder[q] = order
}
func (m Model) selectedAskLabels() []string {
	var result []string
	for _, index := range m.askUserSelectionOrder[m.askUserQIdx] {
		result = append(result, m.askUserQuestions[m.askUserQIdx].Options[index].Label)
	}
	return result
}
func (m *Model) commitAskAnswer(answer string) (tea.Model, tea.Cmd) {
	m.askUserAnswered[m.askUserQIdx] = answer
	m.askUserOtherMode[m.askUserQIdx] = false
	if m.askHideSubmit() {
		return m.submitAllAnswers()
	}
	if m.askUserQIdx < len(m.askUserQuestions)-1 {
		m.askUserQIdx++
	} else {
		m.askUserOnSubmit = true
	}
	return m, nil
}
func (m Model) handleAskUserDialog(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(m.askUserQuestions) == 0 {
		return m.cancelAskUser()
	}
	name := key.String()
	if !m.askUserOnSubmit && m.askUserOtherMode[m.askUserQIdx] {
		m.askUserTextEditor.SetWidth(max(1, m.width-11))
		action := editTextField(&m.askUserTextEditor, key, true)
		m.askUserOther[m.askUserQIdx] = m.askUserTextEditor.Value()
		switch action {
		case "escape":
			m.askUserOtherMode[m.askUserQIdx] = false
		case "submit":
			parts := m.selectedAskLabels()
			if other := strings.TrimSpace(m.askUserTextEditor.Value()); other != "" {
				parts = append(parts, other)
			}
			answer := strings.Join(parts, ", ")
			if answer == "" {
				answer = "(no answer)"
			}
			return m.commitAskAnswer(answer)
		}
		return m, nil
	}
	if name == "esc" {
		return m.cancelAskUser()
	}
	if !m.askHideSubmit() {
		switch name {
		case "left", "shift+tab":
			if m.askUserOnSubmit {
				m.askUserOnSubmit = false
				m.askUserQIdx = len(m.askUserQuestions) - 1
			} else {
				m.askUserQIdx = max(0, m.askUserQIdx-1)
			}
			return m, nil
		case "right", "tab":
			if !m.askUserOnSubmit {
				if m.askUserQIdx < len(m.askUserQuestions)-1 {
					m.askUserQIdx++
				} else {
					m.askUserOnSubmit = true
				}
			}
			return m, nil
		}
	}
	if m.askUserOnSubmit {
		switch name {
		case "up":
			m.askUserSubmitIdx = 0
		case "down":
			m.askUserSubmitIdx = 1
		case "enter":
			if m.askUserSubmitIdx == 1 {
				return m.cancelAskUser()
			}
			if m.askAllAnswered() {
				return m.submitAllAnswers()
			}
		}
		return m, nil
	}
	q := m.askUserQuestions[m.askUserQIdx]
	count := len(q.Options) + 1
	cursor := m.askUserCursors[m.askUserQIdx]
	if key.Type == tea.KeyRunes && !key.Alt {
		digits := string(key.Runes)
		number := 0
		for _, r := range digits {
			if r < '0' || r > '9' {
				break
			}
			number = number*10 + int(r-'0')
		}
		if number >= 1 && number <= count {
			m.askUserCursors[m.askUserQIdx] = number - 1
			if number == count {
				return m, nil
			}
			if q.MultiSelect {
				m.toggleAskOption(number - 1)
				return m, nil
			}
			return m.commitAskAnswer(q.Options[number-1].Label)
		}
	}
	switch name {
	case "up":
		m.askUserCursors[m.askUserQIdx] = (cursor + count - 1) % count
	case "down":
		m.askUserCursors[m.askUserQIdx] = (cursor + 1) % count
	case " ":
		if q.MultiSelect && cursor < len(q.Options) {
			m.toggleAskOption(cursor)
		}
	case "enter":
		if cursor == len(q.Options) {
			m.askUserOtherMode[m.askUserQIdx] = true
			m.askUserTextEditor = newInputEditor()
			m.askUserTextEditor.SetValue(m.askUserOther[m.askUserQIdx])
			return m, nil
		}
		if q.MultiSelect {
			labels := m.selectedAskLabels()
			if len(labels) == 0 {
				labels = []string{q.Options[cursor].Label}
			}
			return m.commitAskAnswer(strings.Join(labels, ", "))
		}
		return m.commitAskAnswer(q.Options[cursor].Label)
	}
	return m, nil
}
func (m *Model) submitAllAnswers() (tea.Model, tea.Cmd) {
	answers := make(map[string]string, len(m.askUserQuestions))
	for i, q := range m.askUserQuestions {
		answers[q.Text] = m.askUserAnswered[i]
	}
	m.answerAsk(tools.QuestionResponse{Answers: answers})
	return m, nil
}
func (m *Model) cancelAskUser() (tea.Model, tea.Cmd) {
	m.answerAsk(tools.QuestionResponse{Answers: map[string]string{"_declined": "true"}})
	return m, nil
}
func (m Model) renderAskNav() string {
	total := len(m.askUserQuestions) + boolColumn(!m.askHideSubmit())
	index := m.askUserQIdx
	if m.askUserOnSubmit {
		index = len(m.askUserQuestions)
	}
	labels := make([]string, len(m.askUserQuestions))
	for i := range labels {
		labels[i] = fmt.Sprintf("Q%d", i+1)
	}
	if visibleWidth(strings.Join(labels, "  "))+len(labels)*5+16 > m.width-2 {
		label := "✓ Submit"
		if index < len(labels) {
			check := "☐"
			if _, ok := m.askUserAnswered[index]; ok {
				check = "☑"
			}
			label = check + " " + labels[index]
		}
		return paint(truncateToWidth(fmt.Sprintf("← %d/%d · %s →", index+1, total, label), max(1, m.width-2), "…"), Theme.Accent)
	}
	// The edge arrows dim out when there is nothing beyond them.
	leftColor, rightColor := Theme.Text, Theme.Text
	if index == 0 {
		leftColor = Theme.Dim
	}
	if index >= total-1 {
		rightColor = Theme.Dim
	}
	result := paint(" ← ", leftColor)
	for i, label := range labels {
		color, check := Theme.Dim, "☐"
		if _, ok := m.askUserAnswered[i]; ok {
			color, check = Theme.Success, "☑"
		}
		text := " " + check + " " + label + " "
		if i == index {
			text = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(Theme.Text)).Background(lipgloss.Color(Theme.SelectedBg)).Render(text)
		} else {
			text = paint(text, color)
		}
		result += text
	}
	if !m.askHideSubmit() {
		text := " ✓ Submit "
		if index == len(labels) {
			text = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(Theme.Text)).Background(lipgloss.Color(Theme.SelectedBg)).Render(text)
		} else {
			text = paint(text, Theme.Dim)
		}
		result += text
	}
	return result + paint(" → ", rightColor) + "\n"
}
func (m Model) renderAskUserDialog() string {
	if !m.askUserDialog || len(m.askUserQuestions) == 0 {
		return ""
	}
	lines := strings.Split(m.renderAskNav(), "\n")
	focus := 0
	focusHeight := 1
	hint := "Esc to cancel"
	if m.askUserOnSubmit {
		lines = append(lines, ansiStyle(" Review your answers", "\x1b[1m", "\x1b[22m"), " ")
		if !m.askAllAnswered() {
			lines = append(lines, paint("   Warning: You have not answered all questions", Theme.Warning))
		}
		for i, q := range m.askUserQuestions {
			lines = append(lines, paint("   • ", Theme.Dim)+plainTerminalText(q.Text))
			answer, ok := m.askUserAnswered[i]
			color := Theme.Success
			if !ok {
				answer = "(not answered)"
				color = Theme.Dim
			}
			lines = append(lines, paint("     → "+plainTerminalText(answer), color))
		}
		lines = append(lines, " ")
		if m.askAllAnswered() {
			lines = append(lines, paint(" Ready to submit your answers?", Theme.Muted), " ")
			focus = len(lines) + m.askUserSubmitIdx
			for i, label := range []string{"Submit answers", "Cancel"} {
				pointer, color := " ", Theme.Dim
				if i == m.askUserSubmitIdx {
					pointer, color = Icons.Arrow, Theme.Accent
				}
				text := " " + label
				if i == m.askUserSubmitIdx {
					text = ansiStyle(text, "\x1b[1m", "\x1b[22m")
				}
				lines = append(lines, " "+paint(pointer, color)+paint(text, color))
			}
		}
	} else {
		q := m.askUserQuestions[m.askUserQIdx]
		cursor := m.askUserCursors[m.askUserQIdx]
		contentWidth := max(0, m.width-boolColumn(m.width > 2)*2-1)
		questionLines := wrapTerminalTextOptions(plainTerminalText(q.Text), max(1, contentWidth), true, false)
		for _, line := range questionLines {
			if contentWidth == 0 {
				line = ""
			} else {
				line = " " + ansiStyle(line, "\x1b[1m", "\x1b[22m")
			}
			lines = append(lines, line)
		}
		if q.MultiSelect {
			lines = append(lines, paint("   (Space to toggle · Enter to confirm)", Theme.Dim))
		}
		lines = append(lines, " ")
		maxIdxWidth := len(strconv.Itoa(len(q.Options) + 1))
		for i := 0; i <= len(q.Options); i++ {
			label, description := "Other (type your own)", ""
			labelColor, pointerColor := Theme.Dim, Theme.Dim
			if i < len(q.Options) {
				label = q.Options[i].Label
				description = q.Options[i].Description
				labelColor = Theme.Muted
				if m.askUserAnswered[m.askUserQIdx] == label {
					labelColor = Theme.Success
				}
				if q.MultiSelect {
					marker := "☐ "
					if m.askUserSelected[m.askUserQIdx][i] {
						marker = "☑ "
					}
					label = marker + label
				}
			}
			pointer := " "
			if i == cursor {
				pointer, pointerColor, labelColor = Icons.Arrow, Theme.Accent, Theme.Accent
				focus = len(lines)
				if description != "" {
					focusHeight = 2
				}
			}
			if contentWidth > 0 {
				idx := strings.Repeat(" ", maxIdxWidth-len(strconv.Itoa(i+1))) + strconv.Itoa(i+1)
				line := paint(pointer, pointerColor) + paint(" "+idx+". ", Theme.Dim) + paint(plainTerminalLine(label), labelColor)
				lines = append(lines, " "+truncateToWidth(line, contentWidth, "…"))
			}
			if description != "" && contentWidth > maxIdxWidth+5 {
				lines = append(lines, strings.Repeat(" ", maxIdxWidth+6)+paint(truncateToWidth(plainTerminalLine(description), contentWidth-maxIdxWidth-5, "…"), Theme.Muted))
			}
			if i == cursor {
				focusHeight = max(1, len(lines)-focus)
			}
		}
		if m.askUserOtherMode[m.askUserQIdx] {
			text, row := m.renderTextField(m.askUserTextEditor, maxIdxWidth+6, Icons.Arrow+" ")
			focus = len(lines) + row
			lines = append(lines, strings.Split(text, "\n")...)
			hint = "Enter to confirm · Esc to return to options"
		} else {
			hint = "Enter to select · ↑/↓ to navigate · number keys answer directly"
			if len(m.askUserQuestions) > 1 {
				hint += " · ←/→ or Tab to switch questions"
			}
			hint += " · Esc to cancel"
		}
	}
	width := max(1, m.width-boolColumn(m.width > 2)*2)
	for i, line := range lines {
		lines[i] = truncateToWidth(line, width, "…")
	}
	return m.renderSelectorFrame(selectorFrameParams{title: "Answer questions", hint: hint, content: strings.Join(lines, "\n"), width: m.width, rows: m.dialogAvailableRows(), focusRow: focus, focusHeight: focusHeight, scrollKey: "ask"})
}
