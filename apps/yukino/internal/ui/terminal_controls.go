package ui

import (
	"regexp"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/conversation/userbash"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

var goalControl = regexp.MustCompile(`^/goal(?:\s+(status|pause|clear|complete))?$`)

type foregroundSettledMsg struct {
	ch        <-chan agent.AgentEvent
	delivered []agent.SteeringDelivered
}

type queuedMessage struct {
	text  string
	input *history.InputEntry
}

type ctrlCExpiredMsg struct{ generation int }

func (m Model) modalActive() bool {
	return m.loginDialog || m.providerDialog || m.modelDialog || m.planApprovalDialog || m.rewindDialog || m.resumeDialog || m.permDialog || m.askUserDialog || m.thinkingDialog || m.agentsDialog || m.workflowsDialog
}

func (m Model) foregroundBusy() bool {
	if m.userBash != nil {
		return true
	}
	for _, p := range m.subagents {
		if p.status == "running" && p.taskID == "" {
			return true
		}
	}
	return m.streaming || m.compacting || m.startingAgent || m.settlingCh != nil
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok {
		if key.String() == "ctrl+c" {
			if m.foregroundBusy() {
				m.interruptUserWork()
				m.ctrlCDeadline = time.Time{}
				m.ctrlCGeneration++
				cmd := m.waitForForegroundCleanup()
				return m, cmd
			}
			if !m.ctrlCDeadline.IsZero() && time.Now().Before(m.ctrlCDeadline) {
				return m, tea.Quit
			}
			if !m.modalActive() {
				m.clearDraft()
			}
			m.ctrlCDeadline = time.Now().Add(2 * time.Second)
			m.ctrlCGeneration++
			generation := m.ctrlCGeneration
			return m, tea.Tick(2*time.Second, func(time.Time) tea.Msg { return ctrlCExpiredMsg{generation} })
		}
		if !m.ctrlCDeadline.IsZero() {
			m.ctrlCDeadline = time.Time{}
			m.ctrlCGeneration++
		}
		if key.String() == "ctrl+o" {
			m.toolsExpanded = !m.toolsExpanded
			text := m.renderTranscriptHeader() + "\n" + m.renderMessagesRange(0, m.committedUpTo)
			return m, tea.Sequence(tea.ClearScreen, tea.Println(text))
		}
	}
	switch event := msg.(type) {
	case foregroundSettledMsg:
		if event.ch == m.settlingCh {
			m.settlingCh = nil
			m.settleWaiting = false
			for _, delivered := range event.delivered {
				m.deliverSteering(delivered)
			}
			if m.ag != nil {
				for _, message := range m.ag.DrainSteering() {
					input := message.Input
					m.pendingMessages = append(m.pendingMessages, queuedMessage{text: message.Text, input: &input})
					m.removePendingSteering(input.ID)
				}
			}
		}
	case agentReadyMsg:
		m.startingAgent = false
		if !m.streaming {
			m.settlingCh = event.ch
			cmd := m.waitForForegroundCleanup()
			return m, cmd
		}
	case ctrlCExpiredMsg:
		if event.generation == m.ctrlCGeneration {
			m.ctrlCDeadline = time.Time{}
		}
		return m, nil
	case clipboardImageMsg:
		m.handleClipboard(event)
		return m, nil
	}
	updated, cmd := m.update(msg)
	var next Model
	switch value := updated.(type) {
	case Model:
		next = value
	case *Model:
		next = *value
	}
	if event, ok := msg.(agentEventMsg); ok && m.agentCh == event.ch {
		switch event.event.(type) {
		case agent.LoopComplete, agent.ErrorEvent:
			next.settlingCh = event.ch
		}
	}
	if next.workflowClients != nil {
		next.workflowClients.set(next.client, next.selectedProvider)
	}
	if next.StartupResume != nil && next.StartupResume != "" && next.state == stateChat && next.ag != nil {
		args, _ := next.StartupResume.(string)
		next.StartupResume = nil
		text := "/resume"
		if args != "" {
			text += " " + args
		}
		resumed, resumeCmd := next.executeCommand(text, nil)
		next = resumed.(Model)
		cmd = tea.Batch(cmd, resumeCmd)
	}
	next.flushUserBashRecords(true)
	cleanupCmd := next.waitForForegroundCleanup()
	cmd = tea.Batch(cmd, cleanupCmd)

	if next.foregroundBusy() {
		next.ctrlCDeadline = time.Time{}
		next.ctrlCGeneration++
	}
	if !next.foregroundBusy() && !next.commandBusy && !next.providerSwitching && !next.modalActive() && next.state == stateChat && next.ag != nil && len(next.pendingMessages) > 0 && !next.queuePaused {
		message := next.pendingMessages[0]
		next.pendingMessages = next.pendingMessages[1:]
		dispatched, dispatchCmd := next.dispatchInput(message.text, message.input)
		switch value := dispatched.(type) {
		case Model:
			next = value
		case *Model:
			next = *value
		}
		if next.activityError != "" {
			next.pendingMessages = append([]queuedMessage{message}, next.pendingMessages...)
			next.queuePaused = true
		}
		next.syncFollowUps()
		return next, tea.Batch(cmd, dispatchCmd)
	}
	next.syncFollowUps()
	return next, cmd
}

func (m Model) backgroundShells() tea.Cmd {
	if m.userBash != nil && m.userBash.excluded {
		return nil
	}
	if !m.modalActive() && tools.HasAnyForegroundTasks(m.registry) {
		tools.BackgroundAllForegroundTasks(m.registry)
	}
	return nil
}

func (m Model) submitInput(text string) (tea.Model, tea.Cmd) {
	if _, _, ok := userbash.ParseCommand(text); ok {
		next, cmd, accepted := m.submitUserBash(text)
		if accepted {
			next.clearDraft()
		}
		return next, cmd
	}
	m.updateDismissed = true
	if m.streaming && !m.startingAgent && m.steeringAgent != nil && !strings.HasPrefix(text, "/") {
		input, err := history.RecordInput(history.InputOptions{Text: text, Cwd: m.getWorkDir(), SessionID: &m.sessionID, Source: "cli"})
		if err != nil {
			return m.inputError(err)
		}
		if _, err := m.steeringAgent.Steer(text, &input); err != nil {
			return m.inputError(err)
		}
		m.steeringPending = append(m.steeringPending, input)
		m.historyEntries = append(m.historyEntries, text)
		m.clearDraft()
		return m, nil
	}
	if (m.foregroundBusy() || m.commandBusy || m.providerSwitching || m.modalActive() || m.ag == nil) && !(m.streaming && goalControl.FindStringSubmatch(text) != nil) {
		m.pendingMessages = append(m.pendingMessages, queuedMessage{text: text})
		m.queuePaused = false
		m.clearDraft()
		return m, nil
	}
	var updated tea.Model
	var cmd tea.Cmd
	if match := goalControl.FindStringSubmatch(text); m.streaming && match != nil {
		updated, cmd = m.executeCommand(strings.TrimSpace(text), nil)
	} else {
		updated, cmd = m.dispatchInput(text, nil)
	}
	var next Model
	switch value := updated.(type) {
	case Model:
		next = value
	case *Model:
		next = *value
	}
	if next.activityError == "" {
		next.clearDraft()
	}
	return next, cmd
}

func (m Model) dispatchInput(text string, input *history.InputEntry) (tea.Model, tea.Cmd) {
	m.activityError = ""
	m.refreshSkillsIfNeeded()
	if strings.HasPrefix(text, "/") {
		_, _, ok := commands.Parse(text)
		if ok {
			return m.executeCommand(text, input)
		}
	}
	if m.ag == nil {
		m.activityError = "LLM client not ready yet"
		return m, nil
	}
	return m.sendMessage(text, input)
}

// syncFollowUps pushes the current follow-up queue depth to the agent so its
// goal-continuation gate (ShouldContinueGoal) reflects queued input. Every
// pendingMessages mutation settles before one of the two Update return points
// that call this, so the agent always observes the post-mutation depth.
func (m Model) syncFollowUps() {
	if m.ag != nil {
		m.ag.SetPendingFollowUps(len(m.pendingMessages))
	}
}

func (m *Model) recallQueued() (string, bool) {
	if len(m.pendingMessages) == 0 {
		if len(m.steeringPending) > 0 && m.steeringAgent != nil {
			last := len(m.steeringPending) - 1
			input := m.steeringPending[last]
			if m.steeringAgent.RemoveSteering(input.ID) {
				m.steeringPending = m.steeringPending[:last]
				return input.Text, true
			}
		}
		return "", false
	}
	last := len(m.pendingMessages) - 1
	text := m.pendingMessages[last].text
	m.pendingMessages = m.pendingMessages[:last]
	return text, true
}

func (m *Model) waitForForegroundCleanup() tea.Cmd {
	if m.settlingCh == nil || m.settleWaiting {
		return nil
	}
	m.settleWaiting = true
	ch := m.settlingCh
	return func() tea.Msg {
		var delivered []agent.SteeringDelivered
		for event := range ch {
			if message, ok := event.(agent.SteeringDelivered); ok {
				delivered = append(delivered, message)
			}
		}
		return foregroundSettledMsg{ch: ch, delivered: delivered}
	}
}

func (m *Model) removePendingSteering(inputID string) {
	for i, input := range m.steeringPending {
		if input.ID == inputID {
			m.steeringPending = append(m.steeringPending[:i], m.steeringPending[i+1:]...)
			return
		}
	}
}

func (m *Model) deliverSteering(event agent.SteeringDelivered) {
	m.removePendingSteering(event.InputID)
	m.chatMessages = append(m.chatMessages, chatMessage{role: "user", content: event.Text})
}
