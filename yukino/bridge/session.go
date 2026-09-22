// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/agent"
	"github.com/hangtiancheng/yukino-code/yukino/commands"
	"github.com/hangtiancheng/yukino-code/yukino/compact"
	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/file_history"
	"github.com/hangtiancheng/yukino-code/yukino/hooks"
	"github.com/hangtiancheng/yukino-code/yukino/jsonrpc"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/mcp"
	"github.com/hangtiancheng/yukino-code/yukino/memory"
	"github.com/hangtiancheng/yukino-code/yukino/memory/extractor"
	"github.com/hangtiancheng/yukino-code/yukino/permissions"
	"github.com/hangtiancheng/yukino-code/yukino/plan_file"
	"github.com/hangtiancheng/yukino-code/yukino/prompt"
	"github.com/hangtiancheng/yukino-code/yukino/sandbox"
	yukino_session "github.com/hangtiancheng/yukino-code/yukino/session"
	"github.com/hangtiancheng/yukino-code/yukino/skills"
	"github.com/hangtiancheng/yukino-code/yukino/subagent"
	"github.com/hangtiancheng/yukino-code/yukino/teams"
	"github.com/hangtiancheng/yukino-code/yukino/todo"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// promptQueueSize bounds how many turns may wait while one is running. Past
// that the user is told to slow down rather than silently piling up work.
const promptQueueSize = 8

// promptJob is one queued turn. In the websocket deployment the turn is
// already persisted by the chat pipeline and carries its ids; the stdio
// transport submits prompts directly and leaves the chat ids empty.
type promptJob struct {
	chatSessionID string
	messageID     string
	content       string
	// blocks carries multimodal content (text + image blocks) for the turn. It
	// is nil for text-only and slash-command turns, in which case content alone
	// is added to the conversation.
	blocks []map[string]any
}

// Session is one user's private agent: its own conversation, tool registry,
// slash-command state and sandboxed workspace. Everything after start() that
// touches the agent runs on the single worker goroutine, so a user's turns are
// strictly serialized and the registry is never mutated concurrently.
type Session struct {
	userID   string
	workDir  string
	sink     ChatSink
	provider config.ProviderConfig
	appCfg   *config.AppConfig
	// mgr is the owner, consulted for anything shared between users — today
	// that is the MCP connection pool.
	mgr *Manager

	connMu sync.Mutex
	conns  map[Conn]struct{}

	queue    chan promptJob
	done     chan struct{}
	stopOnce sync.Once

	// cmdMu guards cmdRegistry and skillCatalog. The TUI mutates these from a
	// single loop; here the worker, attaching clients and the skill-install
	// callback (which runs on an agent tool goroutine) all reach them. Reads
	// dominate (every attach and slash command), writes happen only on skill
	// install or reload, hence the RWMutex.
	cmdMu sync.RWMutex

	// Worker-goroutine state.
	ag              *agent.Agent
	conv            *conversation.Manager
	registry        *tools.Registry
	defaultTools    tools.DefaultTools
	client          llm.Client
	sessionID       string
	fileHistory     *file_history.History
	askUserCh       chan tools.AskUserRequest
	cmdRegistry     *commands.Registry
	usageTracker    *commands.UsageTracker
	skillCatalog    *skills.Catalog
	taskMgr         *subagent.TaskManager
	todoList        *todo.TaskList
	memoryMgr       *memory.Manager
	memoryExtractor *extractor.Extractor
	teamMgr         *teams.TeamManager
	mcpToolCount    int
	instructions    string
	memoryContent   string
	skillSection    string
	// announcedMCP tracks which servers' instructions have already been
	// announced in this conversation; mcp.SyncInstructions compares it against
	// the live connections each turn (TS: syncMcpInstructions).
	announcedMCP map[string]bool
	mcpSource    *mcp.Manager
	agentCh      <-chan agent.AgentEvent
	// chatSessionID is the chat conversation the turn being served belongs to,
	// so replies are filed under the same session as the prompt.
	chatSessionID string

	stateMu    sync.Mutex
	streaming  bool
	cancelRun  context.CancelFunc
	cancelled  bool
	ready      bool
	lastActive time.Time
	// anchorID is the chat message new ephemeral items belong after, so a
	// client that connects mid-run still places tool cards correctly.
	anchorID  string
	lastUsage [2]int

	pendingMu sync.Mutex
	// Requests are kept alongside their reply channel so a reconnecting client
	// can be shown the prompt it still owes an answer to.
	pendingPerms   map[string]chan<- agent.PermissionResponse
	pendingAsks    map[string]chan tools.QuestionResponse
	pendingPrompts map[string]jsonrpc.Notification
}

func newSession(mgr *Manager, userID, workDir string) (*Session, error) {
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return nil, fmt.Errorf("create workspace: %w", err)
	}
	s := &Session{
		userID:  userID,
		workDir: workDir,
		mgr:     mgr,
		sink:    mgr.sink,
		// A copy: each session resolves and caches its own context window.
		provider:       mgr.provider,
		appCfg:         mgr.cfg,
		conns:          make(map[Conn]struct{}),
		queue:          make(chan promptJob, promptQueueSize),
		done:           make(chan struct{}),
		lastActive:     time.Now(),
		pendingPerms:   make(map[string]chan<- agent.PermissionResponse),
		pendingAsks:    make(map[string]chan tools.QuestionResponse),
		pendingPrompts: make(map[string]jsonrpc.Notification),
	}
	if err := s.initAgent(); err != nil {
		return nil, err
	}
	go s.worker()
	return s, nil
}

