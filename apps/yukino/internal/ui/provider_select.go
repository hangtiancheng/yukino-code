package ui

import (
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/teams"
)

type initSingleProviderMsg struct{}

// activateInitialProvider wires the client and agent for the first active
// provider: the remembered default at startup, or the entry saved from the
// login form when none was configured.
func (m *Model) activateInitialProvider(p *config.ProviderConfig) tea.Cmd {
	if err := hooks.Validate(m.hookConfigs); err != nil {
		m.activityError = "Failed to initialize agent: " + err.Error()
		return nil
	}
	wd, _ := os.Getwd()
	systemPrompt := m.loadSkillsAndBuildPrompt(wd)
	client, err := llm.NewClient(p, systemPrompt)
	if err != nil {
		m.activityError = "Failed to initialize agent: " + err.Error()
		return nil
	}
	m.client = client
	m.fileHistory = file_history.New(m.sessionID)
	m.defaultTools.EditFile.FileHistory = m.fileHistory
	m.defaultTools.WriteFile.FileHistory = m.fileHistory
	m.registerAgentTools(client, p, p.Protocol, wd)
	if m.memoryMgr != nil {
		m.memoryContent = m.memoryMgr.BuildSystemReminder()
	}
	m.conversation.InjectLongTermMemory(m.instructionsContent, m.memoryContent, "")
	ag := agent.New(client, m.registry, p.Protocol)
	ag.ContextWindow = config.GetContextWindow(p)
	ag.MaxOutputTokens = config.GetMaxOutputTokens(p)
	ag.Instructions = m.instructionsContent
	ag.MemoryContent = m.memoryContent
	ag.SkillSection = m.buildSkillSection(wd)
	ag.SkillDeltaFn = m.skillDelta
	ag.FileHistory = m.fileHistory
	ag.FileStateCache = m.defaultTools.EditFile.FileStateCache
	ag.TaskManager = m.taskMgr
	ag.SetSessionID(m.sessionID)
	ag.GoalManager = m.currentGoal()
	pathSandbox := permissions.NewPathSandbox(wd, true)
	ag.Checker = permissions.NewChecker(
		pathSandbox,
		permissions.NewRuleEngine(wd),
		m.permissionMode,
	)
	// The sandbox is applied per run (beginInteractionRun → configureBashSandbox)
	// and before each user Bash, mirroring the reference's runAgentLoop prep, so
	// provider setup does not configure it here.
	ag.NotificationFn = m.drainTaskNotifications
	ag.ToolNameFilter = teams.CoordinatorToolFilter(m.EnableCoordinatorMode)
	ag.CoordinatorActiveFn = teams.CoordinatorActiveFn(m.EnableCoordinatorMode)
	// Mirror the reference's `shouldContinueGoal: () => !followUps.hasPending()`:
	// a queued follow-up pauses goal continuation at the next turn boundary. The
	// queue depth is pushed via syncFollowUps at the Update return points.
	ag.ShouldContinueGoal = ag.NoPendingFollowUps
	if len(m.hookConfigs) > 0 {
		eng := hooks.NewEngine(m.hookConfigs)
		eng.AgentRunner = newAgentHookRunner(client)
		ag.Hooks = eng
	}
	m.ag = ag
	m.teamMgr.SetPermissionChecker(ag.Checker)
	if at, ok := m.registry.Get("Agent").(*subagent.AgentTool); ok {
		at.ParentChecker = ag.Checker
	}
	m.attachWorkflow()
	m.wireMemoryTasks(ag)
	entries, err := history.LoadInputTexts()
	if err != nil {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "error", content: "Unable to load input history: " + err.Error()})
	}
	m.historyEntries = entries
	m.state = stateChat
	return m.initMCPServersCmd()
}

// renderProviderSelectView covers the startup state with no configured
// providers: the login form takes over the whole screen. Outside the dock the
// reference budget is frameRows = max(1, rows-1) (the caret-row reserve).
func (m Model) renderProviderSelectView() string {
	return m.renderLoginFrame(max(1, m.height-1))
}

func (m Model) handleProviderSelect(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "esc" {
		return m, tea.Quit
	}
	return m.handleLoginDialog(msg)
}

