package a2a

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/memory/background"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
	"github.com/yukino-js/yukino/yukino/internal/workflow"
)

// Runtime is the minimal agent runtime surface the A2A executor drives,
// mirroring the reference A2aRuntime interface.
type Runtime interface {
	SessionID() string
	Cwd() string
	Run(text string) (<-chan agent.AgentEvent, error)
	Abort()
	Dispose() error
}

// agentRuntime boots the full yukino agent stack for a cwd.
type agentRuntime struct {
	sessionID string
	cwd       string

	provider       *config.ProviderConfig
	client         llm.Client
	conv           *conversation.Manager
	registry       *tools.Registry
	checker        *permissions.Checker
	fileHistory    *file_history.History
	fileStateCache *tools.FileStateCache
	recoveryState  *compact.RecoveryState
	goalManager    *goal.GoalManager
	hookEngine     *hooks.Engine
	skillCatalog   *skills.Catalog
	activeSkills   map[string]string
	teamMgr        *teams.TeamManager
	taskMgr        *subagent.TaskManager
	todoList       *todo.TaskList
	memoryMgr      *memory.Manager
	memoryTasks    *background.Tasks
	memoryEnabled  bool
	contextWindow  int

	enableCoordinatorMode bool

	mcpMgr       *mcp.Manager
	mcpAnnounced map[string]bool
	currentAgent *agent.Agent

	mu       sync.Mutex
	cancel   context.CancelFunc
	disposed bool
}

// RuntimeFactory builds a runtime for cwd. When sessionID is supplied the
// runtime is a recreation of a previously evicted session and restores that
// session's transcript so the conversation continues across eviction.
type RuntimeFactory func(cwd string, sessionID string) (Runtime, error)