// initAgent mirrors the yukino TUI's single-provider startup, scoped to this
// user's workspace. Everything derived from a working directory — skills,
// instructions, memory, sessions, todos, the permission sandbox — therefore
// stays inside that user's directory.
func (s *Session) initAgent() error {
	p := &s.provider
	wd := s.workDir

	s.askUserCh = make(chan tools.AskUserRequest, 1)
	s.defaultTools = tools.CreateDefaultToolsWithWorkDir(wd)
	s.registry = s.defaultTools.Registry
	s.registry.Register(&tools.AskUserQuestionTool{RequestCh: s.askUserCh})

	s.cmdRegistry = commands.CreateDefaultRegistry()
	// User-defined commands from .yukino/commands/*.md (TS: app.tsx:839-845).
	// A name clash with a built-in keeps the built-in, hence the recover.
	for _, userCmd := range commands.LoadUserCommands(wd) {
		func() {
			defer func() { _ = recover() }()
			s.cmdRegistry.Register(userCmd)
		}()
	}
	s.usageTracker = commands.NewUsageTracker(wd)
	s.skillCatalog = skills.LoadCatalog(wd)
	s.instructions = memory.LoadInstructions(wd)
	s.memoryContent = memory.LoadAutoMemoryPrompt(wd)
	s.skillSection = skills.BuildSkillSection(s.skillCatalog, wd)

	env := prompt.DetectEnvironment(wd)
	env.Model = p.Model
	client, err := llm.NewClient(p, prompt.BuildSystemPrompt(env))
	if err != nil {
		return err
	}
	s.client = client
	s.conv = conversation.NewManager()
	s.sessionID = yukino_session.NewID()
	s.fileHistory = file_history.New(wd, s.sessionID)
	s.defaultTools.EditFile.FileHistory = s.fileHistory
	s.defaultTools.WriteFile.FileHistory = s.fileHistory

	s.registerTools(client, p, wd)

	ag := agent.New(client, s.registry, p.Protocol)
	ag.WorkDir = wd
	ag.Instructions = s.instructions
	ag.MemoryContent = s.memoryContent
	ag.SkillSection = s.skillSection
	ag.FileHistory = s.fileHistory
	// TS app.tsx passes the registry-shared file state cache into the Agent,
	// which injects it into every tool context; subagent runs get fresh caches
	// per run instead of sharing this one.
	ag.FileStateCache = s.defaultTools.FileStateCache
	ag.SetSessionID(s.sessionID)

	// The sandbox is the whole isolation story between chat users: only this
	// user's workspace is reachable, and the shared ~/.yukino memory is
	// deliberately left out so one user cannot write what another one reads.
	ag.Checker = permissions.NewChecker(
		permissions.NewPathSandbox(wd, memory.GetAutoMemPath(wd)),
		permissions.NewRuleEngine(wd),
		resolveMode(s.appCfg.PermissionMode),
	)

	// OS sandbox (TS: app.tsx runAgentLoop "Attach the sandbox to the BashTool
	// when sandboxing is enabled"). Only the native backend exists in Go;
	// "sandbox-runtime" has no counterpart and is documented in the README.
	// Auto-allow is enabled only when the requested backend is actually ready,
	// so a missing bwrap/seatbelt leaves the normal permission prompts in place.
	if s.appCfg.Sandbox.Enabled && s.appCfg.Sandbox.BackendOrDefault() == "native" {
		if sb := sandbox.New(); sb != nil && sb.Available() {
			if bashTool, ok := s.registry.Get("Bash").(*tools.BashTool); ok {
				bashTool.Sandbox = sb
				bashTool.SandboxRequired = true
				bashTool.SandboxConfig = &sandbox.Config{
					AllowWrite:     []string{wd, os.TempDir()},
					NetworkEnabled: s.appCfg.Sandbox.NetworkEnabled,
				}
			}
			ag.Checker.SandboxEnabled = true
			ag.Checker.SandboxAutoAllow = s.appCfg.Sandbox.AutoAllow
		}
	}

	if len(s.appCfg.Hooks) > 0 {
		eng := hooks.NewEngine()
		eng.LoadHooks(s.appCfg.Hooks)
		eng.AgentRunner = newAgentHookRunner(client)
		ag.Hooks = eng
	}

	coordinator := s.appCfg.EnableCoordinatorMode
	ag.NotificationFn = func() []string {
		var messages []string
		if s.taskMgr != nil {
			for _, n := range s.taskMgr.DrainNotifications() {
				messages = append(messages, fmt.Sprintf(
					"<task-notification>\n<task_id>%s</task_id>\n<status>%s</status>\n<summary>Agent \"%s\" %s</summary>\n<result>%s</result>\n</task-notification>",
					n.TaskID, n.Status, n.Name, n.Status, n.Output))
			}
		}
		return append(messages, teams.DrainLeadMailbox(s.teamMgr)...)
	}
	ag.ToolNameFilter = teams.CoordinatorToolFilter(coordinator)
	ag.CoordinatorActiveFn = teams.CoordinatorActiveFn(coordinator)

	s.ag = ag
	// The Agent tool reads the parent permission checker from the per-call
	// tool context (TS: ctx.permissionChecker), which the agent loop attaches
	// on every execution — no host wiring needed.
	s.registry.Register(&skills.LoadSkillTool{Catalog: s.skillCatalog, Host: s})
	for _, meta := range s.skillCatalog.List() {
		s.registerSkillCommand(meta.Name)
	}
	s.registry.Register(&skills.InstallSkillTool{
		Catalog: s.skillCatalog,
		OnInstalled: func(name string) {
			s.registerSkillCommand(name)
			s.refreshSkillSection()
			s.notify(MethodSessionCommands, s.commandList())
		},
	})
	s.memoryExtractor = installMemExtractor(ag, wd, p.Protocol, client, s.registry, s.conv)
	return nil
}