func providerFuseKeys() []fuseKey[config.ProviderConfig] {
	return []fuseKey[config.ProviderConfig]{
		{weight: 1, get: func(p config.ProviderConfig) (string, bool) { return p.Name, true }},
		{weight: 1, get: func(p config.ProviderConfig) (string, bool) { return p.Protocol, true }},
		{weight: 1, get: func(p config.ProviderConfig) (string, bool) { return p.BaseURL, true }},
		{weight: 1, get: func(p config.ProviderConfig) (string, bool) { return p.Model, true }},
	}
}

func (m Model) openProviderDialog() (tea.Model, tea.Cmd) {
	if len(m.providers) < 2 {
		if m.selectedProvider != nil {
			m.chatMessages = append(m.chatMessages, chatMessage{
				role:    "system",
				content: fmt.Sprintf("Provider: %s · %s", m.selectedProvider.Name, m.selectedProvider.Model),
			})
		}
		return m, nil
	}
	m.providerDialog = true
	m.providerQuery = ""
	m.providerFocusURL = ""
	m.providerFocusSet = false
	if m.selectedProvider != nil {
		m.providerFocusURL = m.selectedProvider.BaseURL
		m.providerFocusSet = true
	}
	return m, nil
}

func (m Model) providerDialogMatches() []config.ProviderConfig {
	query := strings.TrimSpace(m.providerQuery)
	if query == "" {
		return m.providers
	}
	return NewFuse(m.providers, providerFuseKeys(), 0.35, true).Search(query)
}

func (m Model) providerDialogCursor(matches []config.ProviderConfig) int {
	if m.providerFocusSet {
		for i, p := range matches {
			if p.BaseURL == m.providerFocusURL {
				return i
			}
		}
	}
	return 0
}

func (m Model) handleProviderDialog(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	matches := m.providerDialogMatches()
	switch msg.String() {
	case "esc":
		m.providerDialog = false
		return m, nil
	case "up", "down":
		if len(matches) > 0 {
			cursor := m.providerDialogCursor(matches)
			next := cursor - 1
			if msg.String() == "down" {
				next = cursor + 1
			}
			next = (next + len(matches)) % len(matches)
			m.providerFocusURL = matches[next].BaseURL
			m.providerFocusSet = true
		}
		return m, nil
	case "enter":
		if len(matches) > 0 {
			return m.switchProvider(matches[m.providerDialogCursor(matches)])
		}
		return m, nil
	default:
		nextQuery := updateSelectorQuery(m.providerQuery, msg)
		if nextQuery != m.providerQuery {
			m.providerQuery = nextQuery
			if strings.TrimSpace(nextQuery) != "" {
				m.providerFocusSet = false
			} else if m.selectedProvider != nil {
				m.providerFocusURL = m.selectedProvider.BaseURL
				m.providerFocusSet = true
			}
		}
		return m, nil
	}
}

func (m Model) renderProviderDialog() string {
	if !m.providerDialog {
		return ""
	}
	matches := m.providerDialogMatches()
	cursor := m.providerDialogCursor(matches)
	emptyText := "No providers configured"
	if strings.TrimSpace(m.providerQuery) != "" {
		emptyText = "No matching providers"
	}
	return renderSelectorList(selectorListParams{
		title:        "Select provider",
		hint:         "↑↓ navigate · Enter select · Esc cancel · Ctrl+U clear",
		query:        m.providerQuery,
		emptyText:    emptyText,
		itemCount:    len(matches),
		itemHeight:   1,
		totalCount:   len(m.providers),
		cursor:       cursor,
		searchActive: true,
		width:        m.width,
		rows:         m.dialogAvailableRows(),
		renderRows: func(start, count, width int) string {
			var sb strings.Builder
			for i := start; i < start+count && i < len(matches); i++ {
				p := matches[i]
				current := m.selectedProvider != nil && p.BaseURL == m.selectedProvider.BaseURL
				sb.WriteString(renderSelectorListRow(selectorListRowParams{
					label:       p.Name,
					description: p.Protocol + " · " + p.Model,
					focused:     i == cursor,
					current:     current,
					width:       width,
				}))
			}
			return sb.String()
		},
	})
}

// switchProvider mirrors the in-chat branch of handleProviderSelect in
// src/ui/app.tsx.
func (m Model) switchProvider(provider config.ProviderConfig) (tea.Model, tea.Cmd) {
	m.providerDialog = false
	return m.startProviderChange(provider, false)
}
