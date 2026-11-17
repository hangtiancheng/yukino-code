package ui

import (
	"fmt"
	"math"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tool_result"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type agentEventMsg struct {
	event agent.AgentEvent
	ch    <-chan agent.AgentEvent
}

type agentDoneMsg struct {
	ch <-chan agent.AgentEvent
}

type agentErrMsg struct{ err error }

type agentReadyMsg struct {
	ch <-chan agent.AgentEvent
}

type mcpReadyMsg struct {
	result                 mcp.ConnectResult
	mgr                    *mcp.Manager
	command, reload, empty bool
}

type compactDoneMsg struct {
	message string
	err     error
}

type forkSkillDoneMsg struct {
	name   string
	result string
	err    error
}

type askUserMsg struct {
	req tools.AskUserRequest
}

type subAgentProgressMsg struct {
	progress subagent.SubAgentProgress
}

func (m *Model) drainSubAgentProgress() {
	for {
		select {
		case p := <-m.subAgentProgressCh:
			m.applySubagentProgress(p)
		default:
			return
		}
	}
}

type outputFlushMsg struct{ generation int }

func (m *Model) scheduleOutputFlush() tea.Cmd {
	if m.flushScheduled {
		return nil
	}
	m.flushScheduled = true
	generation := m.outputGeneration
	return tea.Tick(50*time.Millisecond, func(time.Time) tea.Msg { return outputFlushMsg{generation} })
}

func (m *Model) prepareOutput() {
	m.outputGeneration++
	m.flushScheduled = false
	m.streamBuf = ""
	m.thinkingBuf = ""
	m.thinkingTextStart = time.Time{}
	m.thinkingDuration = 0
	m.toolBlocks = nil
	m.clearTurnSummary()
	for id, progress := range m.subagents {
		if progress.taskID == "" || progress.status != "running" {
			delete(m.subagents, id)
		}
	}
}

func (m *Model) commitOutput() {
	m.outputGeneration++
	m.flushScheduled = false
	if m.thinkingBuf != "" || m.thinkingDuration >= 1 {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "turn_summary", content: m.thinkingBuf, thinkingDuration: m.thinkingDuration})
	}
	if m.streamBuf != "" {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "assistant", content: m.streamBuf})
	}
	m.streamBuf = ""
	m.thinkingBuf = ""
	m.thinkingTextStart = time.Time{}
	m.thinkingDuration = 0
	var completed []toolBlockInfo
	completedIDs := map[string]bool{}
	var remaining []string
	for _, id := range m.turnSummaryOrder {
		if entry, ok := m.turnSummary[id]; ok {
			completed = append(completed, entry)
			completedIDs[id] = true
			delete(m.turnSummary, id)
		} else {
			remaining = append(remaining, id)
		}
	}
	m.turnSummaryOrder = remaining
	if len(completed) > 0 {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "turn_summary", toolGroup: completed})
		var pending []toolBlockInfo
		for _, tb := range m.toolBlocks {
			if !completedIDs[tb.toolID] {
				pending = append(pending, tb)
			}
		}
		m.toolBlocks = pending
	}
}

// clearTurnSummary mirrors turnToolCalls.clear() at turn boundaries.
func (m *Model) clearTurnSummary() {
	m.turnSummaryOrder = nil
	m.turnSummary = nil
}

// recordTurnSummary mirrors turnToolCalls.set(toolId, item): the entry is
// defined (last write wins), the id keeps its original insertion position,
// and orphan results append a new id on arrival.
func (m *Model) recordTurnSummary(block toolBlockInfo) {
	if m.turnSummary == nil {
		m.turnSummary = map[string]toolBlockInfo{}
	}
	if _, ok := m.turnSummary[block.toolID]; !ok {
		known := false
		for _, id := range m.turnSummaryOrder {
			if id == block.toolID {
				known = true
				break
			}
		}
		if !known {
			m.turnSummaryOrder = append(m.turnSummaryOrder, block.toolID)
		}
	}
	m.turnSummary[block.toolID] = block
}