func (s *Session) registerTools(client llm.Client, p *config.ProviderConfig, wd string) {
	s.taskMgr = subagent.NewTaskManager()
	s.todoList = todo.NewTaskList(todo.NewStore(wd, s.sessionID))
	s.memoryMgr = memory.NewManager(wd)
	loader := subagent.NewAgentLoader(wd)
	loader.LoadAll()
	// Team file location: TS persists teams under ~/.yukino/teams. The
	// concurrent (multi-user chat-server) mode keeps them inside the session
	// workspace instead so each user's team state (config.json, tasks.json,
	// inboxes, transcripts) stays isolated.
	teamsBase := teams.TeamsBaseDir()
	if s.appCfg.Concurrent {
		teamsBase = filepath.Join(wd, "teams")
	}
	s.teamMgr = teams.NewTeamManager(teamsBase, wd)

	// Tools that createToolRegistry/the TUI register but the six defaults do
	// not cover (TS: bootstrap/tool-registry.ts + app.tsx). ComputerUse is
	// deliberately absent: it drives the host's screen, and this process is
	// shared by every chat user — the multi-user host must never expose it.
	s.registry.Register(&tools.PowerShellTool{WorkDir: wd})
	s.registry.Register(&tools.WebFetchTool{})
	s.registry.Register(&tools.EnterWorktreeTool{})
	s.registry.Register(&tools.ExitWorktreeTool{})

	s.registry.Register(&tools.ExitPlanModeTool{
		IsPlanMode: func() bool {
			return s.ag != nil && s.ag.Checker != nil && s.ag.Checker.Mode == permissions.ModePlan
		},
		PlanExists: func() bool { return plan_file.PlanExists(wd) },
	})
	s.registry.Register(&todo.TaskCreateTool{List: s.todoList})
	s.registry.Register(&todo.TaskGetTool{List: s.todoList})
	s.registry.Register(&todo.TaskListTool{List: s.todoList})
	s.registry.Register(&todo.TaskUpdateTool{List: s.todoList})
	s.registry.Register(&tools.ToolSearchTool{Registry: s.registry, Protocol: p.Protocol})
	s.registry.Register(&tools.McpCallTool{Registry: s.registry})
	s.registry.Register(&teams.TeamCreateTool{TeamMgr: s.teamMgr})
	s.registry.Register(&teams.TeamDeleteTool{TeamMgr: s.teamMgr})
	s.registry.Register(&teams.SendMessageTool{TeamMgr: s.teamMgr, SenderName: "lead"})
	// TaskBoard makes TaskStop's task_id path live; ListTeams and
	// SpawnTeammate mirror the TUI registry (app.tsx:808-825).
	s.registry.Register(&teams.TaskStopTool{TeamMgr: s.teamMgr, TaskBoard: s.taskMgr})
	s.registry.Register(&tools.SyntheticOutputTool{})
	agentTool := &subagent.AgentTool{
		Client:          client,
		ModelResolver:   llm.NewModelResolver(*p),
		Registry:        s.registry,
		Protocol:        p.Protocol,
		TaskMgr:         s.taskMgr,
		Loader:          loader,
		Conversation:    s.conv,
		TeamMgr:         s.teamMgr,
		WorkDir:         wd,
		ForkDisabled:    !s.appCfg.ForkEnabled(),
		ContextWindow:   p.GetContextWindow(),
		MaxOutputTokens: p.GetMaxOutputTokens(),
	}
	s.registry.Register(agentTool)
	s.registry.Register(&teams.SpawnTeammateTool{TeamMgr: s.teamMgr, Spawn: agentTool.SpawnTeamMember})
	s.registry.Register(&teams.ListTeamsTool{TeamMgr: s.teamMgr})

	// Wire the background task manager into the shell tools so Bash/PowerShell
	// can run commands in the background (watchdog, spill, non-zero exit codes)
	// instead of always taking the legacy foreground path.
	tools.AttachBackgroundTaskManager(s.registry, s.taskMgr)
}

// restoreLatestSession reloads the user's most recent transcript so context
// survives an idle eviction or a server restart. The chat history the user sees
// lives in MongoDB; this only rebuilds what the model remembers.
func (s *Session) restoreLatestSession() {
	sessions := yukino_session.ListSessions(s.workDir)
	if len(sessions) == 0 {
		return
	}
	s.loadSessionContext(sessions[0].ID)
}

