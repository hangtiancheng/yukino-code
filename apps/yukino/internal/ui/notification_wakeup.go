package ui

import (
	"context"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/update"
)

type updateNoticeMsg struct{ version string }

func (m Model) checkUpdate() tea.Cmd {
	ctx := m.lifeCtx
	return func() tea.Msg { return updateNoticeMsg{update.CheckForUpdate(ctx)} }
}
func (m *Model) wakeNotifications() tea.Cmd {
	if m.ag == nil || m.foregroundBusy() || m.commandBusy || m.providerSwitching || m.modalActive() || len(m.pendingMessages) > 0 {
		return nil
	}
	pending := m.taskMgr != nil && m.taskMgr.HasNotifications()
	if !pending && m.teamMgr != nil {
		for _, name := range m.teamMgr.ListTeams() {
			team := m.teamMgr.GetTeam(name)
			if team == nil {
				continue
			}
			notes, err := team.MailBox.ReadUnread(teams.LeadName)
			if err == nil && len(notes) > 0 {
				pending = true
				break
			}
		}
	}
	if !pending {
		return nil
	}
	m.streaming = true
	m.beginInteractionRun()
	m.prepareOutput()
	m.planApprovalDialog = false
	m.activityError = ""
	ctx, cancel := context.WithCancel(m.lifeCtx)
	m.cancelStream = cancel
	m.steeringAgent = m.newRunAgent(ctx)
	m.agentCh = m.steeringAgent.Run(ctx, m.conversation)
	return tea.Batch(m.listenForAgentEvents(), m.spinner.Tick)
}
