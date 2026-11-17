package ui

import (
	"fmt"
	"math"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

func formatFooterTokens(value int) string {
	if value < 1000 {
		return fmt.Sprint(value)
	}
	if value < 1_000_000 {
		decimals := 1
		if value >= 10_000 {
			decimals = 0
		}
		factor := math.Pow10(decimals)
		rounded := math.Floor(float64(value)/1000*factor+0.5) / factor
		return fmt.Sprintf("%.*fk", decimals, rounded)
	}
	return fmt.Sprintf("%.1fM", float64(value)/1_000_000)
}
func locationLine(cwd, sessionID string, width int) string {
	path := utils.CompactPath(cwd)
	id := sessionID
	if visibleWidth(sessionID)+7 > width && len(id) > 8 {
		id = id[:8]
	}
	pathWidth := width - visibleWidth(id) - 3
	if id == "" || pathWidth < 4 {
		return truncateToWidth(path, width, "…")
	}
	display := truncateToWidth(path, pathWidth, "…")
	return display + strings.Repeat(" ", max(0, pathWidth-visibleWidth(display))) + " · " + id
}

type footerData struct {
	model, provider, mode, thinking, cwd, sessionID         string
	inputTokens, outputTokens, contextTokens, contextWindow int
}

func (m Model) renderFooter(rows int) string {
	data := footerData{mode: string(m.permissionMode), thinking: m.thinkingLevel(), cwd: m.getWorkDir(), sessionID: m.sessionID, inputTokens: m.totalInput, outputTokens: m.totalOutput, contextWindow: config.DefaultContextWindow}
	if m.selectedProvider != nil {
		data.model = m.selectedProvider.Model
		data.provider = m.selectedProvider.Name
		data.contextWindow = config.GetContextWindow(m.selectedProvider)
	}
	if m.ag != nil && m.ag.Checker != nil {
		data.mode = string(m.ag.Checker.Mode())
	}
	if m.conversation != nil {
		data.contextTokens = compact.CurrentContextTokens(m.conversation)
	}
	return renderFooter(data, m.width, rows)
}
func renderFooter(data footerData, columns, rows int) string {
	if rows <= 0 {
		return ""
	}
	padding := boolColumn(columns > 2)
	width := max(1, columns-padding*2)
	model, provider, mode := plainTerminalLine(data.model), plainTerminalLine(data.provider), plainTerminalLine(data.mode)
	displayMode := ModeDisplay[mode]
	if displayMode == "" {
		displayMode = mode
	}
	modeColor := dimText
	switch mode {
	case "acceptEdits":
		modeColor = greenText
	case "plan":
		modeColor = yellowText
	case "bypassPermissions":
		modeColor = redText
	}
	style := func(text string, color lipgloss.Color) string {
		return lipgloss.NewStyle().Foreground(color).Render(text)
	}
	percentage := 0.0
	if data.contextWindow > 0 {
		percentage = float64(data.contextTokens) / float64(data.contextWindow) * 100
	}
	contextColor := dimText
	if percentage >= 90 {
		contextColor = redText
	} else if percentage >= 70 {
		contextColor = yellowText
	}
	context := style(fmt.Sprintf("%.1f%%/%s", percentage, formatFooterTokens(data.contextWindow)), contextColor)
	stats := style("↑"+formatFooterTokens(data.inputTokens)+" ↓"+formatFooterTokens(data.outputTokens), dimText) + " " + context
	modeLabel := style(displayMode, modeColor)
	thinking := ""
	if level := data.thinking; level != "" {
		thinking = " · " + style(level, thinkingLevelColor(level))
	}
	fullModel := model
	if provider != "" {
		fullModel = provider + "/" + model
	}
	rightWidth := width - visibleWidth(stats) - 2
	separate := rightWidth < visibleWidth(displayMode)+visibleWidth(thinking)+5
	identityWidth := rightWidth - visibleWidth(displayMode) - 3
	if separate {
		identityWidth = width
	}
	modelWidth := max(1, identityWidth-visibleWidth(thinking))
	identityModel := fullModel
	if visibleWidth(fullModel) > modelWidth {
		identityModel = truncateToWidth(model, modelWidth, "…")
	}
	identity := style(identityModel, dimText) + thinking
	location := style(locationLine(plainTerminalLine(data.cwd), plainTerminalLine(data.sessionID), width), dimText)
	right := identity + " · " + modeLabel
	lines := []string{}
	if rows == 1 {
		lines = []string{modeLabel + " · " + identity}
	} else if separate {
		summary := stats
		if visibleWidth(stats+" "+displayMode) > width {
			summary = context
		}
		if visibleWidth(displayMode+" "+summary) > width {
			lines = []string{identity, modeLabel, context}
		} else {
			lines = []string{identity, modeLabel + " " + summary}
			if rows >= 3 {
				lines = append([]string{location}, lines...)
			}
		}
	} else {
		hint := "  Shift+Tab to cycle"
		if visibleWidth(stats+"  "+right+hint) > width {
			hint = ""
		}
		gap := max(2, width-visibleWidth(stats)-visibleWidth(right)-visibleWidth(hint))
		lines = []string{location, stats + strings.Repeat(" ", gap) + right + hint}
	}
	for i := range lines {
		lines[i] = strings.Repeat(" ", padding) + truncateToWidth(lines[i], width, "…")
	}
	return strings.Join(lines[:min(rows, len(lines))], "\n")
}
func (m Model) terminalBudgets() (footer, status, dock int) {
	rows := max(1, m.height-1)
	footerBudget := 0
	if rows >= 12 {
		footerBudget = 3
	} else if rows >= 5 {
		footerBudget = min(2, rows-3)
	}
	footer = lineCount(m.renderFooter(footerBudget))
	gap := boolColumn(rows >= 4)
	statusBudget := min(8, max(0, rows-footer-gap-3))
	if rows >= 10 {
		status = min(statusBudget, lineCount(m.renderUIStatus(statusBudget)))
	}
	dock = max(1, rows-footer-status-gap)
	return
}
func lineCount(text string) int {
	if text == "" {
		return 0
	}
	return strings.Count(strings.TrimSuffix(text, "\n"), "\n") + 1
}
func (m Model) renderUIStatus(rows int) string {
	lines := []string{}
	padding := strings.Repeat(" ", boolColumn(m.width > 2))
	width := max(1, m.width-len(padding)*2)
	if m.latestVersion != "" && !m.updateDismissed {
		lines = append(lines, padding+truncateToWidth(paint("New Yukino version v"+m.latestVersion+" is available. Run ", Theme.Warning)+ansiStyle(paint("yukino update", Theme.Accent), "\x1b[1m", "\x1b[22m"), width, "…"))
	}
	if len(m.pendingMessages)+len(m.steeringPending) > 0 {
		limit := min(3, max(1, rows-4))
		if m.height < 12 {
			limit = 1
		}
		steeringLimit := limit
		if len(m.pendingMessages) > 0 {
			steeringLimit = (limit + 1) / 2
		}
		steeringLimit = min(len(m.steeringPending), steeringLimit)
		followUpLimit := min(len(m.pendingMessages), limit-steeringLimit)
		for _, input := range m.steeringPending[len(m.steeringPending)-steeringLimit:] {
			lines = append(lines, padding+truncateToWidth("Steering: "+plainTerminalLine(input.Text), width, "…"))
		}
		for _, message := range m.pendingMessages[len(m.pendingMessages)-followUpLimit:] {
			lines = append(lines, padding+truncateToWidth("Follow-up: "+plainTerminalLine(message.text), width, "…"))
		}
		if total := len(m.pendingMessages) + len(m.steeringPending); total > limit {
			lines = append(lines, padding+fmt.Sprintf("%d queued messages", total))
		}
		hint := "↑ on empty input edits the latest queued message"
		if m.width >= 100 {
			hint = "Steering injects at the next turn boundary · Follow-up waits until the agent finishes · ↑ on empty input edits the latest"
		}
		lines = append(lines, padding+truncateToWidth(hint, width, "…"))
	}
	if !m.ctrlCDeadline.IsZero() {
		lines = append(lines, padding+truncateToWidth("Press Ctrl+C again to exit.", width, "…"))
	}
	todos, agents := m.renderTodoProgress(), m.renderAgentStatus()
	if todos != "" || agents != "" {
		if todos != "" && agents != "" {
			left := max(1, width-visibleWidth(agents)-2)
			todos = truncateToWidth(todos, left, "…")
			lines = append(lines, padding+todos+strings.Repeat(" ", max(2, width-visibleWidth(todos)-visibleWidth(agents)))+agents)
		} else {
			lines = append(lines, padding+todos+agents)
		}
	}
	for i := range lines {
		lines[i] = truncateToWidth(lines[i], max(1, m.width), "…")
	}
	for i := range lines {
		lines[i] = lipgloss.NewStyle().Foreground(dimText).Render(lines[i])
	}
	return strings.Join(lines[:min(max(0, rows), len(lines))], "\n")
}
