package ui

import (
	"context"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/session"
)

func (m Model) sendMessage(text string, existingInput *history.InputEntry) (tea.Model, tea.Cmd) {
	m.refreshSkillsIfNeeded()
	wd, _ := os.Getwd()
	var input history.InputEntry
	if existingInput != nil {
		input = *existingInput
	} else {
		var err error
		input, err = history.RecordInput(history.InputOptions{Cwd: wd, SessionID: &m.sessionID, Source: "cli", Text: text})
		if err != nil {
			return m.inputError(err)
		}
	}
	expanded, blocks := conversation.ExpandAtRefsWithImages(text, wd)
	userRecord := session.Message{Content: expanded}
	if blocks != nil {
		userRecord = session.Message{ContentBlocks: blocks}
	}
	recorded, err := session.SaveUserMessage(wd, m.sessionID, input, userRecord)
	if err != nil {
		return m.inputError(err)
	}
	if existingInput == nil {
		m.historyEntries = append(m.historyEntries, text)
	}
	m.historyIndex = 0
	m.historyDraft = nil

	m.streaming = true
	m.beginInteractionRun()
	m.atMenuOpen = false
	m.atMatches = nil

	m.chatMessages = append(m.chatMessages, chatMessage{role: "user", content: text})
	userLine := m.renderMessage(m.chatMessages[len(m.chatMessages)-1])
	m.committedUpTo = len(m.chatMessages)
	m.conversation.AppendMessages([]conversation.Message{recorded.ToConversation()})

	m.prepareOutput()
	m.toolBlocks = nil

	ctx, cancel := context.WithCancel(context.Background())
	m.cancelStream = cancel

	conv := m.conversation
	ag := m.newRunAgent(ctx)
	m.steeringAgent = ag
	m.startingAgent = true
	startAgentCmd := func() tea.Msg {
		return agentReadyMsg{ch: ag.Run(ctx, conv)}
	}

	return m, tea.Batch(tea.Println(userLine), startAgentCmd, m.spinner.Tick)
}

func (m Model) sendPromptCommand(displayText, prompt, agentRole string, input history.InputEntry) (tea.Model, tea.Cmd) {
	wd, _ := os.Getwd()
	m.historyIndex = 0
	m.historyDraft = nil

	m.streaming = true
	m.subagentCommand = agentRole != ""
	if !m.subagentCommand {
		m.beginInteractionRun()
	} else {
		m.prepareSubagentTurn()
		m.planApprovalDialog = false
		m.exitPlanSucceeded = false
		m.activityError = ""
	}
	m.atMenuOpen = false
	m.atMatches = nil

	visibleText := displayText
	if agentRole == "" {
		visibleText = prompt
	}
	m.chatMessages = append(m.chatMessages, chatMessage{role: "user", content: visibleText})
	userLine := m.renderMessage(m.chatMessages[len(m.chatMessages)-1])
	m.committedUpTo = len(m.chatMessages)
	if agentRole == "" {
		recorded, err := session.SaveUserMessage(wd, m.sessionID, input, session.Message{Content: prompt})
		if err != nil {
			return m.inputError(err)
		}
		m.conversation.AppendMessages([]conversation.Message{recorded.ToConversation()})
	}

	m.prepareOutput()
	m.toolBlocks = nil

	ctx, cancel := context.WithCancel(context.Background())
	m.cancelStream = cancel

	conv := m.conversation
	ag := m.ag
	if agentRole == "" {
		ag = m.newRunAgent(ctx)
		m.steeringAgent = ag
	}
	m.startingAgent = true
	startAgentCmd := func() tea.Msg {
		if agentRole != "" {
			return agentReadyMsg{ch: commands.RunSubagentCommand(ctx, agentRole, prompt, displayText, m.registry, ag.Checker, conv, wd, m.sessionID, &input)}
		}
		return agentReadyMsg{ch: ag.Run(ctx, conv)}
	}

	return m, tea.Batch(tea.Println(userLine), startAgentCmd, m.spinner.Tick)
}

func (m Model) inputError(err error) (tea.Model, tea.Cmd) {
	m.activityError = err.Error()
	m.chatMessages = append(m.chatMessages, chatMessage{role: "error", content: err.Error()})
	return m, nil
}
