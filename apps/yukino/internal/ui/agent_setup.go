package ui

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

func (m *Model) drainTaskNotifications() ([]string, error) {
	messages := teams.DrainLeadMailbox(m.teamMgr)
	if m.taskMgr != nil {
		drained, err := m.taskMgr.DrainNotifications()
		if err != nil {
			return nil, err
		}
		for _, task := range drained {
			messages = append(messages, subagent.FormatAgentTaskNotification(task))
		}
	}
	return messages, nil
}

func newAgentHookRunner(client llm.Client) func(prompt string, ctx hooks.HookContext) (string, error) {
	return func(prompt string, _ hooks.HookContext) (string, error) {
		c, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		conv := conversation.NewManager()
		conv.AddUserMessage(prompt)
		events, errs := client.Stream(c, conv, nil)
		var text string
		for ev := range events {
			if td, ok := ev.(llm.TextDelta); ok {
				text += td.Text
			}
		}
		select {
		case err := <-errs:
			if err != nil {
				return "", err
			}
		default:
		}
		return text, nil
	}
}

func (m *Model) registerAgentTools(client llm.Client, providerCfg *config.ProviderConfig, protocol, wd string) {
	if m.taskMgr != nil {
		_ = m.taskMgr.StopAll(context.Background())
	}
	m.taskMgr = subagent.NewTaskManager()
	if err := m.taskMgr.UseSession(m.sessionID); err != nil {
		panic(err)
	}
	tools.AttachBackgroundTaskManager(m.registry, m.taskMgr)
	manager := m.taskMgr
	m.registry.AddCleanup(func() error { return manager.StopAll(context.Background()) })

	store, err := todo.NewStore(m.sessionID)
	if err != nil {
		panic(err)
	}
	err = m.todoList.UseStore(store)
	if err != nil {
		panic(err)
	}

	// enable_memory: false disables the whole auto-memory pipeline; no
	// manager is created so nothing scans, rebuilds MEMORY.md, or injects
	// reminders.
	if m.memoryEnabled {
		m.memoryMgr = memory.NewManager(wd, nil)
	}

	loader := subagent.NewAgentLoader()
	loader.LoadAll()

	// The TeamManager exists from ui.New (the mount-time core registry holds
	// TeamTodoWrite); activation only finalizes and restores it.
	m.teamMgr.CoordinatorMode = m.EnableCoordinatorMode
	// Restore pending notifications and reclaim interrupted teammates' work.
	m.teamMgr.RestoreFromDisk()
	teamMgr := m.teamMgr
	// The reference initClient registers skill tools, the ask tool and the
	// team/task tools on top of the mount-time core registry, in this order.
	m.registry.Register(&skills.LoadSkillTool{Catalog: m.skillCatalog, Host: m})
	m.registry.Register(&skills.InstallSkillTool{
		Cwd:     wd,
		Catalog: m.skillCatalog,
		OnInstalled: func() {
			// Only rewire the slash commands; newly installed skills are
			// delivered by skillDelta on the next turn.
			bootstrap.WireSkillsToRegistry(m.skillCatalog, m.cmdRegistry, m)
		},
	})
	m.registry.Register(&tools.AskUserQuestionTool{RequestCh: m.askUserCh})
	m.registry.Register(&teams.TeamCreateTool{TeamMgr: teamMgr})
	m.registry.Register(&teams.SendMessageTool{TeamMgr: teamMgr, SenderName: "leader"})
	m.registry.Register(&teams.TeamListTool{TeamMgr: teamMgr})
	m.registry.Register(&teams.TeamDeleteTool{TeamMgr: teamMgr})
	m.registry.Register(&teams.TaskStopTool{TeamMgr: teamMgr, TaskManager: m.taskMgr})
	m.registry.Register(&tools.SyntheticOutputTool{})
	// Wire every loaded skill as a slash command after user commands so user
	// *.md files take precedence (idempotent, skips taken names).
	bootstrap.WireSkillsToRegistry(m.skillCatalog, m.cmdRegistry, m)
	progressCh, life := m.subAgentProgressCh, m.lifeCtx
	m.registry.Register(&subagent.AgentTool{
		Client:        client,
		Provider:      providerCfg,
		MemoryContent: m.memoryContent,
		Registry:      m.registry,
		Protocol:      protocol,
		TaskMgr:       m.taskMgr,
		OnProgress: func(p subagent.SubAgentProgress) {
			select {
			case progressCh <- p:
			case <-life.Done():
			}
		},
		Loader:       loader,
		Conversation: m.conversation,
		TeamMgr:      teamMgr,
	})

}

func (m *Model) initMCPServersCmd() tea.Cmd {
	if len(m.mcpConfigs) == 0 {
		return nil
	}

	m.mcpConnecting = true
	configs := m.mcpConfigs
	mgr := mcp.NewManager(false)
	m.mcpMgr = mgr
	ctx := m.lifeCtx

	return func() tea.Msg {
		return mcpReadyMsg{result: mgr.ConnectAll(ctx, configs), mgr: mgr}
	}
}

