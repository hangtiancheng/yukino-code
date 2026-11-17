package ui

import (
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

type subagentProgress struct {
	role, status, output, lastTool string
	taskID                         string
	turns                          int
	active                         []progressTool
}
type progressTool struct{ id, name string }

// prepareSubagentTurn mirrors the reference prepareTurn: at every run entry,
// drop finished foreground tracker entries and keep only the background ones
// whose task is still running.
func (m *Model) prepareSubagentTurn() {
	for id, p := range m.subagents {
		keep := false
		if p.taskID != "" && m.taskMgr != nil {
			if task := m.taskMgr.Get(p.taskID); task != nil && task.Status == "running" {
				keep = true
			}
		}
		if !keep {
			delete(m.subagents, id)
		}
	}
}

func (m *Model) applySubagentProgress(event subagent.SubAgentProgress) {
	if event.ToolCallID == "" {
		return
	}
	if m.subagents == nil {
		m.subagents = map[string]*subagentProgress{}
	}
	p := m.subagents[event.ToolCallID]
	if p == nil {
		p = &subagentProgress{role: event.Role, status: "running"}
		m.subagents[event.ToolCallID] = p
	}
	if event.Status == "running" {
		*p = subagentProgress{role: event.Role, status: "running"}
	}
	if m.taskMgr != nil {
		for _, task := range m.taskMgr.List() {
			if task.OriginToolCallID == event.ToolCallID {
				p.taskID = task.ID
				break
			}
		}
	}
	if event.Status != "" {
		p.status = event.Status
		p.output = event.Output
		if p.status != "running" {
			p.active = nil
			p.lastTool = ""
			if p.taskID != "" {
				delete(m.subagents, event.ToolCallID)
				return
			}
		}
	}
	switch e := event.Event.(type) {
	case agent.ToolUseEvent:
		p.lastTool = e.ToolName
		for i, tool := range p.active {
			if tool.id == e.ToolID {
				p.active[i].name = e.ToolName
				return
			}
		}
		p.active = append(p.active, progressTool{id: e.ToolID, name: e.ToolName})
	case agent.ToolResultEvent:
		for i, t := range p.active {
			if t.id == e.ToolID {
				p.active = append(p.active[:i], p.active[i+1:]...)
				break
			}
		}
	case agent.TurnComplete:
		p.turns++
		p.active = nil
	}
}
func (m Model) decorateTool(tb toolBlockInfo) toolBlockInfo {
	if tb.toolName == "Bash" || tb.toolName == "PowerShell" {
		if tb.loading && tb.progress == "" {
			tb.progress = "(Ctrl+B to run in background)"
		}
		return tb
	}
	if p := m.subagents[tb.toolID]; p != nil {
		tb.progress = fmt.Sprintf("%s subagent | %d turns", p.role, p.turns)
		current := p.lastTool
		if len(p.active) > 0 {
			current = p.active[len(p.active)-1].name
		}
		if current != "" {
			tb.progress += " | " + current
		}
		tb.status = p.status
		tb.loading = p.status == "running"
		tb.isError = p.status == "failed" || p.status == "stopped"
		if p.status != "running" {
			tb.output = p.output
		}
		return tb
	}
	if tb.toolName != "Agent" {
		return tb
	}
	if m.teamMgr != nil {
		for _, teammate := range m.teamMgr.GetAllTeammateStates() {
			if teammate.OriginToolCallID != tb.toolID || tb.toolID == "" {
				continue
			}
			parts := []string{"@" + teammate.Name}
			p := teammate.Progress
			current := ""
			if len(p.ActiveTools) > 0 {
				current = p.ActiveTools[len(p.ActiveTools)-1].ToolName
			} else if p.LastActivity != nil {
				current = p.LastActivity.ToolName
			}
			if current != "" {
				parts = append(parts, current)
			}
			parts = append(parts, fmt.Sprintf("%d turns", p.TurnCount), teams.FormatTokens(p.TokenCount)+" tokens")
			tb.progress = strings.Join(parts, " | ")
			tb.status = teammate.Status
			if tb.status == "idle" {
				tb.status = "completed"
			}
			tb.loading = tb.status == "running"
			tb.isError = tb.status == "failed" || tb.status == "stopped"
			return tb
		}
	}
	if m.taskMgr != nil {
		for _, task := range m.taskMgr.List() {
			if task.OriginToolCallID == tb.toolID && tb.toolID != "" {
				tb.progress = task.Name + " subagent"
				tb.status = task.Status
				if tb.status == "cancelled" {
					tb.status = "stopped"
				}
				tb.loading = tb.status == "running"
				tb.isError = tb.status == "failed" || tb.status == "stopped"
				if task.Output != "" {
					tb.output = task.Output
				}
				return tb
			}
		}
	}
	kind, ok := tb.args["kind"]
	teammate := !ok || kind == "teammate"
	background, _ := tb.args["run_in_background"].(bool)
	role := utils.StrArg(tb.args, "subagent_type", "")
	if role == "" {
		role = subagent.GeneralPurposeAgentType
	}
	if teammate {
		tb.progress = "0 turns | 0 tokens"
	} else {
		tb.progress = role + " subagent | 0 turns"
	}
	if teammate || background {
		tb.status = "running"
		tb.loading = true
	}
	return tb
}