// CreateA2aRuntime is the default factory: it boots the full yukino agent
// stack for cwd in non-interactive mode.
func CreateA2aRuntime(cwd string, sessionID string) (Runtime, error) {
	restoring := sessionID != ""
	var saved []session.Message
	if restoring {
		var lerr error
		saved, lerr = session.LoadSession(cwd, sessionID)
		if lerr != nil {
			return nil, lerr
		}
		if len(saved) == 0 {
			return nil, errors.New(TranscriptUnavailableError)
		}
	} else {
		sessionID = session.NewID()
	}
	cfg, err := config.LoadConfig("", config.LoadOptions{})
	if err != nil {
		return nil, err
	}
	cfg = config.WithProjectMcpServers(cfg, cwd)
	provider := config.ResolveDefaultProvider(cfg.Providers, cfg.DefaultProvider)
	if err := hooks.Validate(cfg.Hooks); err != nil {
		return nil, err
	}

	r := &agentRuntime{
		sessionID:             sessionID,
		cwd:                   cwd,
		provider:              provider,
		conv:                  conversation.NewManager(),
		fileHistory:           file_history.New(sessionID),
		fileStateCache:        tools.NewFileStateCache(),
		recoveryState:         &compact.RecoveryState{},
		goalManager:           goal.NewGoalManager(cwd, sessionID),
		skillCatalog:          skills.LoadCatalog(cwd),
		activeSkills:          map[string]string{},
		teamMgr:               teams.NewTeamManager(cwd),
		memoryMgr:             memory.NewManager(cwd, nil),
		memoryEnabled:         cfg.MemoryEnabled(),
		contextWindow:         config.GetContextWindow(provider),
		enableCoordinatorMode: cfg.EnableCoordinatorMode,
		mcpAnnounced:          map[string]bool{},
	}
	r.teamMgr.CoordinatorMode = cfg.EnableCoordinatorMode
	// Restore pending notifications and reclaim interrupted teammates' work.
	r.teamMgr.RestoreFromDisk()
	_ = history.RegisterProject(cwd)

	store, err := todo.NewStore(sessionID)
	if err != nil {
		return nil, err
	}
	if r.todoList, err = todo.NewTaskList(store); err != nil {
		return nil, err
	}
	r.taskMgr = subagent.NewTaskManager()
	if err := r.taskMgr.UseSession(sessionID); err != nil {
		return nil, err
	}

	defaultTools := bootstrap.CreateToolRegistry(r.todoList, bootstrap.ToolRegistryOptions{
		InteractionMode: "non-interactive",
		TeamMgr:         r.teamMgr,
		WorkDir:         cwd,
		GoalManager:     func() *goal.GoalManager { return r.goalManager },
	})
	r.registry = defaultTools.Registry
	bootstrap.ConfigureBashSandbox(r.registry, cwd, cfg.Sandbox, nil)
	defaultTools.EditFile.FileHistory = r.fileHistory
	defaultTools.WriteFile.FileHistory = r.fileHistory

	env := prompt.DetectEnvironment(cwd)
	env.Model = provider.Model
	systemPrompt := prompt.BuildSystemPrompt(env)
	if r.client, err = llm.NewClient(provider, systemPrompt); err != nil {
		return nil, err
	}

	instructions := memory.LoadInstructions(cwd)
	memReminder := ""
	if r.memoryEnabled {
		memReminder = r.memoryMgr.BuildSystemReminder()
	}
	r.conv.InjectLongTermMemory(instructions, memReminder, "")

	if len(cfg.Hooks) > 0 {
		r.hookEngine = hooks.NewEngine(cfg.Hooks)
		r.hookEngine.AgentRunner = agentHookRunner(r.client)
	}

	tools.AttachBackgroundTaskManager(r.registry, r.taskMgr)
	manager := r.taskMgr
	r.registry.AddCleanup(func() error { return manager.StopAll(context.Background()) })
	r.registry.Register(&skills.LoadSkillTool{Catalog: r.skillCatalog, Host: r, ForkHost: r})
	r.registry.Register(&skills.InstallSkillTool{Cwd: cwd, Catalog: r.skillCatalog})

	r.registry.Register(&teams.TeamCreateTool{TeamMgr: r.teamMgr})
	r.registry.Register(&teams.TeamDeleteTool{TeamMgr: r.teamMgr})
	r.registry.Register(&teams.TeamListTool{TeamMgr: r.teamMgr})
	r.registry.Register(&teams.SendMessageTool{TeamMgr: r.teamMgr, SenderName: "leader"})
	r.registry.Register(&teams.TaskStopTool{TeamMgr: r.teamMgr, TaskManager: r.taskMgr})
	loader := subagent.NewAgentLoader()
	loader.LoadAll()
	r.registry.Register(&subagent.AgentTool{
		Client:        r.client,
		Provider:      provider,
		MemoryContent: memReminder,
		Registry:      r.registry,
		Protocol:      provider.Protocol,
		TaskMgr:       r.taskMgr,
		Loader:        loader,
		Conversation:  r.conv,
		TeamMgr:       r.teamMgr,
	})
	workflow.AttachWorkflow(workflow.WorkflowServiceOptions{
		WorkflowBackendOptions: workflow.WorkflowBackendOptions{
			Registry:    r.registry,
			GetClient:   func() llm.Client { return r.client },
			GetProvider: func() *config.ProviderConfig { return r.provider },
		},
		Cwd:         cwd,
		TaskManager: r.taskMgr,
	})

	if len(cfg.MCPServers) > 0 {
		mgr := mcp.NewManager(false)
		result := mgr.ConnectAll(context.Background(), cfg.MCPServers)
		r.mcpMgr = mgr
		for _, connected := range result.Tools {
			r.registry.Register(connected.Tool)
		}
		if len(result.Tools) > 0 {
			mcp.DecideAndApply(r.registry, provider.BaseURL, provider.Protocol, r.contextWindow, cfg.MCPLoading)
		}
	}

	r.checker = permissions.NewChecker(
		permissions.NewPathSandbox(cwd, true),
		permissions.NewRuleEngine(cwd),
		permissions.ModeDefault,
	)
	r.teamMgr.SetPermissionChecker(r.checker)
	if at, ok := r.registry.Get("Agent").(*subagent.AgentTool); ok {
		at.ParentChecker = r.checker
	}
	mode := cfg.PermissionMode
	if mode == "" {
		mode = string(permissions.ModeDefault)
	}
	r.checker.SetMode(permissions.PermissionMode(mode))

	if restoring {
		// Recreation after idle eviction: replay the persisted transcript.
		// Long-term memory/instructions were already injected at the front of
		// the conversation, so appending keeps that ordering intact.
		r.conv.AppendMessages(session.RebuildFromSession(saved, false))
	}
	return r, nil
}