// loadSessionContext replaces the model's context with a stored transcript and
// adopts its id, so further turns append to the same file. It reports how many
// messages were replayed and whether they came from a compacted checkpoint.
func (s *Session) loadSessionContext(id string) (int, bool) {
	msgs := yukino_session.LoadSession(s.workDir, id)
	if len(msgs) == 0 {
		return 0, false
	}
	s.sessionID = id
	s.ag.SetSessionID(id)
	s.fileHistory = file_history.New(s.workDir, id)
	s.ag.FileHistory = s.fileHistory
	s.defaultTools.EditFile.FileHistory = s.fileHistory
	s.defaultTools.WriteFile.FileHistory = s.fileHistory

	boundary, after, compacted := yukino_session.FindLastCompactBoundary(msgs)
	replay := msgs
	if compacted {
		// Use the library formatter (same wording as the compaction path) and
		// skip kept records the TS rebuild would drop: non-conversation roles
		// and records with no content and no tool blocks (TS session/index.ts).
		summary := compact.BuildCompactionSummaryMessage(boundary.Summary, len(boundary.Keep) > 0)
		replay = []yukino_session.Message{{Role: "user", Content: summary}}
		for _, k := range boundary.Keep {
			if (k.Role != "user" && k.Role != "assistant") ||
				(k.Content == "" && len(k.ToolUses) == 0 && len(k.ToolResults) == 0) {
				continue
			}
			replay = append(replay, yukino_session.Message{
				Role: k.Role, Content: k.Content, ToolUses: k.ToolUses, ToolResults: k.ToolResults,
			})
		}
		replay = append(replay, after...)
	}

	s.conv.Reset()
	for _, msg := range replay {
		s.conv.AppendMessages([]conversation.Message{msg.ToConversation()})
	}
	return len(replay), compacted
}

// worker owns every mutation of the agent. Provider resolution, transcript
// restore and MCP startup happen here rather than in newSession so their I/O —
// and a slow or hanging MCP server — delays only its own user instead of the
// chat event loop that dispatched the message.
func (s *Session) worker() {
	s.ag.ContextWindow = s.provider.GetContextWindow()
	s.ag.MaxOutputTokens = s.provider.GetMaxOutputTokens()
	s.restoreLatestSession()
	s.initMCP()

	// Startup can take tens of seconds when MCP servers are configured, and a
	// prompt sent in the meantime just waits in the queue. Clients are told the
	// moment that is over so they can stop showing the agent as warming up.
	s.stateMu.Lock()
	s.ready = true
	s.stateMu.Unlock()
	s.notify(MethodSessionReady, nil)

	for {
		select {
		case <-s.done:
			return
		case job := <-s.queue:
			s.handlePrompt(job)
		}
	}
}

// initMCP gives this agent its own wrappers over the process-wide MCP
// connections. The connections are shared because each one costs a child
// process or a socket; the wrappers are not, because ApplyMode writes a defer
// flag on them per registry.
func (s *Session) initMCP() {
	mgr, _ := s.mgr.sharedMCP()
	if mgr == nil {
		return
	}
	toolSet := mgr.NewToolSet()
	if len(toolSet) == 0 {
		// Every server failed. This agent then behaves exactly like one on a
		// host with no MCP configured at all.
		return
	}
	for _, t := range toolSet {
		s.registry.Register(t)
	}
	s.mcpToolCount = len(toolSet)
	mcp.DecideAndApply(s.registry, s.provider.BaseURL, s.provider.GetContextWindow())
	// Announce server instructions as deltas; history is the source of truth,
	// so /clear, /resume and compaction reset the announcement (TS:
	// app.tsx syncMcpInstructions).
	s.mcpSource = mgr
	s.announcedMCP = make(map[string]bool)
	mcp.SyncInstructions(s.conv, s.announcedMCP, mgr)
}

// enqueue hands a turn to the worker and reports whether it was queued. A
// full queue means the user is far ahead of the agent, which is worth saying
// out loud.
func (s *Session) enqueue(job promptJob) bool {
	select {
	case s.queue <- job:
		return true
	default:
		s.notify(MethodAgentSystem, map[string]string{
			"message": "Yukino is still working through earlier messages — please wait for it to catch up.",
		})
		return false
	}
}

// SubmitPrompt queues one turn directly. This is the stdio transport's entry
// point — there is no chat pipeline in that deployment, so the prompt carries
// no chat ids and finalized text is not filed anywhere (the sink decides).
// It reports whether the turn was queued or dropped because the queue is full.
func (s *Session) SubmitPrompt(content string) bool {
	return s.enqueue(promptJob{content: content})
}

// SubmitPromptBlocks queues one multimodal turn. text is the display/transcript
// form of the turn; blocks is the content-block list (text + image) the model
// actually sees. Used by the pb/Connect transport, where a turn may carry image
// attachments alongside text.
func (s *Session) SubmitPromptBlocks(text string, blocks []map[string]any) bool {
	return s.enqueue(promptJob{content: text, blocks: blocks})
}