// drainSteeringLeftovers mirrors the reference runAgentLoop finally: steering
// queued but never delivered is re-queued as follow-ups (and leaves the
// pending-steering display) once the run ends.
func (m *Model) drainSteeringLeftovers() {
	running := m.steeringAgent
	if running == nil {
		return
	}
	_, surfaced := running.RecallHints()
	paths := []string{}
	for path := range surfaced {
		paths = append(paths, path)
	}
	if m.ag != nil {
		m.ag.MarkMemoriesSurfaced(paths)
	}
	for _, message := range running.DrainSteering() {
		input := message.Input
		m.pendingMessages = append(m.pendingMessages, queuedMessage{text: message.Text, input: &input})
		m.removePendingSteering(input.ID)
	}
}

// agentCardDecoration mirrors the reference resolveAgentCard lookup: the
// subagent's terminal state decorates the committed card (an interrupted run
// renders as "stopped" instead of a green success card).
func (m *Model) agentCardDecoration(toolID string, isError bool) (string, string) {
	p := m.subagents[toolID]
	if p == nil || p.status == "running" {
		return "", ""
	}
	status := p.status
	if isError && status != "stopped" {
		status = "failed"
	}
	return status, fmt.Sprintf("%s subagent | %d turns", p.role, p.turns)
}

func (m *Model) commitStaticOutput() tea.Cmd {
	if m.committedUpTo >= len(m.chatMessages) {
		return nil
	}
	text := m.renderMessagesRange(m.committedUpTo, len(m.chatMessages))
	m.committedUpTo = len(m.chatMessages)
	if text == "" {
		return nil
	}
	return tea.Println(text)
}

func (m Model) listenForSubAgentProgress() tea.Cmd {
	ch := m.subAgentProgressCh
	if ch == nil {
		return nil
	}
	life := m.lifeCtx
	return func() tea.Msg {
		select {
		case p := <-ch:
			return subAgentProgressMsg{progress: p}
		case <-life.Done():
			return nil
		}
	}
}

func (m Model) listenForAskUser() tea.Cmd {
	ch := m.askUserCh
	if ch == nil {
		return nil
	}
	life := m.lifeCtx
	return func() tea.Msg {
		select {
		case req := <-ch:
			return askUserMsg{req: req}
		case <-life.Done():
			return nil
		}
	}
}

func (m Model) listenForAgentEvents() tea.Cmd {
	ch := m.agentCh
	if ch == nil {
		return nil
	}
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return agentDoneMsg{ch: ch}
		}
		return agentEventMsg{event: ev, ch: ch}
	}
}

