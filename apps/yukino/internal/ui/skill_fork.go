package ui

import (
	"context"
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type commandSkillForkHost struct {
	Model
	skill *skills.Skill
}

func (h commandSkillForkHost) RunSubagent(ctx context.Context, prompt string) (string, error) {
	execution, _ := tools.RuntimeContext(h.workflowContext())
	ctx = tools.WithExecutionContext(ctx, execution)
	definition := &subagent.AgentDefinition{AgentType: h.skill.Meta.Name, WhenToUse: h.skill.Meta.Description, Model: h.skill.Meta.Model}
	return subagent.SpawnSubagent(ctx, definition, prompt, h.client, h.registry, h.selectedProvider, h.getWorkDir(), nil, nil, "", h.ag.Checker.ForCwd(h.getWorkDir()), subagent.SubagentRunOptions{Background: false})
}

func (m Model) startSkillFork(name, args string) (tea.Model, tea.Cmd) {
	var skill *skills.Skill
	if m.skillCatalog != nil {
		skill = m.skillCatalog.Get(name)
	}
	if skill == nil {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Skill not found: " + name})
		return m, nil
	}
	if m.client == nil {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: ClientNotReady})
		return m, nil
	}
	ctx, cancel := context.WithCancel(m.workflowContext())
	m.cancelStream = cancel
	m.streaming = true
	m.steeringAgent = nil
	m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: fmt.Sprintf("Running skill %q in fork mode…", name)})
	host := commandSkillForkHost{Model: m, skill: skill}
	return m, tea.Batch(m.commitStaticOutput(), m.spinner.Tick, func() tea.Msg {
		result, err := skills.RunFork(ctx, skill, args, host)
		return forkSkillDoneMsg{name: name, result: result, err: err}
	})
}
