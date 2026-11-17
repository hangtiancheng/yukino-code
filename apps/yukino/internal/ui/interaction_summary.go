package ui

import (
	"strings"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func RenderInteractionSummary(summary bootstrap.InteractionSummary, columns int, color bool, endedAt time.Time) string {
	width := max(1, columns)
	padding := boolColumn(width > 2)
	contentWidth := width - padding*2
	rule := paint(strings.Repeat("─", width), Theme.BorderMuted)
	body := renderMarkdownText(bootstrap.FormatInteractionSummary(summary, float64(endedAt.UnixMilli())), contentWidth, "assistant", false)
	lines := []string{rule}
	for _, line := range strings.Split(body, "\n") {
		if line != "" {
			line = strings.Repeat(" ", padding) + line
		}
		lines = append(lines, line)
	}
	lines = append(lines, rule)
	if summary.LatestVersion != "" {
		notice := paint("New Yukino version v"+summary.LatestVersion+" is available. Run ", Theme.Warning) + ansiStyle(paint("yukino update", Theme.Accent), "\x1b[1m", "\x1b[22m")
		for _, line := range wrapWordsToLines(notice, contentWidth) {
			lines = append(lines, strings.Repeat(" ", padding)+line)
		}
	}
	output := strings.Join(lines, "\n")
	if !color {
		return plainTerminalText(output)
	}
	return output
}

func (m *Model) beginInteractionRun() {
	m.subagentCommand = false
	m.planApprovalDialog = false
	m.exitPlanSucceeded = false
	m.activityError = ""
	// The reference calls prepareSubagentTurn at every run entry; this is the
	// single Go turn-entry hook shared by all of them.
	m.prepareSubagentTurn()
	// Mirror the reference runAgentLoop prep: apply the current sandbox state to
	// the Bash tool, then gate the checker's sandbox flags on the runtime being
	// ready (auto-allow is only safe when the sandbox is actually available).
	bashTool, _ := m.registry.Get("Bash").(*tools.BashTool)
	sandboxReady := false
	if bashTool != nil {
		sandboxReady = m.configureBashSandbox(bashTool)
	}
	if m.ag != nil && m.ag.Checker != nil {
		m.ag.Checker.SandboxEnabled = m.sandboxEnabled && sandboxReady
		m.ag.Checker.SandboxAutoAllow = m.sandboxAutoAllow && sandboxReady
	}
	if m.agentStartedAt.IsZero() {
		m.agentStartedAt = time.Now()
	}
}
func (m *Model) endInteractionRun() {
	if !m.agentStartedAt.IsZero() {
		m.interactionStats.AgentActiveMs += float64(time.Since(m.agentStartedAt).Microseconds()) / 1000
		m.agentStartedAt = time.Time{}
	}
	if !m.toolBatchStartedAt.IsZero() {
		m.interactionStats.ToolTimeMs += float64(time.Since(m.toolBatchStartedAt).Microseconds()) / 1000
		m.toolBatchStartedAt = time.Time{}
	}
	m.activeToolIDs = nil
}
func (m *Model) recordInteractionEvent(event agent.AgentEvent) {
	if m.subagentCommand {
		return
	}
	switch e := event.(type) {
	case agent.ToolUseEvent:
		if len(m.activeToolIDs) == 0 {
			m.toolBatchStartedAt = time.Now()
		}
		if m.activeToolIDs == nil {
			m.activeToolIDs = map[string]bool{}
		}
		m.activeToolIDs[e.ToolID] = true
	case agent.ToolResultEvent:
		delete(m.activeToolIDs, e.ToolID)
		if len(m.activeToolIDs) == 0 && !m.toolBatchStartedAt.IsZero() {
			m.interactionStats.ToolTimeMs += float64(time.Since(m.toolBatchStartedAt).Microseconds()) / 1000
			m.toolBatchStartedAt = time.Time{}
		}
		if e.IsError {
			m.interactionStats.FailedToolCalls++
		} else {
			m.interactionStats.SuccessfulToolCalls++
		}
	}
}
func (m Model) InteractionSummary() bootstrap.InteractionSummary {
	summary := m.interactionStats
	summary.SessionID = m.sessionID
	summary.LatestVersion = m.latestVersion
	summary.InputTokens = float64(m.totalInput)
	summary.OutputTokens = float64(m.totalOutput)
	summary.CacheReadTokens = float64(m.totalCacheRead)
	summary.CacheCreationTokens = float64(m.totalCacheCreation)
	if !m.agentStartedAt.IsZero() {
		summary.AgentActiveMs += float64(time.Since(m.agentStartedAt).Microseconds()) / 1000
	}
	if !m.toolBatchStartedAt.IsZero() {
		summary.ToolTimeMs += float64(time.Since(m.toolBatchStartedAt).Microseconds()) / 1000
	}
	return summary
}
