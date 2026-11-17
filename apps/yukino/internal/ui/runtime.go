package ui

import (
	"context"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
)

func (m *Model) newRunAgent(ctx context.Context) *agent.Agent {
	handle := m.ag
	running := agent.New(m.client, m.registry, handle.Protocol)
	running.Checker = handle.Checker
	running.WorkDir = m.getWorkDir()
	running.SetSessionID(m.sessionID)
	running.ContextWindow = handle.ContextWindow
	running.MaxOutputTokens = handle.MaxOutputTokens
	running.GoalManager = m.currentGoal()
	running.ShouldContinueGoal = handle.NoPendingFollowUps
	running.Hooks = handle.Hooks
	running.FileHistory = m.fileHistory
	running.FileStateCache = handle.FileStateCache
	running.TaskManager = m.taskMgr
	running.RecoveryState = handle.RecoveryState
	running.ShareActiveSkills(handle)
	running.ShareRecall(handle)
	running.Instructions = memory.LoadInstructions(m.getWorkDir())
	if m.memoryEnabled && m.memoryMgr != nil {
		running.MemoryContent = m.memoryMgr.BuildSystemReminder()
	}
	if m.skillCatalog != nil {
		running.SkillSection = skills.BuildSkillSection(m.skillCatalog)
	}
	running.SkillDeltaFn = m.skillDelta
	running.ToolNameFilter = handle.ToolNameFilter
	running.CoordinatorActiveFn = handle.CoordinatorActiveFn
	running.NotificationFn = m.drainTaskNotifications
	m.wireMemoryTasks(running)
	query := ""
	for _, message := range m.conversation.GetMessages() {
		if message.Role == "user" {
			query = message.ContentText()
		}
	}
	running.MemoryRecallCh = m.prefetchRelevantMemories(ctx, query)
	return running
}

func (m *Model) resetSessionContext() {
	clear(m.announcedSkills)
	if m.ag != nil {
		m.ag.FileStateCache.Clear()
		m.ag.ResetRecall()
		m.ag.RecoveryState = compact.NewRecoveryState()
	}
}

func (m *Model) injectSessionContext() {
	instructions := memory.LoadInstructions(m.getWorkDir())
	memories := ""
	if m.memoryEnabled && m.memoryMgr != nil {
		memories = m.memoryMgr.BuildSystemReminder()
	}
	m.conversation.InjectLongTermMemory(instructions, memories, "")
	if m.mcpMgr != nil {
		mcp.SyncMcpInstructions(m.conversation, m.mcpAnnounced, m.mcpMgr)
	}
}

func providerSystemPrompt(provider *config.ProviderConfig, cwd string) string {
	env := prompt.DetectEnvironment(cwd)
	env.Model = provider.Model
	return prompt.BuildSystemPrompt(env)
}

func (m *Model) bindClient(client llm.Client, provider *config.ProviderConfig) {
	m.client = client
	if m.ag != nil {
		m.ag.Client = client
		m.ag.Protocol = provider.Protocol
		m.ag.ContextWindow = config.GetContextWindow(provider)
		m.ag.MaxOutputTokens = config.GetMaxOutputTokens(provider)
		if m.ag.Hooks != nil {
			m.ag.Hooks.AgentRunner = newAgentHookRunner(client)
		}
	}
	if tool, ok := m.registry.Get("Agent").(*subagent.AgentTool); ok {
		tool.SetClient(client, provider)
	}
}