// SwitchProvider rebuilds the session's LLM client for the named provider from
// the loaded config, mirroring the TUI's provider switch: the conversation,
// registry and session id are preserved, and only the client/protocol/window
// change. It refuses to switch while a turn is running. The client rebuild
// happens outside the lock (it detects the environment and builds the system
// prompt but does no network I/O until the first Stream); the swap itself is
// guarded by stateMu, which beginRun also takes, so a switch can never
// interleave with a turn starting.
func (s *Session) SwitchProvider(name string) (model, protocol string, contextWindow, maxOutputTokens int, err error) {
	if s.mgr == nil || s.mgr.cfg == nil {
		return "", "", 0, 0, fmt.Errorf("session has no config")
	}
	var prov *config.ProviderConfig
	for i := range s.mgr.cfg.Providers {
		if s.mgr.cfg.Providers[i].Name == name {
			prov = &s.mgr.cfg.Providers[i]
			break
		}
	}
	if prov == nil {
		return "", "", 0, 0, fmt.Errorf("provider %q not found in config", name)
	}
	env := prompt.DetectEnvironment(s.workDir)
	env.Model = prov.Model
	client, err := llm.NewClient(prov, prompt.BuildSystemPrompt(env))
	if err != nil {
		return "", "", 0, 0, err
	}
	s.stateMu.Lock()
	if s.streaming {
		s.stateMu.Unlock()
		return "", "", 0, 0, fmt.Errorf("cannot switch provider while a turn is running")
	}
	s.client = client
	s.provider = *prov
	s.ag.Client = client
	s.ag.Protocol = prov.Protocol
	s.ag.ContextWindow = prov.GetContextWindow()
	s.ag.MaxOutputTokens = prov.GetMaxOutputTokens()
	s.stateMu.Unlock()
	// Re-decide the MCP loading mode for the new endpoint (TS decideAndApply).
	if s.mcpSource != nil {
		mcp.DecideAndApply(s.registry, prov.BaseURL, prov.GetContextWindow())
	}
	return prov.Model, prov.Protocol, prov.GetContextWindow(), prov.GetMaxOutputTokens(), nil
}

func (s *Session) handlePrompt(job promptJob) {
	content := strings.TrimSpace(job.content)
	if content == "" && len(job.blocks) == 0 {
		return
	}
	s.refreshSkillsIfNeeded()
	s.chatSessionID = job.chatSessionID
	s.setAnchor(job.messageID)
	s.notify(MethodAgentRunStart, map[string]string{"userMessageId": job.messageID})

	if strings.HasPrefix(content, "/") {
		s.handleSlashCommand(content)
		return
	}
	s.runTurn(content, content, job.blocks)
}