func (m *Model) loadSkillsAndBuildPrompt(wd string) string {
	m.skillCatalog = skills.LoadCatalog(wd)

	for _, cmd := range commands.LoadUserCommands() {
		if m.cmdRegistry.Find(cmd.Name) != nil {
			continue
		}
		m.cmdRegistry.Register(cmd)
	}

	return m.rebuildSystemPrompt(wd)
}

func (m *Model) refreshSkillsIfNeeded() {
	if m.skillCatalog == nil || m.client == nil {
		return
	}
	if !m.skillCatalog.NeedsReload() {
		return
	}
	m.skillCatalog.Reload()
	bootstrap.WireSkillsToRegistry(m.skillCatalog, m.cmdRegistry, m)
}

func (m *Model) skillDelta() string {
	if m.skillCatalog == nil {
		return ""
	}
	if m.announcedSkills == nil {
		m.announcedSkills = map[string]bool{}
	}
	var lines []string
	for _, meta := range m.skillCatalog.List() {
		if m.announcedSkills[meta.Name] {
			continue
		}
		m.announcedSkills[meta.Name] = true
		desc := meta.Description
		if len(desc) > 200 {
			desc = desc[:200] + "…"
		}
		lines = append(lines, fmt.Sprintf("- /%s: %s", meta.Name, desc))
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n")
}

func (m *Model) rebuildSystemPrompt(wd string) string {
	m.instructionsContent = m.loadCustomInstructions(wd)
	m.memoryContent = ""
	if m.memoryEnabled && m.memoryMgr != nil {
		m.memoryContent = m.memoryMgr.BuildSystemReminder()
	}
	env := prompt.DetectEnvironment(wd)
	if m.selectedProvider != nil {
		env.Model = m.selectedProvider.Model
	}
	return prompt.BuildSystemPrompt(env)
}

func (m *Model) buildSkillSection(wd string) string {
	return skills.BuildSkillSection(m.skillCatalog)
}

func (m Model) ActivateSkill(name, body string) {
	if m.ag != nil {
		m.ag.ActivateSkill(name, body)
	}
}

func (m Model) SetToolFilter(allow func(name string) bool) {
	if m.ag == nil {
		return
	}
	m.ag.SetToolFilter(allow)
}

func (m Model) ToolRegistry() *tools.Registry {
	return m.registry
}

func (m Model) SnapshotParentMessages(count int) string {
	if m.conversation == nil {
		return ""
	}
	messages := m.conversation.GetMessages()
	if len(messages) > count {
		messages = messages[len(messages)-count:]
	}
	lines := make([]string, 0, len(messages))
	for _, message := range messages {
		content := any(message.Content)
		if len(message.ContentBlocks) > 0 {
			content = message.ContentBlocks
		}
		lines = append(lines, "["+message.Role+"] "+utils.ContentToText(content))
	}
	return strings.Join(lines, "\n")
}

func (m Model) RunSubagent(ctx context.Context, prompt string) (string, error) {
	if m.client == nil {
		return "", fmt.Errorf("RunSubagent: no llm client (provider not selected)")
	}
	spec := subagent.BuiltinSpecs["general-purpose"]
	definition := &subagent.AgentDefinition{
		AgentType:       spec.Name,
		WhenToUse:       spec.Description,
		Tools:           spec.Tools,
		DisallowedTools: spec.DisallowedTools,
		SystemPrompt:    spec.SystemPromptOverride,
		MaxTurns:        spec.MaxTurns,
		Model:           spec.Model,
		PermissionMode:  spec.PermissionMode,
		ReadOnly:        spec.ReadOnly,
		Background:      spec.Background,
		Worktree:        spec.Worktree,
		InitialPrompt:   spec.InitialPrompt,
	}
	var checker *permissions.Checker
	if m.ag != nil {
		checker = m.ag.Checker
	}
	cwd, _ := os.Getwd()
	return subagent.SpawnSubagent(ctx, definition, prompt, m.client, m.registry, m.selectedProvider, cwd, nil, nil, "", checker, subagent.SubagentRunOptions{Background: false})
}

func (m *Model) loadCustomInstructions(wd string) string {
	return memory.LoadInstructions(wd)
}

func (m *Model) prefetchRelevantMemories(parent context.Context, query string) <-chan agent.RecallResult {
	out := make(chan agent.RecallResult, 1)
	if m.memoryMgr == nil || m.selectedProvider == nil || m.client == nil {
		out <- agent.RecallResult{}
		return out
	}
	ag := m.ag
	client := m.client
	manager := m.memoryMgr
	go func() {
		ctx, cancel := context.WithCancel(parent)
		defer cancel()
		var recentTools []string
		var surfaced map[string]struct{}
		if ag != nil {
			recentTools, surfaced = ag.RecallHints()
		}
		results := manager.FindRelevantMemories(ctx, query, client, recentTools, surfaced)
		paths := make([]string, 0, len(results))
		for _, r := range results {
			paths = append(paths, r.Path)
		}
		out <- agent.RecallResult{Reminder: manager.RenderReminder(results), Paths: paths}
	}()
	return out
}

func (m *Model) finishStreaming() {
	m.endInteractionRun()
	m.retryStatus = ""
	m.fileFactsVersion++

	m.streaming = false
	m.steeringAgent = nil
	m.cancelStream = nil
	m.agentCh = nil
}
