package ui

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/tool_result"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type agentDialogEntry struct {
	id, label, summary string
	teammate           *teams.TeammateUIState
	task               *tools.BackgroundTask
	progress           *subagentProgress
}
type backgroundActionDoneMsg struct{ err error }
type uiStatusTickMsg struct{}

func (m Model) agentEntries() []agentDialogEntry {
	var entries []agentDialogEntry
	if m.teamMgr != nil {
		for _, teammate := range m.teamMgr.GetAllTeammateStates() {
			id, _ := json.Marshal([]string{teammate.TeamName, teammate.Name})
			p := teammate.Progress
			entries = append(entries, agentDialogEntry{id: "teammate:" + string(id), label: "@" + teammate.Name,
				summary: fmt.Sprintf("%s · %s · %d tools · %s tokens", teammate.TeamName, teammate.Status, p.ToolUseCount, teams.FormatTokens(p.TokenCount)), teammate: &teammate})
		}
	}
	if m.taskMgr != nil {
		tasks := m.taskMgr.List()
		sort.SliceStable(tasks, func(i, j int) bool { return tasks[i].Kind != "shell" && tasks[j].Kind == "shell" })
		for _, task := range tasks {
			if task.Status != "running" {
				continue
			}
			kind := "subagent"
			p := m.subagents[task.OriginToolCallID]
			switch task.Kind {
			case "shell":
				kind = "Bash"
				p = nil
				if strings.HasPrefix(task.ID, "ps-") {
					kind = "PowerShell"
				}
			case "workflow":
				kind = "workflow"
			}
			summary := "background " + kind + " · " + task.Status
			if p != nil {
				summary += fmt.Sprintf(" · %d turns", p.turns)
				if p.lastTool != "" {
					summary += " · " + p.lastTool
				}
			}
			entries = append(entries, agentDialogEntry{id: "task:" + task.ID, label: task.ID + ": " + task.Name, summary: summary, task: &task, progress: p})
		}
	}
	return entries
}
func (m Model) openAgentsDialog() (tea.Model, tea.Cmd) {
	if len(m.agentEntries()) == 0 {
		return m, nil
	}
	m.agentsDialog = true
	m.agentsCursor = 0
	m.agentDetailID = ""
	return m, nil
}
func (m Model) handleAgentsDialog(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	entries := m.agentEntries()
	if len(entries) == 0 {
		m.agentsDialog = false
		return m, nil
	}
	m.agentsCursor = min(m.agentsCursor, len(entries)-1)
	target := entries[m.agentsCursor]
	if m.agentDetailID != "" {
		found := false
		for _, entry := range entries {
			if entry.id == m.agentDetailID {
				target = entry
				found = true
				break
			}
		}
		if !found {
			m.agentDetailID = ""
		}
	}
	switch key.String() {
	case "esc", "left":
		if m.agentDetailID != "" {
			m.agentDetailID = ""
		} else if key.String() == "esc" {
			m.agentsDialog = false
		}
	case "up", "down":
		if m.agentDetailID == "" {
			direction := 1
			if key.String() == "up" {
				direction = -1
			}
			m.agentsCursor = (m.agentsCursor + direction + len(entries)) % len(entries)
		}
	case "enter":
		if m.agentDetailID == "" {
			m.agentDetailID = target.id
		}
	case "k":
		if target.task != nil && m.taskMgr != nil {
			manager, id := m.taskMgr, target.task.ID
			return m, func() tea.Msg {
				_, err := manager.StopAndWait(context.Background(), id)
				return backgroundActionDoneMsg{err}
			}
		}
		if target.teammate != nil {
			team := m.teamMgr.GetTeam(target.teammate.TeamName)
			name := target.teammate.Name
			if team != nil {
				return m, func() tea.Msg { team.StopMember(name); return backgroundActionDoneMsg{} }
			}
		}
	case "s":
		if target.teammate != nil {
			team := m.teamMgr.GetTeam(target.teammate.TeamName)
			name := target.teammate.Name
			if team != nil {
				return m, func() tea.Msg {
					return backgroundActionDoneMsg{team.MailBox.Send(name, teams.NewShutdownRequest(teams.LeadName, "Please finish and exit"))}
				}
			}
		}
	}
	return m, nil
}
func (m Model) renderAgentsDialog() string { return m.renderAgentEntries(m.agentEntries()) }
func (m Model) renderAgentEntries(entries []agentDialogEntry) string {
	rows := m.dialogAvailableRows()
	width := max(1, m.width-boolColumn(m.width > 2)*2)
	cursor := min(m.agentsCursor, max(0, len(entries)-1))
	var detail *agentDialogEntry
	for _, entry := range entries {
		if entry.id == m.agentDetailID {
			detail = &entry
			break
		}
	}
	actions := "k stop"
	if detail != nil && detail.teammate != nil || detail == nil && len(entries) > 0 && entries[cursor].teammate != nil {
		actions += " · s shutdown"
	}
	title := AgentsDialogTitle
	subtitle := fmt.Sprintf("%d/%d · %s", min(cursor+1, len(entries)), len(entries), AgentsDialogSubtitle)
	hint := "↑↓ navigate · Enter detail · " + actions + " · Escape close"
	var lines []string
	if detail != nil {
		title, subtitle, hint = detail.label, detail.summary, "←/Escape back · "+actions
		if t := detail.teammate; t != nil {
			lines = append(lines, paint(fmt.Sprintf("%s elapsed · %d turns", formatAgentElapsed(t.StartTime), t.Progress.TurnCount), Theme.Muted))
			for i, activity := range t.Progress.RecentActivities {
				prefix := "├─ "
				if i == len(t.Progress.RecentActivities)-1 {
					prefix = "└─ "
				}
				lines = append(lines, paint(prefix+activity.Description, Theme.Muted))
			}
			if len(t.Progress.RecentActivities) == 0 {
				lines = append(lines, paint("No recent activity", Theme.Muted))
			}
			if t.LastMessage != "" {
				lines = append(lines, "", paint("Last message", Theme.Dim), paint(t.LastMessage, Theme.Text))
			}
		} else if task := detail.task; task != nil {
			if p := detail.progress; p != nil {
				line := fmt.Sprintf("%s · %d turns", p.role, p.turns)
				var active []string
				for _, tool := range p.active {
					active = append(active, tool.name)
				}
				if len(active) > 0 {
					line += " · " + strings.Join(active, ", ")
				}
				lines = append(lines, paint(line, Theme.Muted))
			}
			output := task.Output
			if output == "" && detail.progress != nil {
				output = detail.progress.output
			}
			output = tool_result.ToDisplayPreview(output)
			parts := strings.Split(output, "\n")
			limit := max(1, rows-selectorChrome(rows, true).height-9)
			if output == "" {
				lines = append(lines, paint("No output yet", Theme.Text))
			} else {
				for _, line := range parts[:min(limit, len(parts))] {
					lines = append(lines, paint(line, Theme.Text))
				}
			}
			if len(parts) > limit {
				lines = append(lines, paint(fmt.Sprintf("… %d more lines", len(parts)-limit), Theme.Dim))
			}
		}
	} else {
		count := max(1, min(10, rows-selectorChrome(rows, true).height))
		start := getListWindowStart(len(entries), cursor, count)
		if len(entries) == 0 {
			lines = append(lines, paint(AgentsDialogEmpty, Theme.Muted))
		}
		for i := start; i < min(len(entries), start+count); i++ {
			if width <= 2 {
				continue
			}
			entry := entries[i]
			prefix, color := "  ", Theme.Text
			if i == cursor {
				prefix, color = "› ", Theme.Accent
			}
			line := paint(prefix+plainTerminalLine(entry.label), color) + paint(" · "+plainTerminalLine(entry.summary), Theme.Muted)
			line = " " + truncateToWidth(line, max(0, width-2), "…")
			if i == cursor {
				line = lipgloss.NewStyle().Background(lipgloss.Color(Theme.SelectedBg)).Width(width).Render(line)
			}
			lines = append(lines, line)
		}
	}
	for i, line := range lines {
		lines[i] = truncateToWidth(line, width, "…")
	}
	return m.renderSelectorFrame(selectorFrameParams{title: title, subtitle: subtitle, hint: hint, content: strings.Join(lines, "\n"), width: m.width, rows: rows, scrollKey: "agents"})
}
func formatAgentElapsed(start int64) string {
	seconds := int((time.Now().UnixMilli() - start) / 1000)
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	if seconds < 3600 {
		return fmt.Sprintf("%dm%ds", seconds/60, seconds%60)
	}
	return fmt.Sprintf("%dh%dm", seconds/3600, seconds/60%60)
}
func (m Model) pollUIStatus() tea.Cmd {
	return tea.Tick(250*time.Millisecond, func(time.Time) tea.Msg { return uiStatusTickMsg{} })
}