// runTurn drives one agent loop. saveText is what the transcript records (for a
// slash command that is the command itself); promptText is what the model sees.
// blocks carries optional multimodal content blocks (text + image); when nil the
// turn is added as plain text.
func (s *Session) runTurn(saveText, promptText string, blocks []map[string]any) {
	yukino_session.SaveMessage(s.workDir, s.sessionID, yukino_session.Message{
		Role: "user", Content: saveText, Ts: time.Now().Unix(),
	})
	if len(blocks) > 0 {
		s.conv.AddUserMessageWithBlocks(promptText, blocks)
	} else {
		s.conv.AddUserMessage(promptText)
	}
	// Late-connecting MCP servers announce their instructions as a delta; a
	// server that disconnected is retracted (TS: syncMcpInstructions at turn
	// start).
	if s.mcpSource != nil {
		mcp.SyncInstructions(s.conv, s.announcedMCP, s.mcpSource)
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.beginRun(cancel)
	defer s.endRun()

	// Prefetch memories relevant to this turn in parallel with the LLM call;
	// the agent injects the result after tool execution (TS: app.tsx
	// findRelevantMemories + renderReminder, consumed via MemoryRecallCh).
	s.startMemoryRecall(ctx, promptText)

	s.agentCh = s.ag.Run(ctx, s.conv)
	askDone := make(chan struct{})
	go s.listenForAskUser(askDone)
	s.consumeAgentEvents()
	close(askDone)
	s.agentCh = nil
}

// startMemoryRecall prefetches memories relevant to this turn and feeds the
// agent's non-blocking recall channel (TS: app.tsx:1893-1908). The user-level
// memory directory is intentionally excluded: ~/.yukino/memory is shared by
// every chat user, so reading it would leak one user's memories into another
// user's context. The project directory keeps recall user-private.
func (s *Session) startMemoryRecall(ctx context.Context, query string) {
	if s.memoryMgr == nil || s.ag == nil || s.client == nil || strings.TrimSpace(query) == "" {
		return
	}
	recentTools, surfaced := s.ag.RecallHints()
	ch := make(chan agent.RecallResult, 1)
	s.ag.MemoryRecallCh = ch
	go func() {
		defer close(ch)
		selector := func(selectorCtx context.Context, userMessage string) (string, error) {
			return s.selectorCompletion(selectorCtx, userMessage)
		}
		memories, err := memory.FindRelevantMemories(ctx, query, "", s.memoryMgr.Dir(), recentTools, surfaced, selector)
		if err != nil || len(memories) == 0 {
			return
		}
		paths := make([]string, 0, len(memories))
		for _, m := range memories {
			paths = append(paths, m.Path)
		}
		ch <- agent.RecallResult{Reminder: memory.RenderReminder(memories), Paths: paths}
	}()
}

// selectorCompletion runs the recall selector's side query: one user message
// in, the model's raw text out (TS: the client call inside findRelevantMemories).
func (s *Session) selectorCompletion(ctx context.Context, userMessage string) (string, error) {
	conv := conversation.NewManager()
	conv.AddUserMessage(userMessage)
	events, errs := s.client.Stream(ctx, conv, nil)
	var text strings.Builder
	for ev := range events {
		if delta, ok := ev.(llm.TextDelta); ok {
			text.WriteString(delta.Text)
		}
	}
	select {
	case err := <-errs:
		if err != nil {
			return "", err
		}
	default:
	}
	return text.String(), nil
}

func (s *Session) consumeAgentEvents() {
	streamBuf := ""
	startTime := time.Now()
	completed := false

	for ev := range s.agentCh {
		switch e := ev.(type) {
		case agent.StreamText:
			streamBuf += e.Text
			s.notify(MethodAgentStreamText, map[string]string{"text": e.Text})

		case agent.ThinkingText:
			s.notify(MethodAgentThinkingText, map[string]string{"text": e.Text})

		case agent.ThinkingComplete:
			s.notify(MethodAgentThinkingComplete, map[string]string{
				"thinking": e.Thinking, "signature": e.Signature,
			})

		case agent.ToolUseEvent:
			// The text that led up to this call is finished, so it is committed
			// before the card is announced: the client anchors the card after
			// the message it follows, and that message has to exist first.
			streamBuf = s.flushText(streamBuf)
			s.notify(MethodAgentToolUse, map[string]any{
				"toolId": e.ToolID, "toolName": e.ToolName, "args": e.Args,
			})

		case agent.ToolResultEvent:
			s.notify(MethodAgentToolResult, map[string]any{
				"toolId": e.ToolID, "toolName": e.ToolName, "output": e.Output,
				"isError": e.IsError, "elapsed": e.Elapsed.Seconds(),
			})

		case agent.PermissionRequestEvent:
			s.requestPermission(e)

		case agent.TurnComplete:
			streamBuf = s.flushText(streamBuf)
			s.notify(MethodAgentTurnComplete, map[string]int{"turn": e.Turn})

		case agent.LoopComplete:
			completed = true
			streamBuf = s.flushText(streamBuf)
			s.notify(MethodAgentLoopComplete, map[string]any{
				"totalTurns": e.TotalTurns, "elapsed": time.Since(startTime).Seconds(),
				"stopReason": e.StopReason,
			})

		case agent.UsageEvent:
			s.recordUsage(e.InputTokens, e.OutputTokens)
			s.notify(MethodAgentUsage, map[string]int{
				"inputTokens": e.InputTokens, "outputTokens": e.OutputTokens,
			})

		case agent.ErrorEvent:
			// Cancelling a run surfaces as an error from the agent's point of
			// view. Stopping on purpose is not a failure, so it is not shown as
			// one; every other error still is.
			if s.cancelWasRequested() {
				continue
			}
			s.notify(MethodAgentError, map[string]string{"message": e.Message})

		case agent.CompactEvent:
			s.notify(MethodAgentCompact, map[string]string{"message": e.Message})

		case agent.RetryEvent:
			s.notify(MethodAgentRetry, map[string]any{
				"reason": e.Reason, "waitMs": e.Wait.Milliseconds(),
			})
		}
	}

	if completed {
		return
	}
	// A cancelled run closes its channel without ever reporting completion, so
	// the turn is closed out here: whatever was written is kept, and clients
	// are told the run is over or their composer stays stuck on Stop.
	s.flushText(streamBuf)
	if s.cancelWasRequested() {
		s.notify(MethodAgentSystem, map[string]string{"message": "Stopped."})
	}
	s.notify(MethodSessionCommandDone, nil)
}

// flushText commits one finished text block to the chat transcript and tells
// clients which message replaced the live stream, so the streaming bubble can
// hand over without flicker. Returns the drained buffer.
func (s *Session) flushText(buf string) string {
	if strings.TrimSpace(buf) == "" {
		return ""
	}
	messageID := s.sink.SaveAssistantText(s.userID, s.chatSessionID, buf)
	if messageID != "" {
		s.setAnchor(messageID)
	}
	s.notify(MethodAgentStreamEnd, map[string]string{"text": buf, "messageId": messageID})
	return ""
}

func (s *Session) requestPermission(e agent.PermissionRequestEvent) {
	id := fmt.Sprintf("perm_%d", time.Now().UnixNano())
	n := jsonrpc.NewNotification(MethodPermissionRequest, map[string]string{
		"id": id, "toolName": e.ToolName, "description": e.Desc,
	})
	s.pendingMu.Lock()
	s.pendingPerms[id] = e.ResponseCh
	s.pendingPrompts[id] = n
	s.pendingMu.Unlock()
	// A prompt raised while the stop was being delivered would miss the drain
	// in Cancel() and block the agent forever, so it is failed right away.
	if s.cancelWasRequested() {
		s.failPendingPrompts()
		return
	}
	s.notify(n.Method, n.Params)
}

func (s *Session) requestAnswers(questions any, deliver func(tools.QuestionResponse)) {
	id := fmt.Sprintf("ask_%d", time.Now().UnixNano())
	respCh := make(chan tools.QuestionResponse, 1)
	n := jsonrpc.NewNotification(MethodQuestionAsk, map[string]any{"id": id, "questions": questions})
	s.pendingMu.Lock()
	s.pendingAsks[id] = respCh
	s.pendingPrompts[id] = n
	s.pendingMu.Unlock()
	if s.cancelWasRequested() {
		// Feeds respCh with empty answers, so the receive below returns at once.
		s.failPendingPrompts()
	} else {
		s.notify(n.Method, n.Params)
	}
	// The receive is evaluated on this goroutine, which is what keeps command
	// handling ordered: deliver runs only once an answer (or a cancel) arrives.
	go deliver(<-respCh)
}

// listenForAskUser serves AskUserQuestion calls raised by the tool directly
// rather than through the agent event stream.
func (s *Session) listenForAskUser(done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case req, ok := <-s.askUserCh:
			if !ok {
				return
			}
			s.requestAnswers(req.Questions, func(resp tools.QuestionResponse) {
				req.ResponseCh <- resp
			})
		}
	}
}

