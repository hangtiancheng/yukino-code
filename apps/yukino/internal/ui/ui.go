package ui

import (
	"context"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/memory/background"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/sandbox"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/vscode"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type appState int

const (
	stateProviderSelect appState = iota
	stateChat
)

type Model struct {
	interactionStats                       bootstrap.InteractionSummary
	agentStartedAt, toolBatchStartedAt     time.Time
	activeToolIDs                          map[string]bool
	StartupResume                          any
	userBash                               *userBashRun
	userBashTool                           *toolBlockInfo
	userBashOutputCh                       chan userBashOutputMsg
	memoryLoopCh                           chan memoryLoopMsg
	memorySystemCh                         chan memorySystemMsg
	pendingBashRecords                     []session.Message
	lifeCtx                                context.Context
	lifeCancel                             context.CancelFunc
	hostPermissionCh                       chan agent.PermissionRequestEvent
	permissionQueue                        []agent.PermissionRequestEvent
	permissionCurrent                      *agent.PermissionRequestEvent
	askQueue                               []tools.AskUserRequest
	thinkingDialog                         bool
	thinkingLevels                         []string
	thinkingCursor                         int
	agentsDialog                           bool
	agentsCursor                           int
	agentDetailID                          string
	workflowsDialog                        bool
	workflowRunCursor, workflowAgentCursor int
	workflowConfirm                        *workflowConfirm
	workflowError                          string
	workflowResuming                       bool
	workflowClients                        *workflowClients
	latestVersion                          string
	updateDismissed                        bool
	todoTeams                              []*teams.Team
	todoBoardGeneration                    int
	todoCompletionKey                      string
	todoCompletionAt                       time.Time
	providers                              []config.ProviderConfig
	selectedProvider                       *config.ProviderConfig
	defaultProvider                        int
	client                                 llm.Client
	registry                               *tools.Registry
	ag                                     *agent.Agent
	steeringAgent                          *agent.Agent
	subagentCommand                        bool
	exitPlanSucceeded                      bool
	commandBusy                            bool

	state         appState
	streaming     bool
	startingAgent bool
	settlingCh    <-chan agent.AgentEvent
	settleWaiting bool

	editor inputEditor
	width  int
	height int
	ready  bool

	providerCursor int

	conversation *conversation.Manager

	chatMessages []chatMessage
	toolBlocks   []toolBlockInfo
	// turnSummaryOrder/turnSummary mirror the reference turnToolCalls: tool ids
	// in tool_use arrival order (orphan tool_results append on arrival), with
	// the finalized summary entry per id once the result lands. The live
	// viewport (toolBlocks) never shows orphans, but committed turn_summary
	// cards include them, exactly like the reference.
	turnSummaryOrder                   []string
	turnSummary                        map[string]toolBlockInfo
	streamBuf                          string
	thinkingBuf                        string
	thinkingTextStart                  time.Time
	thinkingDuration                   float64
	outputGeneration                   int
	flushScheduled                     bool
	totalCacheRead, totalCacheCreation int
	subagents                          map[string]*subagentProgress
	agentCh                            <-chan agent.AgentEvent
	cancelStream                       context.CancelFunc

	totalInput  int
	totalOutput int

	permDialog   bool
	permToolName string
	permDesc     string
	permRespCh   chan<- agent.PermissionReply
	permCursor   int

	cmdRegistry   *commands.Registry
	slashMenuOpen bool
	slashMatches  []*commands.Command
	slashCursor   int

	committedUpTo int

	atMenuOpen         bool
	atMatches          []string
	atCursor           int
	atPrefix           string
	dropdownDismissed  bool
	recentCommandCount int
	fileCache          []string
	fileCacheCwd       string
	fileCacheTime      time.Time
	fileFactsVersion   int
	fileCacheVersion   int
	pasteError         string
	pastingImage       bool
	pasteGeneration    int
	ctrlCDeadline      time.Time
	ctrlCGeneration    int
	toolsExpanded      bool
	pendingMessages    []queuedMessage
	steeringPending    []history.InputEntry
	queuePaused        bool
	retryStatus        string
	activityError      string
	compacting         bool
	providerSwitching  bool

	spinner spinner.Model

	instructionsContent string
	memoryContent       string

	mcpConfigs         []config.MCPServerConfig
	mcpMgr             *mcp.Manager
	mcpConnecting      bool
	mcpAnnounced       map[string]bool
	mcpServerInfo      string
	mcpModeDecided     bool
	pendingMCPCommands []string
	hookConfigs        []config.HookConfig

	historyEntries []string
	historyIndex   int
	historyDraft   *inputSnapshot

	sessionID  string
	goalBinder *goalBinder

	ideMentionCh chan vscode.IdeAtMention
	ideConn      *vscode.IdeConnection
	ideCancel    context.CancelFunc
	fileHistory  *file_history.History
	defaultTools tools.DefaultTools

	planApprovalDialog bool
	planApprovalCursor int
	planApprovalEditor inputEditor
	// selectorScrolls holds the per-dialog ContentViewport scroll position
	// (reference: ContentViewport useState, remounted with each dialog).
	selectorScrolls map[string]int
	// streamMarkdownCache mirrors the StreamingText useRef cache: the rendered
	// prefix of the streaming tail is reused across frames.
	streamMarkdownCache  markdownCache
	planFeedbackRequired bool

	rewindDialog       bool
	rewindSnapshots    []file_history.Snapshot
	rewindCursor       int
	rewindPhase        int
	rewindOptionCursor int

	askUserCh             chan tools.AskUserRequest
	subAgentProgressCh    chan subagent.SubAgentProgress
	askUserDialog         bool
	askUserQuestions      []tools.Question
	askUserCursors        []int
	askUserSelected       []map[int]bool
	askUserOther          []string
	askUserOtherMode      []bool
	askUserSelectionOrder [][]int
	askUserTextEditor     inputEditor
	askUserQIdx           int
	askUserRespCh         chan tools.QuestionResponse
	askUserAnswered       map[int]string
	askUserOnSubmit       bool
	askUserSubmitIdx      int
	skillCatalog          *skills.Catalog
	announcedSkills       map[string]bool
	taskMgr               *subagent.TaskManager
	todoList              *todo.TaskList
	memoryMgr             *memory.Manager
	memoryTasks           *background.Tasks
	memoryGeneration      int
	teamMgr               *teams.TeamManager

	// sandboxEnabled/sandboxAutoAllow are the mutable sandbox mode, initialized
	// from sandboxCfg and changed by /sandbox; configureBashSandbox applies them
	// at each run start (the reference's sandboxEnabled/sandboxAutoAllow state).
	sandboxEnabled        bool
	sandboxAutoAllow      bool
	sandboxCfg            *config.SandboxYamlConfig
	sandboxRuntime        *sandbox.Runtime
	EnableCoordinatorMode bool
	MCPLoading            string
	// permissionMode is the startup mode from config.yaml (`permission_mode:`);
	// plan is not a valid startup mode and falls back to default.
	permissionMode permissions.PermissionMode
	// memoryEnabled mirrors config.yaml `enable_memory:`; it gates the whole
	// auto-memory pipeline (injection, recall, extraction, consolidation).
	memoryEnabled bool

	modelDialog              bool
	modelDiscoveryCancel     context.CancelFunc
	modelDiscoveryGeneration int
	modelState               modelPickerState
	modelQuery               string
	// modelFocusedID tracks focus by model id (the entry identity), matching
	// the reference focusedId; modelFocusOther marks the free-text row.
	modelFocusedID  string
	modelFocusOther bool

	modelCustomMode   bool
	modelCustomText   string
	modelCustomCursor int

	loginDialog      bool
	loginInitial     *config.ProviderConfig
	loginForm        providerLoginForm
	loginCursor      int
	loginFieldCursor int
	loginFieldErrors map[string]string
	loginFormError   string
	loginSubmitting  bool
	// loginModelEdited blocks the discovery auto-fill once the user typed in
	// the model field.
	loginModelEdited     bool
	loginDiscovery       loginDiscoveryState
	loginDiscoveryGen    int
	loginDiscoveryCancel context.CancelFunc
	loginCompletedConn   *loginConnection

	providerDialog   bool
	providerQuery    string
	providerFocusURL string
	providerFocusSet bool

	resumeSessions []session.SessionInfo
	resumeDialog   bool
	resumeQuery    string
	// resumeFocusedID tracks focus by session id, matching the reference
	// focusedId.
	resumeFocusedID string
	resumeFocusSet  bool
}

func (m Model) dialogAvailableRows() int {
	_, _, rows := m.terminalBudgets()
	return rows
}

// initialPermissionMode resolves the config.yaml `permission_mode:` value to a
// startup mode. Plan is excluded: it is entered through the mode cycle or the
// ExitPlanMode tool, never at startup.
func initialPermissionMode(mode string) permissions.PermissionMode {
	switch permissions.PermissionMode(mode) {
	case permissions.ModeDefault, permissions.ModeAcceptEdits, permissions.ModeBypass:
		return permissions.PermissionMode(mode)
	}
	return permissions.ModeDefault
}

func New(providers []config.ProviderConfig, mcpConfigs []config.MCPServerConfig, hookConfigs []config.HookConfig, sandboxCfg *config.SandboxYamlConfig, defaultProvider int, permissionMode string, memoryEnabled bool) Model {
	ta := newInputEditor()

	sp := spinner.New()
	sp.Spinner = spinner.Spinner{
		Frames: SpinnerFrames,
		FPS:    80 * time.Millisecond,
	}
	sp.Style = lipgloss.NewStyle().Foreground(accentColor)

	askCh := make(chan tools.AskUserRequest, 1)
	subProgressCh := make(chan subagent.SubAgentProgress, 32)
	// The core tool set comes from the shared bootstrap constructor, exactly
	// like the reference app's mount-time createToolRegistry; the TeamManager
	// exists from mount so TeamTodoWrite can be part of that set.
	binder := &goalBinder{}
	initialTodos, _ := todo.NewTaskList(nil)
	wd, _ := os.Getwd()
	teamMgr := teams.NewTeamManager(wd)
	dt := bootstrap.CreateToolRegistry(initialTodos, bootstrap.ToolRegistryOptions{
		InteractionMode: "interactive",
		TeamMgr:         teamMgr,
		GoalManager:     func() *goal.GoalManager { return binder.get() },
	})
	reg := dt.Registry

	sCfg := sandboxCfg

	lifeCtx, lifeCancel := context.WithCancel(context.Background())
	m := Model{
		interactionStats: bootstrap.InteractionSummary{StartedAt: float64(time.Now().UnixMilli())},
		sessionID:        session.NewID(),
		loginForm:        newProviderLoginForm(nil),
		lifeCtx:          lifeCtx, lifeCancel: lifeCancel, hostPermissionCh: make(chan agent.PermissionRequestEvent, 32), userBashOutputCh: make(chan userBashOutputMsg, 16),
		memoryLoopCh:       make(chan memoryLoopMsg, 4),
		memorySystemCh:     make(chan memorySystemMsg, 64),
		providers:          providers,
		todoList:           initialTodos,
		teamMgr:            teamMgr,
		mcpConfigs:         mcpConfigs,
		mcpAnnounced:       map[string]bool{},
		announcedSkills:    map[string]bool{},
		sandboxRuntime:     &sandbox.Runtime{},
		hookConfigs:        hookConfigs,
		sandboxCfg:         sCfg,
		sandboxEnabled:     sCfg.SandboxEnabled(),
		sandboxAutoAllow:   sCfg.SandboxAutoAllow(),
		state:              stateProviderSelect,
		defaultProvider:    defaultProvider,
		providerCursor:     defaultProvider,
		permissionMode:     initialPermissionMode(permissionMode),
		memoryEnabled:      memoryEnabled,
		editor:             ta,
		conversation:       conversation.NewManager(),
		registry:           reg,
		defaultTools:       dt,
		cmdRegistry:        newUICommandRegistry(),
		spinner:            sp,
		askUserCh:          askCh,
		subAgentProgressCh: subProgressCh,
		goalBinder:         binder,
		ideMentionCh:       make(chan vscode.IdeAtMention, 16),
		selectorScrolls:    map[string]int{},
	}
	if m.providerCursor < 0 || m.providerCursor >= len(providers) {
		m.providerCursor = 0
	}

	if len(providers) > 0 {
		m.state = stateChat
		// The transcript header renders on the first WindowSizeMsg, before the
		// init command lands, so the remembered provider must be resolved here
		// (the reference initializes selectedProvider in useState).
		m.selectedProvider = config.ResolveDefaultProvider(providers, defaultProvider)
	}

	return m
}

func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.connectIde(), m.listenForAskUser(), m.listenForSubAgentProgress(), m.listenForHostPermission(), m.pollUIStatus(), m.checkUpdate(), m.listenUserBashOutput(), m.listenMemoryLoop(), m.listenMemorySystem()}
	if len(m.providers) > 0 {
		cmds = append(cmds, func() tea.Msg { return initSingleProviderMsg{} })
	}
	return tea.Batch(cmds...)
}

