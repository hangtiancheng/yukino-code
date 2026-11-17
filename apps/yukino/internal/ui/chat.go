package ui

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/utils"
	"github.com/yukino-js/yukino/yukino/internal/version"
)

type chatMessage struct {
	role             string
	content          string
	markdown         bool
	thinkingDuration float64
	toolGroup        []toolBlockInfo
}

func (m Model) View() string {
	if !m.ready {
		return ""
	}

	var view string
	switch m.state {
	case stateProviderSelect:
		view = m.renderProviderSelectView()
	case stateChat:
		view = m.renderChatView()
	}
	return cursorFrame(view, m.width, m.height)
}

// renderActiveDialog mirrors the InteractionDock priority in
// src/ui/interaction-dock.tsx: the first active dialog replaces the composer.
func (m Model) renderActiveDialog() string {
	switch {
	case m.loginDialog:
		return m.renderLoginDialog()
	case m.providerDialog:
		return m.renderProviderDialog()
	case m.modelDialog:
		return m.renderModelDialog()
	case m.planApprovalDialog:
		return m.renderPlanApprovalDialog()
	case m.rewindDialog:
		return m.renderRewindDialog()
	case m.resumeDialog:
		return m.renderResumeDialog()
	case m.permDialog:
		return m.renderPermDialog()
	case m.askUserDialog:
		return m.renderAskUserDialog()
	case m.agentsDialog:
		return m.renderAgentsDialog()
	case m.workflowsDialog:
		return m.renderWorkflowsDialog()
	case m.thinkingDialog:
		return m.renderThinkingDialog()
	}
	return ""
}

func (m Model) renderChatView() string {
	footerRows, statusRows, dockRows := m.terminalBudgets()
	footer := m.renderFooter(footerRows)
	status := m.renderUIStatus(statusRows)
	dock := strings.TrimSuffix(m.renderActiveDialog(), "\n")
	if dock == "" {
		dock = m.renderComposer(dockRows)
	}
	dockLines := strings.Split(dock, "\n")
	if len(dockLines) > dockRows {
		dock = strings.Join(dockLines[:dockRows], "\n")
	}
	activityRows := max(0, dockRows-lineCount(dock))
	activity := strings.TrimSuffix(m.renderChatContent(), "\n")
	parts := []string{}
	if activity != "" && activityRows > 0 {
		lines := strings.Split(activity, "\n")
		parts = append(parts, strings.Join(lines[max(0, len(lines)-activityRows):], "\n"))
	}
	if m.height-1 >= 4 {
		parts = append(parts, "")
	}
	if status != "" {
		parts = append(parts, status)
	}
	parts = append(parts, dock)
	if footer != "" {
		parts = append(parts, footer)
	}
	return strings.Join(parts, "\n")
}

// renderTranscriptHeader mirrors the Static transcript header in
// src/ui/transcript.tsx; it is reprinted whenever the scrollback is reset
// (startup, /clear, rewind, resume).
func (m Model) renderTranscriptHeader() string {
	padding := 0
	if m.width > 2 {
		padding = 1
	}
	width := max(1, m.width-padding*2)
	hint := "/help · Esc interrupt"
	if m.width >= 80 {
		hint = "Esc interrupt · /commands · Ctrl+O details"
	} else if m.width >= 40 {
		hint = "/help · Esc interrupt · Ctrl+O details"
	}
	provider := ""
	model := ""
	if m.selectedProvider != nil {
		provider = m.selectedProvider.Name
		model = m.selectedProvider.Model
		if model == "" {
			model = provider
		}
	}
	pad := strings.Repeat(" ", padding)
	title := lipgloss.NewStyle().Foreground(accentColor).Render("✳ ") +
		lipgloss.NewStyle().Bold(true).Foreground(normalText).Render("Yukino") +
		lipgloss.NewStyle().Foreground(dimText).Render(" v"+version.Version)
	line2 := lipgloss.NewStyle().Foreground(mutedText).Render(truncateToWidth(hint, width, "…"))
	line3 := lipgloss.NewStyle().Foreground(dimText).Render(truncateToWidth(
		plainTerminalLine(fmt.Sprintf("%s/%s · %s", provider, model, utils.CompactPath(m.getWorkDir()))), width, "…"))
	return "\n" + pad + title + "\n" + pad + line2 + "\n" + pad + line3
}

