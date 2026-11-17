package ui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/plan_file"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
)

// planApprovalOptions mirrors PLAN_APPROVAL_OPTIONS in src/ui/constants.ts.
var planApprovalOptions = []string{
	"Yes, enter YOLO mode (auto-approve all)",
	"Yes, manually approve edits",
	"Tell Yukino what to change",
}

func (m Model) handlePlanApproval(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Feedback mode: the TextField owns the keyboard, exactly like the
	// reference's useInput({ isActive: cursor !== 2 }) split.
	if m.planApprovalCursor == 2 {
		m.planApprovalEditor.SetWidth(max(1, m.width-6))
		action := editTextField(&m.planApprovalEditor, msg, true)
		// Reference onChange: a non-empty draft clears the required error.
		if strings.TrimSpace(m.planApprovalEditor.Value()) != "" {
			m.planFeedbackRequired = false
		}
		switch action {
		case "escape":
			// TextField onEscape approves with manual confirmation.
			m.planApprovalCursor = 1
			return m.executePlanApproval()
		case "submit", "backtab":
			// Enter submits; Shift+Tab submits via onTab(value, shift).
			return m.sendPlanFeedback(m.planApprovalEditor.Value())
		case "up-boundary":
			// onBoundary(-1) returns to the option list.
			m.planApprovalCursor = 1
		}
		return m, nil
	}
	switch msg.String() {
	case "up", "k":
		if m.planApprovalCursor > 0 {
			m.planApprovalCursor--
		}
		return m, nil
	case "down", "j":
		if m.planApprovalCursor < len(planApprovalOptions)-1 {
			m.planApprovalCursor++
		}
		return m, nil
	case "enter":
		return m.executePlanApproval()
	case "shift+tab":
		return m, nil
	case "esc":
		// Escape defaults to the middle ground: approve the plan, but keep
		// confirming every edit. It does not cancel the approval.
		m.planApprovalCursor = 1
		return m.executePlanApproval()
	}
	return m, nil
}

// executePlanApproval mirrors the reference handlePlanApproval yolo/manual
// branches: exit plan mode into the chosen mode, add the exit reminder, and
// submit the plan execution prompt when the plan file has content.
func (m Model) executePlanApproval() (tea.Model, tea.Cmd) {
	m.planApprovalDialog = false
	if m.ag == nil || m.ag.Checker == nil {
		return m, nil
	}
	checker := m.ag.Checker
	planPath, _ := plan_file.GetOrCreatePlanPath(checker)
	planContent, _ := plan_file.LoadPlan(checker)
	mode, message := permissions.ModeDefault, "Plan approved. Each edit requires confirmation."
	if m.planApprovalCursor == 0 {
		mode, message = permissions.ModeBypass, "Plan approved. Entered YOLO mode."
	}
	checker.ExitPlanMode(mode)
	m.conversation.AddSystemReminder(prompt.BuildPlanModeExitReminder(planPath, planContent != ""))
	m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: message})
	if planContent == "" {
		return m, nil
	}
	return m.sendMessage("Execute this plan:\n\n"+planContent, nil)
}

// sendPlanFeedback mirrors the reference feedback branch: a blank draft keeps
// the dialog open with the required error; a non-empty draft stays in plan
// mode and submits the feedback as the next user turn.
func (m Model) sendPlanFeedback(feedback string) (tea.Model, tea.Cmd) {
	feedback = strings.TrimSpace(feedback)
	if feedback == "" {
		m.planFeedbackRequired = true
		return m, nil
	}
	m.planApprovalDialog = false
	m.planApprovalEditor = newInputEditor()
	m.planFeedbackRequired = false
	return m.sendMessage(feedback, nil)
}

// renderPlanApprovalDialog mirrors PlanApprovalDialog: the shared selector
// chrome (title/subtitle/hint), the three options with the arrow + selected
// background, and — in feedback mode — the TextField with the required error
// underneath.
func (m Model) renderPlanApprovalDialog() string {
	width := max(1, m.width-boolColumn(m.width > 2)*2)
	var lines []string
	focus := m.planApprovalCursor
	focusHeight := 1
	for i, option := range planApprovalOptions {
		if width <= 2 {
			continue
		}
		prefix, color := "  ", Theme.Muted
		if i == m.planApprovalCursor {
			prefix, color = Icons.Arrow+" ", Theme.Accent
		}
		line := " " + paint(truncateToWidth(prefix+option, max(0, width-2), "…"), color)
		if i == m.planApprovalCursor {
			line = lipgloss.NewStyle().Background(lipgloss.Color(Theme.SelectedBg)).Width(width).Render(line)
		}
		lines = append(lines, line)
	}
	if m.planApprovalCursor == 2 && width > 2 {
		text, row := m.renderTextField(m.planApprovalEditor, 1, "")
		focus = len(lines) + row
		fieldLines := strings.Split(text, "\n")
		focusHeight = len(fieldLines)
		lines = append(lines, fieldLines...)
		if m.planFeedbackRequired {
			focusHeight++
			lines = append(lines, " "+paint("Feedback is required.", Theme.Error))
		}
	}
	return m.renderSelectorFrame(selectorFrameParams{
		title:       "Plan complete",
		subtitle:    "Yukino has written a plan and is ready to execute.",
		hint:        "↑↓ navigate · Enter select · Shift+Tab submit feedback · Esc approve with manual confirmation",
		content:     strings.Join(lines, "\n"),
		width:       m.width,
		rows:        m.dialogAvailableRows(),
		focusRow:    focus,
		focusHeight: focusHeight,
	})
}