func (m Model) update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.BatchMsg:
		// A BatchMsg carries commands, not messages; bubbletea's Program runs
		// them concurrently itself. Executing them here keeps direct Update
		// calls (tests, embedded drivers) equivalent.
		current := m
		var cmds []tea.Cmd
		for _, batched := range msg {
			if batched == nil {
				continue
			}
			result := batched()
			if result == nil {
				continue
			}
			updated, cmd := current.update(result)
			if next, ok := updated.(Model); ok {
				current = next
			}
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
		return current, tea.Batch(cmds...)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.editor.SetWidth(msg.Width - boolColumn(msg.Width > 2)*2)

		if !m.ready {
			m.ready = true
			return m, tea.Println(m.renderTranscriptHeader())
		}
		return m, nil

	case ideConnectedMsg:
		m.ideConn = msg.connection
		m.ideCancel = msg.cancel
		return m, m.listenForIdeMentions()

	case ideAtMentionMsg:
		wd, _ := os.Getwd()
		text := ideMentionText(wd, msg.mention)
		before := []rune(m.editor.lines[m.editor.line])[:m.editor.col]
		if len(before) > 0 && !unicode.IsSpace(before[len(before)-1]) {
			text = " " + text
		}
		m.editor.InsertString(text)
		m.resizeInput()
		m.updateSlashMenu()
		m.updateAtMenu()
		return m, m.listenForIdeMentions()

	case subAgentProgressMsg:
		m.applySubagentProgress(msg.progress)
		return m, m.listenForSubAgentProgress()

	case askUserMsg:
		m.enqueueAsk(msg.req)
		return m, m.listenForAskUser()

	case hostPermissionMsg:
		m.enqueuePermission(msg.request)
		return m, m.listenForHostPermission()

	case userBashOutputMsg:
		if m.userBash == msg.run && m.userBashTool != nil {
			m.userBashTool.output = plainTerminalText(msg.output)
		}
		return m, m.listenUserBashOutput()

	case memoryLoopMsg:
		return m.handleMemoryLoop(msg)

	case memorySystemMsg:
		return m.handleMemorySystem(msg)
	case userBashDoneMsg:
		if m.userBash != msg.run {
			return m, nil
		}
		msg.run.mu.Lock()
		result := *msg.run.result
		msg.run.handled = true
		msg.run.mu.Unlock()
		m.chatMessages = append(m.chatMessages, userBashCard(result))
		m.pendingBashRecords = append(m.pendingBashRecords, userBashRecord(msg.run, result))
		m.userBash = nil
		m.userBashTool = nil
		m.fileFactsVersion++
		m.flushUserBashRecords(true)
		return m, m.commitStaticOutput()

	case updateNoticeMsg:
		m.latestVersion = msg.version
		return m, nil

	case uiStatusTickMsg:
		m.pruneInteractions()
		m.updateTodoCompletion()
		if m.taskMgr != nil {
			for id, p := range m.subagents {
				if p.taskID != "" {
					task := m.taskMgr.Get(p.taskID)
					if task == nil || task.Status != "running" {
						delete(m.subagents, id)
					}
				}
			}
		}
		if m.agentsDialog && len(m.agentEntries()) == 0 {
			m.agentsDialog = false
		}
		wake := m.wakeNotifications()
		return m, tea.Batch(m.pollUIStatus(), wake)

	case backgroundActionDoneMsg:
		if msg.err != nil {
			m.activityError = msg.err.Error()
		}
		return m, nil

	case workflowActionDoneMsg:
		m.workflowResuming = false
		if msg.err != nil {
			m.workflowError = msg.err.Error()
		} else if msg.output != "" {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: msg.output})
		}
		return m, nil

	case tea.KeyMsg:

		switch m.state {
		case stateProviderSelect:
			return m.handleProviderSelect(msg)
		case stateChat:
			return m.handleChat(msg)
		}

	case loginDiscoveryTickMsg:
		return m.handleLoginDiscoveryTick(msg)

	case loginDiscoveryDoneMsg:
		return m.handleLoginDiscoveryDone(msg)

	case initSingleProviderMsg:
		p := config.ResolveDefaultProvider(m.providers, m.defaultProvider)
		m.selectedProvider = p
		return m, m.activateInitialProvider(p)

	case forkSkillDoneMsg:
		if msg.err != nil {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Skill fork error: " + msg.err.Error()})
		} else {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "assistant", content: msg.result})
		}
		m.finishStreaming()
		return m, m.commitStaticOutput()

	case compactDoneMsg:
		m.compacting = false
		if m.cancelStream != nil {
			m.cancelStream()
			m.cancelStream = nil
		}
		switch {
		case msg.err != nil:
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Compact failed: " + msg.err.Error()})
		case msg.message == "":
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Compact: no changes."})
		default:
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Compact: " + msg.message})
		}
		return m, nil

	case modelDiscoveryDoneMsg:
		if msg.generation != m.modelDiscoveryGeneration || !m.modelDialog {
			return m, nil
		}
		if msg.err != nil {
			m.modelState = modelPickerState{status: ModelPickerError}
		} else if len(msg.models) == 0 {
			m.modelState = modelPickerState{status: ModelPickerEmpty}
		} else {
			m.modelState = modelPickerState{status: ModelPickerReady, models: msg.models}
		}
		return m, nil

	case providerChangeDoneMsg:
		return m.finishProviderChange(msg)

	case mcpReadyMsg:
		return m.applyMCPResult(msg)

	case outputFlushMsg:
		if msg.generation != m.outputGeneration {
			return m, nil
		}
		m.flushScheduled = false
		if len(m.turnSummaryOrder) == 0 {
			prefix := stableStreamingPrefix(m.streamBuf)
			if prefix != "" {
				if m.thinkingBuf != "" || m.thinkingDuration >= 1 {
					m.chatMessages = append(m.chatMessages, chatMessage{role: "turn_summary", content: m.thinkingBuf, thinkingDuration: m.thinkingDuration})
					m.thinkingBuf = ""
					m.thinkingTextStart = time.Time{}
					m.thinkingDuration = 0
				}
				m.chatMessages = append(m.chatMessages, chatMessage{role: "assistant", content: prefix})
				m.streamBuf = strings.TrimPrefix(m.streamBuf, prefix)
			}
		}
		cmd := m.commitStaticOutput()
		return m, cmd

	case spinner.TickMsg:
		// The reference animates the spinner on an 80ms interval whenever a
		// status label is shown and the state is not an error: streaming,
		// compacting and user Bash all keep the tick chain alive.
		if m.activityError == "" && (m.streaming || m.compacting || m.providerSwitching || m.userBash != nil) {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}

	case agentReadyMsg:
		m.startingAgent = false
		m.agentCh = msg.ch
		return m, m.listenForAgentEvents()

	case agentEventMsg:
		if msg.ch != m.agentCh {
			return m, nil
		}
		return m.handleAgentEvent(msg.event)

	case agentDoneMsg:
		if msg.ch != m.agentCh {
			return m, nil
		}
		m.drainSteeringLeftovers()
		m.finishStreaming()
		return m, nil

	case agentErrMsg:
		m.chatMessages = append(m.chatMessages, chatMessage{
			role:    "error",
			content: msg.err.Error(),
		})
		m.finishStreaming()
		return m, nil

	}

	return m, nil
}

func (m Model) handleChat(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Dialog key dispatch follows the InteractionDock priority in
	// src/ui/interaction-dock.tsx (the permission dialog is handled above).
	if m.loginDialog {
		return m.handleLoginDialog(msg)
	}

	if m.providerDialog {
		return m.handleProviderDialog(msg)
	}

	if m.modelDialog {
		return m.handleModelDialog(msg)
	}

	if m.planApprovalDialog {
		return m.handlePlanApproval(msg)
	}

	if m.rewindDialog {
		return m.handleRewindKeys(msg)
	}

	if m.resumeDialog {
		return m.handleResumeDialog(msg)
	}

	if m.permDialog {
		return m.handlePermDialog(msg)
	}
	if m.askUserDialog {
		return m.handleAskUserDialog(msg)
	}

	if m.agentsDialog {
		return m.handleAgentsDialog(msg)
	}
	if m.workflowsDialog {
		return m.handleWorkflowsDialog(msg)
	}
	if m.thinkingDialog {
		return m.handleThinkingDialog(msg)
	}
	return m.handleComposerKey(msg)
}