func (m Model) renderMessage(msg chatMessage) string {
	columns := max(1, m.width)
	padding := boolColumn(columns > 2)
	width := columns - padding*2
	panel := func(text, background, foreground string) string {
		if background != "" {
			text = "\n" + text + "\n"
		}
		return "\n" + renderPanel(text, columns, padding, background, foreground)
	}
	switch msg.role {
	case "user":
		if skill, ok := skills.ParseSkillPrompt(msg.content); ok {
			action := "expand"
			if m.toolsExpanded {
				action = "collapse"
			}
			text := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(Theme.CustomMessageLabel)).Render("[skill]") +
				" " + plainTerminalLine(skill.Name) + " " + paint("(Ctrl+O to "+action+")", Theme.Muted)
			text = strings.Join(wrapTerminalTextOptions(text, width, true, false), "\n")
			if m.toolsExpanded {
				text += "\n" + paint(expandTabs(plainTerminalText(skill.Directory)), Theme.Muted) + "\n" + renderMarkdownText(skill.Body, width, "user", false)
			}
			result := panel(text, Theme.CustomMessageBg, Theme.CustomMessageText)
			if skill.Args != "" {
				args := strings.Join(wrapTerminalTextOptions(expandTabs(plainTerminalText(skill.Args)), width, true, false), "\n")
				result += "\n" + panel(args, Theme.UserMessageBg, Theme.UserMessageText)
			}
			return result
		}
		return panel(renderMarkdownText(msg.content, width, "user", false), Theme.UserMessageBg, Theme.UserMessageText)
	case "assistant":
		return panel(renderMarkdownText(msg.content, width, "assistant", false), "", Theme.Text)
	case "turn_summary":
		result := m.renderThinking(msg.content, msg.thinkingDuration, false)
		for _, tb := range msg.toolGroup {
			result += m.renderToolBlock(tb)
		}
		return result
	case "error":
		return panel(expandTabs(plainTerminalText("Error: "+msg.content)), "", Theme.Error)
	case "system":
		if msg.markdown {
			return panel(renderMarkdownText(msg.content, width, "assistant", false), "", Theme.Text)
		}
		color := Theme.Muted
		if strings.HasPrefix(msg.content, "Error:") || strings.HasPrefix(msg.content, "Hook error:") {
			color = Theme.Error
		}
		if strings.HasPrefix(msg.content, "Warning:") || strings.HasPrefix(msg.content, "Hook warning:") || strings.HasPrefix(msg.content, "↻") {
			color = Theme.Warning
		}
		if strings.HasPrefix(msg.content, "⊙ ") || strings.HasPrefix(msg.content, "Compact:") {
			text := strings.TrimPrefix(msg.content, "⊙ ")
			if strings.HasPrefix(text, "Compact:") {
				text = strings.TrimLeft(strings.TrimPrefix(text, "Compact:"), " \t\n")
			}
			return panel(lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(Theme.CustomMessageLabel)).Render("[compaction]")+"\n"+expandTabs(plainTerminalText(text)), Theme.CustomMessageBg, Theme.CustomMessageText)
		}
		text := msg.content
		if strings.HasPrefix(text, "↻") {
			text = "Retrying: " + strings.TrimSpace(strings.TrimPrefix(text, "↻"))
		}
		return panel(expandTabs(plainTerminalText(text)), "", color)
	}
	return ""
}

func (m Model) renderThinking(text string, duration float64, streaming bool) string {
	if strings.TrimSpace(text) == "" && duration == 0 {
		return ""
	}
	padding := boolColumn(m.width > 2)
	width := max(1, m.width-padding*2)
	label := "Thinking"
	if duration > 0 {
		label = fmt.Sprintf("Thinking %.1fs", duration)
	} else if streaming {
		label = "Thinking…"
	}
	collapsed := ""
	for _, candidate := range []string{label + " · Ctrl+O details", label + " · Ctrl+O", "Thinking · Ctrl+O"} {
		if visibleWidth(candidate) <= width {
			collapsed = candidate
			break
		}
	}
	if collapsed == "" {
		collapsed = truncateToWidth(label, width, "…") + "\nCtrl+O"
	}
	content := collapsed
	if m.toolsExpanded && strings.TrimSpace(text) != "" {
		content = renderMarkdownText(strings.TrimSpace(text), width, "thinking", false)
	}
	lines := wrapToLines(content, width)
	for i := range lines {
		lines[i] = truncateToWidth(lines[i], width, "…")
	}
	if streaming && m.toolsExpanded {
		limit := max(1, m.height/4)
		if len(lines) > limit {
			if limit == 1 {
				lines = []string{"…"}
			} else {
				lines = append([]string{"…"}, lines[len(lines)-(limit-1):]...)
			}
		}
	}
	content = lipgloss.NewStyle().Italic(true).Foreground(lipgloss.Color(Theme.ThinkingText)).Render(strings.Join(lines, "\n"))
	return "\n" + renderPanel(content, m.width, padding, "", Theme.ThinkingText)
}

func (m Model) renderChatContent() string {
	var sb strings.Builder
	for _, msg := range m.chatMessages[m.committedUpTo:] {
		sb.WriteString(m.renderMessage(msg))
		sb.WriteByte('\n')
	}
	if m.streaming {
		sb.WriteString(m.renderThinking(m.thinkingBuf, 0, true))
		if m.streamBuf != "" {
			padding := boolColumn(m.width > 2)
			sb.WriteString("\n" + renderPanel(renderStreamingMarkdown(m.streamBuf, max(1, m.width-padding*2), &m.streamMarkdownCache), m.width, padding, "", Theme.Text))
		}
	}
	if !m.askUserDialog {
		for _, tb := range m.toolBlocks {
			sb.WriteString(m.renderToolBlock(m.decorateTool(tb)))
			sb.WriteByte('\n')
		}
	}
	if m.userBashTool != nil {
		sb.WriteString(m.renderToolBlock(*m.userBashTool))
	}
	if m.activityError != "" {
		sb.WriteString(m.renderMessage(chatMessage{role: "error", content: m.activityError}))
	}
	return sb.String()
}

func (m Model) renderMessagesRange(from, to int) string {
	from = max(0, min(from, len(m.chatMessages)))
	to = max(from, min(to, len(m.chatMessages)))
	var sb strings.Builder
	for _, msg := range m.chatMessages[from:to] {
		sb.WriteString(m.renderMessage(msg))
		sb.WriteByte('\n')
	}
	return sb.String()
}

func (m Model) getModelName() string {
	if m.selectedProvider != nil {
		return m.selectedProvider.Model
	}
	if len(m.providers) > 0 {
		return m.providers[0].Model
	}
	return "unknown"
}

func (m Model) getWorkDir() string {
	wd, _ := os.Getwd()
	return wd
}