// resolvePermission delivers one permission answer and reports whether the
// prompt was still pending (a late reply to an already-settled prompt is
// ignored, which the caller surfaces as applied=false).
func (s *Session) resolvePermission(id, response string) bool {
	s.pendingMu.Lock()
	ch, ok := s.pendingPerms[id]
	delete(s.pendingPerms, id)
	delete(s.pendingPrompts, id)
	s.pendingMu.Unlock()
	if !ok {
		return false
	}
	switch response {
	case "allow":
		ch <- agent.PermAllow
	case "allowAlways":
		ch <- agent.PermAllowAlways
	default:
		ch <- agent.PermDeny
	}
	return true
}

// resolveAsk delivers one set of question answers, reporting whether the
// prompt was still pending.
func (s *Session) resolveAsk(id string, answers map[string]string) bool {
	s.pendingMu.Lock()
	ch, ok := s.pendingAsks[id]
	delete(s.pendingAsks, id)
	delete(s.pendingPrompts, id)
	s.pendingMu.Unlock()
	if !ok {
		return false
	}
	ch <- tools.QuestionResponse{Answers: answers}
	return true
}

func (s *Session) beginRun(cancel context.CancelFunc) {
	s.stateMu.Lock()
	s.streaming = true
	s.cancelRun = cancel
	s.cancelled = false
	s.lastActive = time.Now()
	s.stateMu.Unlock()
}

func (s *Session) endRun() {
	s.stateMu.Lock()
	s.streaming = false
	s.cancelRun = nil
	s.lastActive = time.Now()
	s.stateMu.Unlock()
}

// Cancel stops the running turn, if any.
func (s *Session) Cancel() {
	s.stateMu.Lock()
	cancel := s.cancelRun
	if cancel != nil {
		s.cancelled = true
	}
	s.stateMu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	// The agent waits on permission and question answers without watching the
	// run context, so a run stopped mid-prompt would hang forever. Failing the
	// prompts is what lets the loop wake up and see the cancelled context.
	s.failPendingPrompts()
}

// failPendingPrompts denies every waiting permission request and returns empty
// answers to every waiting question. Reply channels are buffered, so this never
// blocks even when the asker already gave up.
func (s *Session) failPendingPrompts() {
	s.pendingMu.Lock()
	perms := s.pendingPerms
	asks := s.pendingAsks
	s.pendingPerms = make(map[string]chan<- agent.PermissionResponse)
	s.pendingAsks = make(map[string]chan tools.QuestionResponse)
	s.pendingPrompts = make(map[string]jsonrpc.Notification)
	s.pendingMu.Unlock()
	for _, ch := range perms {
		ch <- agent.PermDeny
	}
	for _, ch := range asks {
		ch <- tools.QuestionResponse{Answers: map[string]string{}}
	}
}

func (s *Session) cancelWasRequested() bool {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.cancelled
}

func (s *Session) setAnchor(id string) {
	s.stateMu.Lock()
	s.anchorID = id
	s.lastActive = time.Now()
	s.stateMu.Unlock()
}

func (s *Session) recordUsage(in, out int) {
	s.stateMu.Lock()
	s.lastUsage = [2]int{in, out}
	s.stateMu.Unlock()
}

func (s *Session) snapshot() (streaming, ready bool, anchor string, usage [2]int) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.streaming, s.ready, s.anchorID, s.lastUsage
}

func (s *Session) idleFor() time.Duration {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return time.Since(s.lastActive)
}

// Attach registers a client and brings it up to date: current run state, the
// command menu, and any prompt still waiting on an answer.
func (s *Session) Attach(c Conn) {
	s.connMu.Lock()
	s.conns[c] = struct{}{}
	s.connMu.Unlock()

	streaming, ready, anchor, usage := s.snapshot()
	s.sendTo(c, MethodSessionConnected, map[string]any{
		"model":          s.provider.Model,
		"streaming":      streaming,
		"ready":          ready,
		"anchorId":       anchor,
		"inputTokens":    usage[0],
		"outputTokens":   usage[1],
		"permissionMode": string(s.ag.Checker.Mode),
	})
	s.sendTo(c, MethodSessionCommands, s.commandList())

	s.pendingMu.Lock()
	pending := make([]jsonrpc.Notification, 0, len(s.pendingPrompts))
	for _, n := range s.pendingPrompts {
		pending = append(pending, n)
	}
	s.pendingMu.Unlock()
	for _, n := range pending {
		s.sendTo(c, n.Method, n.Params)
	}
}

// Detach unregisters a client connection.
func (s *Session) Detach(c Conn) {
	s.connMu.Lock()
	delete(s.conns, c)
	s.connMu.Unlock()
	s.stateMu.Lock()
	s.lastActive = time.Now()
	s.stateMu.Unlock()
}

func (s *Session) hasConns() bool {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	return len(s.conns) > 0
}