func (m Model) handleAgentEvent(ev agent.AgentEvent) (tea.Model, tea.Cmd) {
	m.recordInteractionEvent(ev)
	switch ev.(type) {
	case agent.RetryEvent, agent.UsageEvent, agent.PermissionRequestEvent:
	default:
		m.retryStatus = ""
	}
	switch e := ev.(type) {
	case agent.StreamText:
		m.streamBuf += e.Text
		return m, tea.Batch(m.scheduleOutputFlush(), m.listenForAgentEvents())

	case agent.ThinkingText:
		if m.thinkingTextStart.IsZero() {
			m.thinkingTextStart = time.Now()
		}
		m.thinkingBuf += e.Text
		return m, tea.Batch(m.scheduleOutputFlush(), m.listenForAgentEvents())

	case agent.ThinkingComplete:
		if !m.thinkingTextStart.IsZero() {
			m.thinkingDuration = time.Since(m.thinkingTextStart).Seconds()
		}

	case agent.ToolUseEvent:
		m.toolBlocks = append(m.toolBlocks, toolBlockInfo{toolID: e.ToolID, toolName: e.ToolName, args: e.Args, loading: true})
		known := false
		for _, id := range m.turnSummaryOrder {
			if id == e.ToolID {
				known = true
				break
			}
		}
		if !known {
			m.turnSummaryOrder = append(m.turnSummaryOrder, e.ToolID)
		}

	case agent.ToolResultEvent:
		if m.ag != nil {
			m.ag.RecordRecentTool(e.ToolName)
		}
		if !e.IsError && (e.ToolName == "EnterPlanMode" || e.ToolName == "ExitPlanMode") {
			m.exitPlanSucceeded = true
		}
		if e.ToolName == "WriteFile" || e.ToolName == "EditFile" {
			m.fileFactsVersion++
		}
		m.drainSubAgentProgress()
		output := tool_result.ToDisplayPreview(e.Output)
		status, progress := m.agentCardDecoration(e.ToolID, e.IsError)
		matched := false
		for i := range m.toolBlocks {
			if m.toolBlocks[i].toolID == e.ToolID {
				tb := &m.toolBlocks[i]
				tb.output = output
				tb.isError = e.IsError
				tb.elapsed = e.Elapsed.Seconds()
				tb.loading = false
				if status != "" {
					tb.status = status
				}
				if progress != "" {
					tb.progress = progress
				}
				m.recordTurnSummary(*tb)
				matched = true
				break
			}
		}
		if !matched {
			// Orphan tool_result (no preceding tool_use): the reference keeps
			// it in turnToolCalls, so it lands in the committed turn_summary
			// while never entering the live viewport.
			m.recordTurnSummary(toolBlockInfo{toolID: e.ToolID, toolName: e.ToolName, output: output, isError: e.IsError, elapsed: e.Elapsed.Seconds(), status: status, progress: progress})
		}
		if e.ToolName == "AskUserQuestion" {
			m.commitOutput()
			cmd := m.commitStaticOutput()
			return m, tea.Batch(cmd, m.listenForAgentEvents())
		}

	case agent.TurnComplete:
		m.commitOutput()
		m.toolBlocks = nil
		m.clearTurnSummary()
		cmd := m.commitStaticOutput()
		return m, tea.Batch(cmd, m.listenForAgentEvents())

	case agent.UsageEvent:
		m.totalInput += e.InputTokens
		m.totalOutput += e.OutputTokens
		m.totalCacheRead += e.CacheReadTokens
		m.totalCacheCreation += e.CacheCreationTokens
	case agent.SteeringDelivered:
		m.deliverSteering(e)
		return m, tea.Batch(m.commitStaticOutput(), m.listenForAgentEvents())

	case agent.PermissionRequestEvent:
		m.enqueuePermission(e)

	case agent.CompactEvent:
		m.chatMessages = append(m.chatMessages, chatMessage{
			role:    "system",
			content: "⊙ " + e.Message,
		})

	case agent.RetryEvent:
		m.retryStatus = "Retrying"
		if e.Wait > 0 {
			// Math.round (half-up) in the reference, not Go's half-to-even %.0f.
			m.retryStatus += fmt.Sprintf(" (%ds delay)", int(math.Round(e.Wait.Seconds())))
		}
		m.retryStatus += ": " + e.Reason
		msg := "↻ " + e.Reason
		if e.Wait > 0 {
			msg += fmt.Sprintf(" (waiting %ds)", int(math.Round(e.Wait.Seconds())))
		}
		m.chatMessages = append(m.chatMessages, chatMessage{
			role:    "system",
			content: msg,
		})

	case agent.ErrorEvent:
		// Mirrors the reference error path (throw → finally → catch): drain
		// the steering leftovers first, then commit only the partial text —
		// thinking and uncommitted tool cards are dropped — and surface the
		// error message.
		m.activityError = e.Message
		m.drainSteeringLeftovers()
		m.outputGeneration++
		m.flushScheduled = false
		if m.streamBuf != "" {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "assistant", content: m.streamBuf})
		}
		m.streamBuf = ""
		m.thinkingBuf = ""
		m.thinkingTextStart = time.Time{}
		m.thinkingDuration = 0
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Error: " + e.Message})
		cmd := m.commitStaticOutput()
		m.toolBlocks = nil
		m.clearTurnSummary()
		m.finishStreaming()
		return m, cmd

	case agent.LoopComplete:
		m.commitOutput()
		m.toolBlocks = nil
		m.clearTurnSummary()
		// Mirrors the reference runAgentLoop finally: steering queued but
		// never delivered is re-queued as follow-ups once the loop ends
		// (including the interrupted stop reason).
		m.drainSteeringLeftovers()
		commitCmd := m.commitStaticOutput()
		m.finishStreaming()
		if (m.subagentCommand && e.PlanReady) || (m.ag != nil && m.ag.Checker != nil && m.ag.Checker.Mode() == permissions.ModePlan && m.exitPlanSucceeded) {
			m.planApprovalDialog = true
			m.planApprovalCursor = 0
			m.planApprovalEditor = newInputEditor()
			m.planFeedbackRequired = false
		}
		return m, commitCmd
	}

	return m, m.listenForAgentEvents()
}