// SessionID implements Runtime.
func (r *agentRuntime) SessionID() string { return r.sessionID }

// Cwd implements Runtime.
func (r *agentRuntime) Cwd() string { return r.cwd }

// SetPermissionMode applies the configured permission mode.
func (r *agentRuntime) SetPermissionMode(mode permissions.PermissionMode) {
	r.checker.SetMode(mode)
}

// AppendMessages replays transcript messages into the conversation.
func (r *agentRuntime) AppendMessages(messages []conversation.Message) {
	r.conv.AppendMessages(messages)
}

// Run executes one agent turn for the user text and returns the event
// stream, mirroring the reference AgentHandleImpl.run for the A2A path.
func (r *agentRuntime) Run(text string) (<-chan agent.AgentEvent, error) {
	r.mu.Lock()
	if r.disposed {
		r.mu.Unlock()
		return nil, errors.New("agent runtime is disposed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.mu.Unlock()

	out := make(chan agent.AgentEvent, 32)

	commandName, commandArgs, isCommand := commands.Parse(text)
	isGoal := isCommand && commandName == "goal"

	inputOptions := history.InputOptions{Cwd: r.cwd, SessionID: &r.sessionID, Source: "sdk", Text: text}
	if isGoal {
		name := "goal"
		inputOptions.CommandName = &name
	}
	input, err := history.RecordInput(inputOptions)
	if err != nil {
		cancel()
		return nil, err
	}

	if isGoal {
		result := goal.HandleGoalCommand(r.goalManager, commandArgs)
		go func() {
			defer close(out)
			out <- agent.StreamText{Text: result.Message + "\n"}
			if result.Prompt == "" {
				out <- agent.LoopComplete{StopReason: "end_turn"}
				return
			}
			out <- agent.TurnComplete{}
			r.runAgent(ctx, out, result.Prompt, input)
		}()
		return out, nil
	}

	go func() {
		defer close(out)
		r.runAgent(ctx, out, text, input)
	}()
	return out, nil
}

// runAgent saves the user message, announces MCP instructions (replay-aware,
// per run like the reference AgentHandleImpl.run), builds the agent and
// forwards its events to out.
func (r *agentRuntime) runAgent(ctx context.Context, out chan<- agent.AgentEvent, text string, input history.InputEntry) {
	if _, err := session.SaveUserMessage(r.cwd, r.sessionID, input, session.Message{Content: text}); err != nil {
		out <- agent.ErrorEvent{Message: err.Error()}
		return
	}
	r.conv.AddUserMessage(text)

	if r.mcpMgr != nil {
		mcp.SyncMcpInstructions(r.conv, r.mcpAnnounced, r.mcpMgr)
	}

	ag := agent.New(r.client, r.registry, r.provider.Protocol)
	ag.WorkDir = r.cwd
	r.mu.Lock()
	r.currentAgent = ag
	r.mu.Unlock()
	ag.ContextWindow = r.contextWindow
	ag.MaxOutputTokens = config.GetMaxOutputTokens(r.provider)
	ag.InstructionsFn = func() string { return memory.LoadInstructions(r.cwd) }
	ag.MemoryContentFn = func() string {
		if !r.memoryEnabled {
			return ""
		}
		return r.memoryMgr.BuildSystemReminder()
	}
	ag.SkillSection = skills.BuildSkillSection(r.skillCatalog)
	ag.SkillDeltaFn = func() string {
		section := skills.BuildSkillSection(r.skillCatalog)
		if section != "" && !r.conv.HasReminderContaining(section) {
			return section
		}
		return ""
	}
	ag.FileHistory = r.fileHistory
	ag.FileStateCache = r.fileStateCache
	ag.RecoveryState = r.recoveryState
	ag.SetSessionID(r.sessionID)
	ag.GoalManager = r.goalManager
	ag.Checker = r.checker
	ag.Hooks = r.hookEngine
	ag.TaskManager = r.taskMgr
	ag.ToolNameFilter = teams.CoordinatorToolFilter(r.enableCoordinatorMode)
	ag.CoordinatorActiveFn = teams.CoordinatorActiveFn(r.enableCoordinatorMode)
	ag.NotificationFn = func() ([]string, error) {
		var messages []string
		if r.taskMgr != nil {
			drained, err := r.taskMgr.DrainNotifications()
			if err != nil {
				return nil, err
			}
			for _, n := range drained {
				messages = append(messages, subagent.FormatAgentTaskNotification(n))
			}
		}
		return append(messages, teams.DrainLeadMailbox(r.teamMgr)...), nil
	}
	for name, body := range r.activeSkills {
		ag.ActivateSkill(name, body)
	}
	if r.memoryEnabled {
		// Mirrors the reference onLoopComplete: lazily create the tasks on the
		// first loop completion and skip them once the runtime is disposed.
		ag.OnLoopComplete = func(loopConv *conversation.Manager) {
			r.mu.Lock()
			if r.disposed {
				r.mu.Unlock()
				return
			}
			if r.memoryTasks == nil {
				r.memoryTasks = background.New(r.client, r.cwd, background.Callbacks{
					AppendSystem: func(s string) { r.conv.AddSystemReminder(s) },
				})
			}
			tasks := r.memoryTasks
			r.mu.Unlock()
			tasks.Run(loopConv)
		}
	}

	for event := range ag.Run(ctx, r.conv) {
		out <- event
	}
}

// Abort cancels the active run.
func (r *agentRuntime) Abort() {
	r.mu.Lock()
	cancel := r.cancel
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Dispose releases the runtime's resources.

func (r *agentRuntime) ActivateSkill(name, body string) {
	r.activeSkills[name] = body
	r.mu.Lock()
	agentRef := r.currentAgent
	r.mu.Unlock()
	if agentRef != nil {
		agentRef.ActivateSkill(name, body)
	}
}

func (r *agentRuntime) SnapshotParentMessages(count int) string {
	messages := r.conv.GetMessages()
	if len(messages) > count {
		messages = messages[len(messages)-count:]
	}
	lines := make([]string, 0, len(messages))
	for _, message := range messages {
		content := any(message.Content)
		if len(message.ContentBlocks) > 0 {
			content = message.ContentBlocks
		}
		lines = append(lines, message.Role+": "+utils.ContentToText(content))
	}
	return strings.Join(lines, "\n")
}

func (r *agentRuntime) RunSubagent(ctx context.Context, prompt string) (string, error) {
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
	return subagent.SpawnSubagent(ctx, definition, prompt, r.client, r.registry, r.provider, r.cwd, nil, nil, "", r.checker, subagent.SubagentRunOptions{Background: false})
}

func (r *agentRuntime) Dispose() error {
	r.mu.Lock()
	if r.disposed {
		r.mu.Unlock()
		return nil
	}
	r.disposed = true
	if r.cancel != nil {
		r.cancel()
	}
	tasks := r.memoryTasks
	r.memoryTasks = nil
	r.mu.Unlock()
	if tasks != nil {
		tasks.Dispose()
	}
	if r.teamMgr != nil {
		r.teamMgr.CloseAll()
	}
	if r.mcpMgr != nil {
		r.mcpMgr.DisconnectAll()
	}
	if r.registry != nil {
		return r.registry.Dispose()
	}
	return nil
}

// agentHookRunner runs a hook's agent prompt through the LLM client.
func agentHookRunner(client llm.Client) func(prompt string, ctx hooks.HookContext) (string, error) {
	return func(p string, _ hooks.HookContext) (string, error) {
		c, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		conv := conversation.NewManager()
		conv.AddUserMessage(p)
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