// notify fans one JSON-RPC notification out to every attached client. The
// message is encoded once. Notifications are pure UI progress, so a dead
// connection is logged and skipped rather than retried.
func (s *Session) notify(method string, params any) {
	data, err := json.Marshal(jsonrpc.NewNotification(method, params))
	if err != nil {
		log.Printf("bridge %s: marshal %s failed: %v", s.userID, method, err)
		return
	}
	s.connMu.Lock()
	conns := make([]Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.connMu.Unlock()
	for _, c := range conns {
		if err := c.WriteMessage(data); err != nil {
			log.Printf("bridge %s: write %s failed: %v", s.userID, method, err)
		}
	}
}

// sendTo delivers one JSON-RPC notification to a single connection.
func (s *Session) sendTo(c Conn, method string, params any) {
	data, err := json.Marshal(jsonrpc.NewNotification(method, params))
	if err != nil {
		return
	}
	if err := c.WriteMessage(data); err != nil {
		log.Printf("bridge %s: write %s failed: %v", s.userID, method, err)
	}
}

// Close shuts the session down: the worker exits, a running turn is cancelled
// and teammate goroutines are stopped so they cannot outlive an evicted or
// shut-down session.
func (s *Session) Close() {
	s.stopOnce.Do(func() {
		close(s.done)
		s.Cancel()
		// Teammate goroutines hang off this session's team manager; stop them
		// so they cannot outlive an evicted or shut-down session.
		s.teamMgr.CloseAll()
	})
}

// SkillHost implementation, letting the Skill tool narrow this agent's tools.

func (s *Session) ActivateSkill(name, body string) { s.ag.ActivateSkill(name, body) }

func (s *Session) SetToolFilter(allow func(name string) bool) { s.ag.SetToolFilter(allow) }

// refreshSkillSection recomputes the "Available Skills" listing after the
// catalog changed. It reaches the model on the next fresh context (/clear),
// which is when the listing is injected again.
func (s *Session) refreshSkillSection() {
	s.cmdMu.Lock()
	s.skillSection = skills.BuildSkillSection(s.skillCatalog, s.workDir)
	s.cmdMu.Unlock()
	s.ag.SkillSection = s.skillSection
}

// refreshSkillsIfNeeded reloads the catalog when a skill directory changed, so
// skills dropped into the workspace (or installed elsewhere) become slash
// commands without waiting for this session to be evicted. Runs on the worker
// between turns.
func (s *Session) refreshSkillsIfNeeded() {
	s.cmdMu.Lock()
	if s.skillCatalog == nil || !s.skillCatalog.NeedsReload() {
		s.cmdMu.Unlock()
		return
	}
	s.skillCatalog.Reload(s.workDir)
	for _, meta := range s.skillCatalog.List() {
		s.registerSkillCommandLocked(meta.Name)
	}
	s.cmdMu.Unlock()
	s.refreshSkillSection()
	s.notify(MethodSessionCommands, s.commandList())
}

// Helpers

func resolveMode(mode string) permissions.PermissionMode {
	switch permissions.PermissionMode(mode) {
	case permissions.ModeAcceptEdits:
		return permissions.ModeAcceptEdits
	case permissions.ModeBypass:
		return permissions.ModeBypass
	case permissions.ModePlan:
		return permissions.ModePlan
	default:
		return permissions.ModeDefault
	}
}

// installMemExtractor wires background memory extraction. UserMemoryDir is left
// empty on purpose: ~/.yukino/memory is shared by the whole process, so writing
// there would leak one chat user's memories into every other user's agent.
func installMemExtractor(ag *agent.Agent, wd, protocol string, client llm.Client, registry *tools.Registry, conv *conversation.Manager) *extractor.Extractor {
	extr := extractor.InitExtractMemories(extractor.Deps{
		MemoryDir:    memory.GetAutoMemPath(wd),
		ProjectRoot:  wd,
		Client:       client,
		ToolRegistry: registry,
		Protocol:     protocol,
		Conversation: conv,
		AppendSystem: func(s string) { conv.AddSystemReminder(s) },
	})
	ag.OnLoopComplete = func(_ *conversation.Manager) {
		// The extractor performs an LLM round trip; TS fires it without
		// awaiting (app.tsx:1989-2004), and the agent now calls this hook
		// synchronously. Keep the loop non-blocking here.
		go func() {
			_ = extr.Execute(context.Background())
		}()
	}
	return extr
}

func newAgentHookRunner(client llm.Client) func(prompt string, ctx hooks.HookContext) (string, error) {
	return func(p string, _ hooks.HookContext) (string, error) {
		c, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		conv := conversation.NewManager()
		conv.AddUserMessage(p)
		events, errs := client.Stream(c, conv, nil)
		var text strings.Builder
		for ev := range events {
			if td, ok := ev.(llm.TextDelta); ok {
				text.WriteString(td.Text)
			}
		}
		select {
		case err := <-errs:
			if err != nil {
				return "", err
			}
		default:
		}
		return text.String(), nil
	}
}

// compactConversation is the /compact implementation, split out so the command
// switch stays readable.
func (s *Session) compactConversation(customInstructions string) {
	s.notify(MethodAgentSystem, map[string]string{"message": "Compacting conversation…"})
	var recovery *compact.RecoveryState
	var schemas []map[string]any
	var names []string
	if s.ag != nil {
		recovery = s.ag.RecoveryState
		schemas = s.ag.Registry.GetAllSchemas(s.ag.Protocol)
		names = s.ag.Registry.ToolNames()
	}
	result, err := compact.ForceCompact(context.Background(), s.conv, s.client, s.workDir,
		s.sessionID, s.provider.GetContextWindow(), recovery, names, schemas, customInstructions)
	if err != nil {
		s.notify(MethodAgentError, map[string]string{"message": err.Error()})
		return
	}
	s.notify(MethodAgentSystem, map[string]string{"message": "⟳ " + result.Message})
}

func (s *Session) planPath() string { return plan_file.GetOrCreatePlanPath(s.workDir) }
