package remote

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/conversation/userbash"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/images"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/memory/background"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/plan_file"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/sandbox"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
	"github.com/yukino-js/yukino/yukino/internal/workflow"
)

type wsMessage struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type clientMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type userMessageData struct {
	Content string `json:"content"`
}

type permResponseData struct {
	ID       string `json:"id"`
	Response string `json:"response"`
}

type askUserResponseData struct {
	ID      string            `json:"id"`
	Answers map[string]string `json:"answers"`
}

type permissionRequestPayload struct {
	ID               string   `json:"id"`
	ToolName         string   `json:"toolName"`
	Description      string   `json:"description"`
	RememberPatterns []string `json:"rememberPatterns,omitempty"`
	order            uint64
}

type askUserPayload struct {
	ID        string           `json:"id"`
	Questions []map[string]any `json:"questions"`
	order     uint64
}

// followUpEntry is a message that could neither run nor steer immediately and
// is replayed once the streaming slot frees up.
type followUpEntry struct {
	text  string
	input *history.InputEntry
}

// subagentActiveTool mirrors the browser's per-subagent active tool entry.
type subagentActiveTool struct {
	ToolID   string `json:"toolId"`
	ToolName string `json:"toolName"`
}

// subagentState tracks one subagent's live activity for the browser display,
// mirroring RemoteServer.subagentStates entries.
type subagentState struct {
	ToolCallID  string               `json:"toolCallId"`
	Role        string               `json:"role"`
	Background  bool                 `json:"background"`
	TurnCount   int                  `json:"turnCount"`
	Status      string               `json:"status"`
	ActiveTools []subagentActiveTool `json:"activeTools"`
}

// goalControlPattern matches the /goal control commands accepted mid-run.
var goalControlPattern = regexp.MustCompile(`^/goal(?:\s+(status|pause|clear|complete))?$`)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Server struct {
	accessToken          string
	initMu               sync.Mutex
	snapshotMu           sync.RWMutex
	writeMu              sync.Mutex
	stopOnce             sync.Once
	stopped              chan struct{}
	runMu                sync.Mutex
	planMu               sync.Mutex
	planApprovalID       string
	planApprovalTimer    *time.Timer
	pendingPlanExecution string
	// hasExitedPlanMode tracks whether plan mode was exited, so re-entering
	// replays the reentry reminder (mirrors RemoteServer.hasExitedPlanMode).
	hasExitedPlanMode bool
	MCPLoading        string
	providers         []config.ProviderConfig
	mcpConfigs        []config.MCPServerConfig
	hookCfgs          []config.HookConfig
	addr              string

	defaultProvider int

	mu    sync.Mutex
	conns map[*websocket.Conn]struct{}

	// lastPongAt tracks the most recent pong per connection and drives the
	// heartbeat sweep; heartbeatTicker/heartbeatDone run the sweep loop.
	lastPongAt      map[*websocket.Conn]int64
	heartbeatTicker *time.Ticker
	heartbeatDone   chan struct{}

	// fileCache backs @-mention completion, mirroring RemoteServer.fileCache.
	fileCacheMu   sync.Mutex
	fileCacheKey  string
	fileCache     []string
	fileCacheTime time.Time

	ag           *agent.Agent
	conv         *conversation.Manager
	registry     *tools.Registry
	defaultTools tools.DefaultTools
	client       llm.Client
	provider     *config.ProviderConfig
	sessionID    string
	fileHistory  *file_history.History
	goalManager  *goal.GoalManager

	streaming         bool
	stopping          bool
	runCanceled       bool
	currentAgent      *agent.Agent
	steeringLeftovers []agent.SteeringMessage
	turnCount         int
	exitPlanSucceeded bool
	cancelStream      context.CancelFunc
	agentCh           <-chan agent.AgentEvent

	// modelListCancel aborts an in-flight model discovery when a new one starts.
	modelListMu         sync.Mutex
	modelListCancel     context.CancelFunc
	modelListGeneration uint64

	// followUps queues messages that arrive while a run cannot accept them.
	followUpsMu sync.Mutex
	followUps   []followUpEntry

	// activity bridge: live task/teammate/subagent feeds for the browser.
	activityAttached  bool
	activityCleanups  []func()
	teammateSignature string
	teammateTimer     *time.Ticker
	teammateDone      chan struct{}
	wakeupTimer       *time.Ticker
	wakeupDone        chan struct{}
	subagentMu        sync.Mutex
	subagentStates    map[string]*subagentState
	subagentOrder     []string

	// lastUsage mirrors the reference RemoteServer.lastUsage: the most recent
	// usage event, surfaced by /status and the command context.
	lastUsageInput  int
	lastUsageOutput int

	askUserCh chan tools.AskUserRequest

	pendingPermMu       sync.Mutex
	pendingPerms        map[string]chan<- agent.PermissionReply
	pendingPermPayloads map[string]permissionRequestPayload
	pendingPermTimers   map[string]*time.Timer
	pendingPermDone     map[string]chan struct{}

	pendingAskMu       sync.Mutex
	pendingAsks        map[string]chan<- tools.QuestionResponse
	pendingAskPayloads map[string]askUserPayload
	pendingAskTimers   map[string]*time.Timer
	pendingAskDone     map[string]chan struct{}
	requestCounter     atomic.Uint64

	cmdRegistry  *commands.Registry
	skillCatalog *skills.Catalog
	taskMgr      *subagent.TaskManager
	todoList     *todo.TaskList
	memoryMgr    *memory.Manager
	memoryTasks  *background.Tasks
	// memoryMu guards memoryTasks and the lazy-creation read of s.client:
	// OnLoopComplete fires on its own goroutine while stopMemoryTasks runs
	// from the WS command flows.
	memoryMu sync.Mutex
	// disposed mirrors the reference AgentHandleImpl.disposed: Stop sets it so
	// a late OnLoopComplete cannot recreate memory tasks after teardown.
	disposed atomic.Bool
	teamMgr  *teams.TeamManager
	mcpMgr   *mcp.Manager

	instructionsContent   string
	memoryContent         string
	mcpAnnounced          map[string]bool
	mcpApps               *remoteMcpApps
	enableCoordinatorMode bool
	// memoryEnabled mirrors config.yaml `enable_memory:`; gates injection,
	// extraction, and consolidation. Defaults to true.
	memoryEnabled  bool
	sandboxCfg     *config.SandboxYamlConfig
	sandboxRuntime sandbox.Runtime

	httpServer *http.Server
}

func NewServer(providers []config.ProviderConfig, mcpConfigs []config.MCPServerConfig, hookCfgs []config.HookConfig, addr string, enableCoordinatorMode bool, defaultProvider int, sandboxCfg *config.SandboxYamlConfig, memoryEnabled bool) *Server {
	return &Server{
		accessToken:           createAccessToken(),
		stopped:               make(chan struct{}),
		providers:             providers,
		mcpConfigs:            mcpConfigs,
		hookCfgs:              hookCfgs,
		addr:                  addr,
		defaultProvider:       defaultProvider,
		enableCoordinatorMode: enableCoordinatorMode,
		memoryEnabled:         memoryEnabled,
		sandboxCfg:            sandboxCfg,
		conns:                 make(map[*websocket.Conn]struct{}),
		lastPongAt:            make(map[*websocket.Conn]int64),
		pendingPerms:          make(map[string]chan<- agent.PermissionReply),
		pendingPermPayloads:   make(map[string]permissionRequestPayload),
		pendingPermTimers:     make(map[string]*time.Timer),
		pendingPermDone:       make(map[string]chan struct{}),
		pendingAsks:           make(map[string]chan<- tools.QuestionResponse),
		pendingAskPayloads:    make(map[string]askUserPayload),
		pendingAskTimers:      make(map[string]*time.Timer),
		pendingAskDone:        make(map[string]chan struct{}),
		mcpAnnounced:          map[string]bool{},
		mcpApps:               newRemoteMcpApps(),
	}
}

func (s *Server) activeProvider() *config.ProviderConfig {
	if s.provider != nil {
		return s.provider
	}
	if len(s.providers) == 0 {
		return nil
	}
	return config.ResolveDefaultProvider(s.providers, s.defaultProvider)
}

func (s *Server) Run() error {
	address, err := s.listenAddress()
	if err != nil {
		return err
	}
	if _, err := s.initializeAgent(); err != nil {
		log.Printf("agent init deferred -- will retry on first message: %v", err)
	}
	defer s.Stop()
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", s.handleHealth)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	server := &http.Server{Addr: listener.Addr().String(), Handler: mux}
	s.runMu.Lock()
	if s.stopping {
		s.runMu.Unlock()
		_ = listener.Close()
		return nil
	}
	s.httpServer = server
	s.startHeartbeat()
	s.runMu.Unlock()
	fmt.Fprintf(os.Stderr, "Remote server listening at http://%s/#token=%s\n", listener.Addr(), s.accessToken)
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-s.stopped
	return nil
}

func (s *Server) initializeAgent() (bool, error) {
	s.initMu.Lock()
	defer s.initMu.Unlock()
	if s.disposed.Load() {
		return false, errors.New("Agent runtime is disposed")
	}
	if s.ag != nil {
		return false, nil
	}
	s.snapshotMu.Lock()
	defer s.snapshotMu.Unlock()
	if err := s.initAgent(); err != nil {
		return false, err
	}
	s.initMCPServers()
	s.attachActivityBridge()
	return true, nil
}

func (s *Server) ensureAgent() bool {
	created, err := s.initializeAgent()
	if err != nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": "Failed to initialize agent: " + err.Error()}})
		return false
	}
	if !created {
		return true
	}
	s.send(wsMessage{Type: "connected", Data: map[string]any{"session": s.sessionID, "cwd": mustGetwd(), "streaming": s.isStreaming()}})
	s.broadcastStatus()
	s.send(wsMessage{Type: "commands", Data: s.buildCommandList()})
	s.send(wsMessage{Type: "usage", Data: s.usagePayload()})
	return true
}

func (s *Server) isStreaming() bool {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	return s.streaming
}

func (s *Server) mcpAppHandle() mcpAppHandle {
	s.snapshotMu.RLock()
	defer s.snapshotMu.RUnlock()
	handle := mcpAppHandle{SessionID: s.sessionID, Cwd: mustGetwd(), MCPManager: s.mcpMgr}
	if s.ag != nil {
		handle.Checker = s.ag.Checker
		handle.Hooks = s.ag.Hooks
		handle.ToolFilter = s.ag.ToolNameFilter
	}
	return handle
}

func (s *Server) handleMcpAppRequest(parent context.Context, ws *websocket.Conn, request mcp.McpAppRequest) {
	ctx, cancel := context.WithTimeout(parent, PendingRequestTimeoutMS*time.Millisecond)
	defer cancel()
	handle := s.mcpAppHandle()
	if s.mcpApps == nil || handle.Checker == nil {
		s.sendTo(ws, wsMessage{Type: "mcp_app_response", Data: map[string]any{"requestId": request.RequestID, "error": MCPAppAgentDisconnected}})
		return
	}
	result, err := s.mcpApps.Request(ctx, request, handle, s.requestPermissionViaWS)
	if err != nil {
		s.sendTo(ws, wsMessage{Type: "mcp_app_response", Data: map[string]any{"requestId": request.RequestID, "error": err.Error()}})
		return
	}
	s.sendTo(ws, wsMessage{Type: "mcp_app_response", Data: map[string]any{"requestId": request.RequestID, "result": result}})
}

func (s *Server) sendTo(ws *websocket.Conn, msg wsMessage) {
	s.sendBatchTo(ws, []wsMessage{msg})
}

func (s *Server) sendBatchTo(ws *websocket.Conn, messages []wsMessage) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for _, message := range messages {
		data, err := json.Marshal(message)
		if err == nil {
			_ = ws.WriteMessage(websocket.TextMessage, data)
		}
	}
}

// Stop tears the server down: closes the HTTP/WS listener and disposes the
// tool registry (MCP children, background tasks). Run returns nil once the
// server has stopped.
func (s *Server) Stop() {
	s.stopOnce.Do(s.stop)
}

func (s *Server) stop() {
	s.disposed.Store(true)
	s.runMu.Lock()
	s.stopping = true
	s.pendingPlanExecution = ""
	s.runMu.Unlock()
	s.followUpsMu.Lock()
	s.followUps = nil
	s.followUpsMu.Unlock()
	s.initMu.Lock()
	defer s.initMu.Unlock()
	s.cancelActiveRun()
	s.modelListMu.Lock()
	if s.modelListCancel != nil {
		s.modelListCancel()
		s.modelListCancel = nil
	}
	s.modelListMu.Unlock()
	s.stopHeartbeat()
	s.stopActivityBridge()
	s.mu.Lock()
	for conn := range s.conns {
		_ = conn.Close()
		delete(s.conns, conn)
		delete(s.lastPongAt, conn)
	}
	s.mu.Unlock()
	if s.httpServer != nil {
		_ = s.httpServer.Close()
	}
	s.stopMemoryTasks()
	if s.taskMgr != nil {
		_ = s.taskMgr.StopAll(context.Background())
	}
	if s.teamMgr != nil {
		s.teamMgr.CloseAll()
	}
	if s.mcpApps != nil {
		s.mcpApps.Clear()
	}
	if s.mcpMgr != nil {
		s.mcpMgr.DisconnectAll()
	}
	if s.registry != nil {
		_ = s.registry.Dispose()
	}
	s.disposeSandbox()
	close(s.stopped)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if status, message := authorizeWebSocket(r, "/ws", s.accessToken); status != 0 {
		http.Error(w, message, status)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	s.mu.Lock()
	s.conns[conn] = struct{}{}
	s.lastPongAt[conn] = time.Now().UnixMilli()
	s.mu.Unlock()
	connectionCtx, disconnect := context.WithCancel(r.Context())
	defer disconnect()

	defer func() {
		conn.Close()
		s.mu.Lock()
		delete(s.conns, conn)
		delete(s.lastPongAt, conn)
		s.mu.Unlock()
	}()

	conn.SetReadLimit(100 << 20)
	conn.SetPongHandler(func(string) error {
		s.mu.Lock()
		s.lastPongAt[conn] = time.Now().UnixMilli()
		s.mu.Unlock()
		return nil
	})

	// Per-connection bootstrap: every message below is unicasted to the newly
	// connected client (mirrors the reference wss.on("connection") handler),
	// not broadcast, so a late joiner syncs without disturbing other clients.
	s.snapshotMu.RLock()
	s.sendBatchTo(conn, s.bootstrapMessages())
	s.snapshotMu.RUnlock()
	s.planMu.Lock()
	planID := s.planApprovalID
	s.planMu.Unlock()
	if planID != "" {
		s.sendTo(conn, s.planApprovalMessage(planID))
	}
	s.replayPendingRequests(conn)

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("WebSocket read error: %v", err)
			}
			return
		}

		msg, valid := parseClientMessage(raw)
		if !valid {
			continue
		}

		switch msg.Type {
		case "user_message":
			var data userMessageData
			json.Unmarshal(msg.Data, &data)
			s.submitUserMessage(data.Content)

		case "permission_response":
			var data permResponseData
			json.Unmarshal(msg.Data, &data)
			s.handlePermissionResponse(data)

		case "mcp_app_request":
			var data struct {
				RequestID string         `json:"requestId"`
				AppID     string         `json:"appId"`
				Method    string         `json:"method"`
				Params    map[string]any `json:"params"`
			}
			if json.Unmarshal(msg.Data, &data) == nil {
				request := mcp.McpAppRequest{RequestID: data.RequestID, AppID: data.AppID, Method: data.Method, Params: data.Params}
				if mcp.ValidMcpAppRequest(request) {
					go s.handleRequest(conn, func() { s.handleMcpAppRequest(connectionCtx, conn, request) })
				}
			}

		case "ask_user_response":
			var data askUserResponseData
			json.Unmarshal(msg.Data, &data)
			s.handleAskUserResponse(data)

		case "plan_approval_response":
			var data struct {
				ID       string `json:"id"`
				Choice   string `json:"choice"`
				Feedback string `json:"feedback"`
			}
			if json.Unmarshal(msg.Data, &data) == nil {
				go s.handleRequest(conn, func() { s.handlePlanApprovalResponse(data.ID, data.Choice, data.Feedback) })
			}
		case "set_permission_mode":
			var data struct {
				Mode string `json:"mode"`
			}
			if json.Unmarshal(msg.Data, &data) == nil {
				switch mode := permissions.PermissionMode(data.Mode); mode {
				case permissions.ModeDefault, permissions.ModeAcceptEdits, permissions.ModeBypass, permissions.ModePlan:
					s.applyPermissionMode(mode)
				}
			}

		case "file_complete_request":
			var data struct {
				RequestID string `json:"requestId"`
				Query     string `json:"query"`
			}
			if json.Unmarshal(msg.Data, &data) == nil {
				s.sendFileCompletions(conn, data.RequestID, data.Query)
			}

		case "image_upload":
			var data imageUploadData
			if json.Unmarshal(msg.Data, &data) == nil {
				go s.handleRequest(conn, func() { s.handleImageUpload(conn, data) })
			}

		case "background_shells":
			s.backgroundForegroundShells()

		case "rewind_list_request":
			s.broadcastRewindList()

		case "rewind_action":
			var data struct {
				SnapshotID string `json:"snapshotId"`
				Action     string `json:"action"`
			}
			if json.Unmarshal(msg.Data, &data) == nil {
				switch data.Action {
				case "code_and_conversation", "conversation_only", "code_only":
					s.handleRewindAction(data.SnapshotID, data.Action)
				}
			}

		case "model_list_request":
			go s.handleRequest(conn, s.broadcastModelList)

		case "model_select":
			var data struct {
				Model string `json:"model"`
			}
			if json.Unmarshal(msg.Data, &data) == nil {
				s.submitProviderConfiguration(conn, func() { s.applyModel(data.Model) })
			}

		case "provider_select":
			var data struct {
				Index int `json:"index"`
			}
			if json.Unmarshal(msg.Data, &data) == nil {
				s.submitProviderConfiguration(conn, func() { s.applyProviderSwitch(data.Index) })
			}

		case "provider_save":
			var data map[string]any
			if json.Unmarshal(msg.Data, &data) == nil {
				for key := range data {
					if key != "name" && key != "protocol" && key != "base_url" && key != "api_key" && key != "model" && key != "thinking" {
						delete(data, key)
					}
				}
				s.submitProviderConfiguration(conn, func() { s.handleProviderSave(data) })
			}

		case "provider_list_request":
			s.broadcastProviderList()

		case "cancel":
			s.cancelActiveRun()

		case "ping":
			s.sendTo(conn, wsMessage{Type: "pong", Data: nil})
		}
	}
}

func (s *Server) initAgent() error {
	if err := hooks.Validate(s.hookCfgs); err != nil {
		return err
	}
	if len(s.providers) == 0 {
		return errors.New("No providers configured")
	}
	configured := config.ResolveDefaultProvider(s.providers, s.defaultProvider)
	provider := *configured
	p := &provider
	wd, _ := os.Getwd()
	if err := history.RegisterProject(wd); err != nil {
		return err
	}

	s.askUserCh = make(chan tools.AskUserRequest, 1)
	s.cmdRegistry = commands.CreateDefaultRegistry()
	s.cmdRegistry.Register(&commands.Command{Name: "provider", Type: commands.TypeLocalUI, Description: "Switch the active provider", Handler: func(*commands.Context) string { return "provider" }})
	for _, command := range commands.LoadUserCommands() {
		if s.cmdRegistry.Find(command.Name) == nil {
			s.cmdRegistry.Register(command)
		}
	}
	s.skillCatalog = skills.LoadCatalog(wd)
	s.instructionsContent = loadCustomInstructions(wd)
	s.memoryContent = ""

	skillSection := skills.BuildSkillSection(s.skillCatalog)

	env := prompt.DetectEnvironment(wd)
	env.Model = p.Model
	systemPrompt := prompt.BuildSystemPrompt(env)

	client, err := llm.NewClient(p, systemPrompt)
	if err != nil {
		return err
	}
	s.client = client
	s.conv = conversation.NewManager()
	s.sessionID = session.NewID()
	s.fileHistory = file_history.New(s.sessionID)

	s.registerTools(client, p, wd)
	s.conv.InjectLongTermMemory(s.instructionsContent, s.memoryContent, "")
	if service := workflow.GetWorkflowService(s.registry); service != nil {
		_ = service.RegisterNamedCommands(s.cmdRegistry)
	}

	ag := agent.New(client, s.registry, p.Protocol)
	ag.ContextWindow = config.GetContextWindow(p)
	ag.MaxOutputTokens = config.GetMaxOutputTokens(p)
	ag.InstructionsFn = func() string { return memory.LoadInstructions(wd) }
	ag.MemoryContentFn = func() string {
		if s.memoryEnabled && s.memoryMgr != nil {
			return s.memoryMgr.BuildSystemReminder()
		}
		return ""
	}
	ag.SkillSection = skillSection
	ag.SkillDeltaFn = func() string {
		section := skills.BuildSkillSection(s.skillCatalog)
		if section != "" && !s.conv.HasReminderContaining(section) {
			return section
		}
		return ""
	}
	ag.FileHistory = s.fileHistory
	ag.FileStateCache = s.defaultTools.EditFile.FileStateCache
	ag.TaskManager = s.taskMgr
	ag.SetSessionID(s.sessionID)
	ag.GoalManager = s.goal()

	ag.Checker = permissions.NewChecker(
		permissions.NewPathSandbox(wd, true),
		permissions.NewRuleEngine(wd),
		permissions.ModeDefault,
	)
	if bash, ok := s.registry.Get("Bash").(*tools.BashTool); ok {
		ag.Checker.SandboxEnabled = bash.SandboxRequired
	}
	ag.Checker.SandboxAutoAllow = s.sandboxCfg.SandboxAutoAllow()

	if len(s.hookCfgs) > 0 {
		eng := hooks.NewEngine(s.hookCfgs)
		eng.AgentRunner = newAgentHookRunner(client)
		ag.Hooks = eng
	}

	ag.NotificationFn = func() ([]string, error) {
		messages := teams.DrainLeadMailbox(s.teamMgr)
		if s.taskMgr != nil {
			drained, err := s.taskMgr.DrainNotifications()
			if err != nil {
				return nil, err
			}
			for _, task := range drained {
				messages = append(messages, subagent.FormatAgentTaskNotification(task))
			}
		}
		return messages, nil
	}

	ag.ToolNameFilter = teams.CoordinatorToolFilter(s.enableCoordinatorMode)
	ag.CoordinatorActiveFn = teams.CoordinatorActiveFn(s.enableCoordinatorMode)

	s.ag = ag
	s.provider = p
	s.teamMgr.SetPermissionChecker(ag.Checker)
	if bash, ok := s.registry.Get("Bash").(*tools.BashTool); ok {
		ag.Checker.SandboxEnabled = bash.SandboxRequired
	}
	ag.Checker.SandboxAutoAllow = s.sandboxCfg.SandboxAutoAllow()

	if at, ok := s.registry.Get("Agent").(*subagent.AgentTool); ok {
		at.ParentChecker = ag.Checker
		at.OnProgress = s.handleSubagentProgress
	}

	s.wireSkillCommands()
	if s.memoryEnabled {
		s.installMemoryTasks(ag, wd)
	}

	return nil
}

func (s *Server) registerTools(client llm.Client, p *config.ProviderConfig, wd string) {
	s.taskMgr = subagent.NewTaskManager()
	if err := s.taskMgr.UseSession(s.sessionID); err != nil {
		panic(err)
	}
	store, err := todo.NewStore(s.sessionID)
	if err != nil {
		panic(err)
	}
	s.todoList, err = todo.NewTaskList(store)
	if err != nil {
		panic(err)
	}
	// enable_memory: false keeps the index out of the conversation and nothing
	// is injected, extracted, or consolidated automatically.
	if s.memoryEnabled {
		s.memoryMgr = memory.NewManager(wd, nil)
		s.memoryContent = s.memoryMgr.BuildSystemReminder()
	}
	loader := subagent.NewAgentLoader()
	loader.LoadAll()
	s.teamMgr = teams.NewTeamManager(wd)
	s.teamMgr.CoordinatorMode = s.enableCoordinatorMode
	// Restore pending notifications and reclaim interrupted teammates' work.
	s.teamMgr.RestoreFromDisk()

	s.defaultTools = bootstrap.CreateToolRegistry(s.todoList, bootstrap.ToolRegistryOptions{
		InteractionMode: "interactive",
		TeamMgr:         s.teamMgr,
		WorkDir:         wd,
		GoalManager:     func() *goal.GoalManager { return s.goal() },
	})
	s.registry = s.defaultTools.Registry
	s.registry.Register(&skills.LoadSkillTool{Catalog: s.skillCatalog, Host: s, ForkHost: s})
	s.registry.Register(&tools.AskUserQuestionTool{RequestCh: s.askUserCh})
	bootstrap.ConfigureBashSandbox(s.registry, wd, s.sandboxCfg, nil)
	s.defaultTools.EditFile.FileHistory = s.fileHistory
	s.defaultTools.WriteFile.FileHistory = s.fileHistory
	tools.AttachBackgroundTaskManager(s.registry, s.taskMgr)
	manager := s.taskMgr
	s.registry.AddCleanup(func() error { return manager.StopAll(context.Background()) })
	s.registry.Register(&teams.TeamCreateTool{TeamMgr: s.teamMgr})
	s.registry.Register(&teams.TeamDeleteTool{TeamMgr: s.teamMgr})
	s.registry.Register(&teams.TeamListTool{TeamMgr: s.teamMgr})
	s.registry.Register(&teams.SendMessageTool{TeamMgr: s.teamMgr, SenderName: "leader"})
	s.registry.Register(&teams.TaskStopTool{TeamMgr: s.teamMgr, TaskManager: s.taskMgr})
	s.registry.Register(&tools.SyntheticOutputTool{})
	s.registry.Register(&subagent.AgentTool{
		Client:        client,
		Provider:      p,
		MemoryContent: s.memoryContent,
		Registry:      s.registry,
		Protocol:      p.Protocol,
		TaskMgr:       s.taskMgr,
		Loader:        loader,
		Conversation:  s.conv,
		TeamMgr:       s.teamMgr,
	})
	workflow.AttachWorkflow(workflow.WorkflowServiceOptions{
		WorkflowBackendOptions: workflow.WorkflowBackendOptions{
			Registry:    s.registry,
			GetClient:   func() llm.Client { return s.client },
			GetProvider: func() *config.ProviderConfig { return s.activeProvider() },
		},
		Cwd:         wd,
		TaskManager: s.taskMgr,
	})
}

func (s *Server) initMCPServers() {
	if len(s.mcpConfigs) == 0 {
		return
	}
	mgr := mcp.NewManager(true)
	result := mgr.ConnectAll(context.Background(), s.mcpConfigs)
	s.mcpMgr = mgr
	for _, connected := range result.Tools {
		s.registry.Register(connected.Tool)
	}
	for _, connectError := range result.Errors {
		log.Printf("MCP error: %s: %s", connectError.ServerName, connectError.Error)
	}
	if len(s.providers) > 0 && len(result.Tools) > 0 {
		p := s.activeProvider()
		mcp.DecideAndApply(s.registry, p.BaseURL, p.Protocol, config.GetContextWindow(p), s.MCPLoading)
	}
}

func (s *Server) handleUserMessage(content string, submittedInput *history.InputEntry) {
	content = strings.TrimSpace(content)
	if content == "" {
		return
	}
	ctx, ok := s.beginRun()
	if !ok {
		return
	}
	s.handleClaimedUserMessage(ctx, content, submittedInput)
}

func (s *Server) submitUserMessage(content string) {
	content = strings.TrimSpace(content)
	if content == "" {
		return
	}
	ctx, ok := s.beginRun()
	if ok {
		go s.handleClaimedUserMessage(ctx, content, nil)
		return
	}
	s.runMu.Lock()
	stopping := s.stopping
	s.runMu.Unlock()
	if !stopping {
		s.handleSteeringMessage(content, nil)
	}
}

func (s *Server) handleClaimedUserMessage(ctx context.Context, content string, submittedInput *history.InputEntry) {
	defer s.finishRun()
	defer func() {
		if failure := recover(); failure != nil {
			s.send(wsMessage{Type: "error", Data: map[string]string{"message": fmt.Sprint(failure)}})
		}
	}()
	s.clearSubagents()
	wd, _ := os.Getwd()
	name, _, isCommand := commands.Parse(content)
	if isCommand && (name == "login" || name == "provider") {
		if submittedInput == nil {
			var sessionID *string
			s.snapshotMu.RLock()
			if s.ag != nil {
				id := s.sessionID
				sessionID = &id
			}
			s.snapshotMu.RUnlock()
			commandName := "login"
			if _, err := history.RecordInput(history.InputOptions{Cwd: wd, SessionID: sessionID, Source: "ws", Text: content, CommandName: &commandName}); err != nil {
				s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
				return
			}
		}
		s.send(wsMessage{Type: "replay_user", Data: map[string]string{"content": content}})
		s.broadcastProviderList()
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	}
	if !s.ensureAgent() || ctx.Err() != nil {
		if submittedInput == nil {
			_, _ = history.RecordInput(history.InputOptions{Cwd: wd, Source: "ws", Text: content})
		}
		return
	}
	var input history.InputEntry
	if submittedInput != nil {
		input = *submittedInput
	} else {
		var commandName *string
		if resolved := commands.Resolve(content, s.cmdRegistry); resolved != nil && resolved.Command != nil {
			commandName = &resolved.Command.Name
		}
		var err error
		input, err = history.RecordInput(history.InputOptions{Cwd: wd, SessionID: &s.sessionID, Source: "ws", Text: content, CommandName: commandName})
		if err != nil {
			panic(err)
		}
	}
	if command, excluded, bash := userbash.ParseCommand(content); bash {
		s.runUserBash(ctx, wd, command, excluded, input)
		return
	}
	s.send(wsMessage{Type: "replay_user", Data: map[string]string{"content": content}})
	if isCommand {
		s.runSlashCommand(ctx, content, input)
		return
	}
	expanded, blocks := conversation.ExpandAtRefsWithImages(content, wd)
	record := session.Message{Content: expanded}
	if blocks != nil {
		record = session.Message{ContentBlocks: blocks}
	}
	saved, err := session.SaveUserMessage(wd, s.sessionID, input, record)
	if err != nil {
		panic(err)
	}
	s.conv.AppendMessages([]conversation.Message{saved.ToConversation()})
	s.runAgent(ctx)
}

func (s *Server) runAgent(ctx context.Context) {
	if s.mcpMgr != nil {
		mcp.SyncMcpInstructions(s.conv, s.mcpAnnounced, s.mcpMgr)
	}
	handle := s.ag
	running := agent.New(s.client, s.registry, handle.Protocol)
	running.Checker = handle.Checker
	running.WorkDir = handle.WorkDir
	running.SetSessionID(s.sessionID)
	running.ContextWindow = handle.ContextWindow
	running.MaxOutputTokens = handle.MaxOutputTokens
	running.GoalManager = s.goal()
	running.Hooks = handle.Hooks
	running.FileHistory = s.fileHistory
	running.FileStateCache = handle.FileStateCache
	running.TaskManager = s.taskMgr
	running.RecoveryState = handle.RecoveryState
	running.Instructions, running.InstructionsFn = handle.Instructions, handle.InstructionsFn
	running.MemoryContent, running.MemoryContentFn = handle.MemoryContent, handle.MemoryContentFn
	running.SkillSection, running.SkillDeltaFn = handle.SkillSection, handle.SkillDeltaFn
	running.ToolNameFilter = handle.ToolNameFilter
	running.CoordinatorActiveFn = handle.CoordinatorActiveFn
	running.NotificationFn = handle.NotificationFn
	running.OnLoopComplete = handle.OnLoopComplete
	running.ShareActiveSkills(handle)
	s.runMu.Lock()
	s.currentAgent = running
	s.runMu.Unlock()
	defer func() {
		s.runMu.Lock()
		s.steeringLeftovers = append(s.steeringLeftovers, running.DrainSteering()...)
		s.currentAgent = nil
		s.runMu.Unlock()
	}()
	s.agentCh = running.Run(ctx, s.conv)
	askDone := make(chan struct{})
	defer close(askDone)
	go s.listenForAskUser(askDone)
	s.consumeAgentEvents()
}

func (s *Server) buildCommandList() []map[string]string {
	s.snapshotMu.RLock()
	defer s.snapshotMu.RUnlock()
	return s.commandList()
}

func (s *Server) commandList() []map[string]string {
	registry := s.cmdRegistry
	if registry == nil {
		registry = commands.CreateDefaultRegistry()
	}
	list := make([]map[string]string, 0)
	for _, cmd := range registry.ListCommands() {
		list = append(list, map[string]string{
			"name":        cmd.Name,
			"description": cmd.Description,
		})
	}
	return list
}

func (s *Server) runSlashCommand(runCtx context.Context, input string, entry history.InputEntry) {
	defer func() {
		if failure := recover(); failure != nil {
			s.send(wsMessage{Type: "error", Data: map[string]string{"message": fmt.Sprintf("Command panic: %v", failure)}})
		}
	}()
	parsed := commands.Resolve(input, s.cmdRegistry)
	if parsed == nil {
		return
	}
	name, args, cmd := parsed.Name, parsed.Args, parsed.Command
	wd, _ := os.Getwd()
	if cmd == nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{
			"message": fmt.Sprintf("Unknown command: /%s -- type /help to see available commands", name),
		}})
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	}

	ctx := s.buildCommandContext(args)

	// The remote intercepts these commands by name and renders the real
	// status itself; the registry handlers are placeholders.
	switch name {
	case "workflows":
		service := workflow.GetWorkflowService(s.registry)
		message := "Workflow service is not initialized"
		if service != nil {
			result, err := service.Command(args, s.workflowHostContext(wd))
			if err != nil {
				s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
				s.send(wsMessage{Type: "command_done", Data: nil})
				return
			}
			message = result
		}
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": message}})
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	case "status":
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": s.buildSessionStatus()}})
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	case "memory":
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": s.buildMemoryStatus(args)}})
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	case "mcp":
		if strings.EqualFold(strings.TrimSpace(args), "reload") {
			s.reloadMcpServers(runCtx)
		} else {
			s.send(wsMessage{Type: "system", Data: map[string]string{"message": s.buildMcpStatus()}})
		}
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	case "thinking":
		// Terminal parity: bare /thinking opens the level picker; with an
		// argument it sets the level. Either way the status snapshot follows.
		if strings.TrimSpace(args) == "" {
			current := config.DefaultThinkingLevel
			if ctx.ThinkingLevel != nil {
				current = ctx.ThinkingLevel()
			}
			levels := config.ThinkingLevels
			if ctx.AvailableThinkingLevels != nil {
				levels = ctx.AvailableThinkingLevels()
			}
			s.send(wsMessage{Type: "thinking_form", Data: map[string]any{"current": current, "levels": levels}})
		} else if cmd.Handler != nil {
			s.send(wsMessage{Type: "system", Data: map[string]string{"message": cmd.Handler(ctx)}})
		}
		s.broadcastStatus()
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	case "goal":
		result := goal.HandleGoalCommand(s.goal(), args)
		s.send(wsMessage{Type: "stream_text", Data: map[string]string{"text": result.Message + "\n"}})
		s.send(wsMessage{Type: "stream_end", Data: map[string]string{"text": result.Message + "\n"}})
		if result.Prompt == "" {
			s.send(wsMessage{Type: "loop_complete", Data: map[string]any{"stopReason": "end_turn", "totalTurns": s.turnCount, "elapsed": 0}})
			return
		}
		s.turnCount++
		s.send(wsMessage{Type: "turn_complete", Data: map[string]int{"turn": s.turnCount}})
		recorded, err := session.SaveUserMessage(wd, s.sessionID, entry, session.Message{Content: input})
		if err != nil {
			s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
			return
		}
		message := recorded.ToConversation()
		message.Content = result.Prompt
		s.conv.AppendMessages([]conversation.Message{message})
		s.ag.GoalManager = s.goal()
		s.runAgent(runCtx)
		return
	}

	switch cmd.Type {
	case commands.TypeLocal:
		if cmd.Handler != nil {
			result := cmd.Handler(ctx)
			data := map[string]any{"message": result}
			if cmd.Markdown {
				data["markdown"] = true
			}
			s.send(wsMessage{Type: "system", Data: data})
		}
		s.send(wsMessage{Type: "command_done", Data: nil})

	case commands.TypeLocalUI:
		switch name {
		case "clear":
			// Stop background tasks and teammates before rotating the session so
			// nothing keeps running (or billing/notifying) into the new session.
			// A stop failure is surfaced and aborts the clear (never masked).
			var stopErr error
			if s.taskMgr != nil {
				stopErr = s.taskMgr.StopAll(context.Background())
			}
			if s.teamMgr != nil {
				s.teamMgr.StopAll()
			}
			if stopErr != nil {
				s.send(wsMessage{Type: "error", Data: map[string]string{
					"message": "Clear could not stop all background work: " + stopErr.Error(),
				}})
				s.send(wsMessage{Type: "command_done", Data: nil})
				return
			}
			if err := s.clearConversation(); err != nil {
				s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
				s.send(wsMessage{Type: "command_done", Data: nil})
				return
			}
			s.clearSubagents()
			s.send(wsMessage{Type: "connected", Data: map[string]any{
				"session":   s.sessionID,
				"cwd":       mustGetwd(),
				"streaming": s.isStreaming(),
			}})
			s.send(wsMessage{Type: "clear", Data: nil})

		case "compact":
			s.handleCompact(runCtx, args)
			return

		case "resume":
			s.handleResume(args)
			return

		case "rewind":
			s.broadcastRewindList()

		case "login", "provider":
			// Browser parity: open the provider dialog (switch or add).
			s.broadcastProviderList()

		case "model":
			if model := strings.TrimSpace(args); model != "" {
				s.applyModel(model)
			} else {
				s.broadcastModelList()
			}

		case "skills":
			if s.skillCatalog == nil {
				s.send(wsMessage{Type: "system", Data: map[string]string{"message": "No skills loaded."}})
			} else if list := s.skillCatalog.List(); len(list) == 0 {
				s.send(wsMessage{Type: "system", Data: map[string]string{"message": "No skills found."}})
			} else {
				lines := make([]string, 0, len(list))
				for _, skill := range list {
					lines = append(lines, "  "+skill.Name+": "+skill.Description)
				}
				s.send(wsMessage{Type: "system", Data: map[string]string{
					"message": fmt.Sprintf("Available skills (%d):\n\n%s", len(list), strings.Join(lines, "\n")),
				}})
			}

		case "worktree":
			wd := mustGetwd()
			if s.ag != nil {
				wd = s.ag.CurrentCwd()
			}
			cmd := exec.Command("git", "worktree", "list")
			cmd.Dir = wd
			if output, err := cmd.Output(); err == nil {
				s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Worktree list:\n" + string(output)}})
			} else {
				s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Not a git repository or git worktree not available."}})
			}

		case "sandbox":
			s.handleSandboxCommand(args)

		case "quit":
			s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Shutting down the remote server…"}})
			time.AfterFunc(time.Duration(ShutdownGraceMS)*time.Millisecond, func() { s.Stop() })
		}
		s.send(wsMessage{Type: "command_done", Data: nil})

	case commands.TypePrompt:
		if cmd.Handler == nil {
			return
		}
		prompt := cmd.Handler(ctx)
		displayText := "/" + name
		if args != "" {
			displayText += " " + args
		}
		wd, _ := os.Getwd()
		if cmd.Agent == "" {
			recorded, err := session.SaveUserMessage(wd, s.sessionID, entry, session.Message{Content: displayText})
			if err != nil {
				s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
				return
			}
			message := recorded.ToConversation()
			message.Content = prompt
			s.conv.AppendMessages([]conversation.Message{message})
		}

		if s.mcpMgr != nil {
			mcp.SyncMcpInstructions(s.conv, s.mcpAnnounced, s.mcpMgr)
		}

		if cmd.Agent != "" {
			defer s.send(wsMessage{Type: "command_done", Data: nil})
			s.agentCh = commands.RunSubagentCommand(runCtx, cmd.Agent, prompt, displayText, s.registry, s.ag.Checker, s.conv, wd, s.sessionID, &entry)
			askDone := make(chan struct{})
			defer close(askDone)
			go s.listenForAskUser(askDone)
			s.consumeAgentEvents()
		} else {
			s.runAgent(runCtx)
		}
	case commands.TypeSkillFork:
		s.runSkillFork(runCtx, name, args)
	}
}

func (s *Server) buildCommandContext(args string) *commands.Context {
	wd, _ := os.Getwd()
	modelName := ""
	if p := s.activeProvider(); p != nil {
		modelName = p.Model
	}
	return &commands.Context{
		Args:       args,
		Cwd:        wd,
		Model:      modelName,
		TokenCount: func() (int, int) { return s.lastUsageInput, s.lastUsageOutput },
		PermissionMode: func() string {
			if s.ag != nil && s.ag.Checker != nil {
				return string(s.ag.Checker.Mode())
			}
			return "default"
		},
		ToolCount: func() int { return len(s.registry.ListTools()) },
		MemoryList: func() []string {
			if s.memoryMgr == nil || !s.memoryEnabled {
				return nil
			}
			memories := s.memoryMgr.GetMemories()
			names := make([]string, 0, len(memories))
			for _, memory := range memories {
				names = append(names, memory.Name)
			}
			return names
		},
		ThinkingLevel: func() string {
			if tlc, ok := s.client.(llm.ThinkingLevelControl); ok {
				if level := tlc.GetThinkingLevel(); level != "" {
					return level
				}
			}
			if p := s.activeProvider(); p != nil && p.Thinking != "" {
				return p.Thinking
			}
			return config.DefaultThinkingLevel
		},
		AvailableThinkingLevels: func() []string {
			if tlc, ok := s.client.(llm.ThinkingLevelControl); ok {
				if levels := tlc.GetSupportedThinkingLevels(); levels != nil {
					return levels
				}
			}
			if p := s.activeProvider(); p != nil {
				return config.GetSupportedThinkingLevels(p)
			}
			return config.ThinkingLevels
		},
		SetThinkingLevel: func(level string) {
			tlc, ok := s.client.(llm.ThinkingLevelControl)
			if !ok {
				return
			}
			tlc.SetThinkingLevel(level)
			if p := s.activeProvider(); p != nil {
				if effective := tlc.GetThinkingLevel(); effective != "" {
					p.Thinking = effective
				} else {
					p.Thinking = level
				}
			}
		},
		PersistThinkingLevel: func(level string) error {
			if p := s.activeProvider(); p != nil {
				return config.PersistThinkingLevel(p.BaseURL, level)
			}
			return nil
		},
	}
}

func (s *Server) handleCompact(ctx context.Context, customInstructions string) {
	if s.client == nil || s.conv == nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": "Compact requires an active provider."}})
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	}
	s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Compacting conversation..."}})
	wd, _ := os.Getwd()
	var recovery *compact.RecoveryState
	var schemas []map[string]any
	if s.ag != nil {
		recovery = s.ag.RecoveryState
		schemas = s.ag.Registry.FilteredSchemas(s.ag.Protocol, s.ag.ToolNameFilter)
	}
	names := make([]string, 0, len(schemas))
	for _, schema := range schemas {
		if name := tools.SchemaName(schema); name != "" {
			names = append(names, name)
		}
	}
	sessionFilePath := session.SessionFilePath(wd, s.sessionID)
	result, err := compact.ForceCompact(ctx, s.conv, s.client, recovery, names, schemas, sessionFilePath, customInstructions)
	if err != nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
	} else {
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Compacted: " + result.Message}})
		if result.Boundary != nil {
			if err := session.SaveCompactBoundary(wd, s.sessionID, result.Boundary.Summary, result.Boundary.Keep); err != nil {
				s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
			}
		}
	}
	s.send(wsMessage{Type: "command_done", Data: nil})
}

func (s *Server) handleResume(args string) {
	wd, _ := os.Getwd()
	sessions := session.ListSessions(wd)

	if args == "" {
		if len(sessions) == 0 {
			s.send(wsMessage{Type: "system", Data: map[string]string{"message": "No previous sessions found."}})
			s.send(wsMessage{Type: "command_done", Data: nil})
			return
		}
		list := sessions
		if len(list) > SessionListLimit {
			list = list[:SessionListLimit]
		}
		out := make([]map[string]any, 0, len(list))
		for _, sess := range list {
			var lastUser any
			if sess.LastUserMessageTime != nil {
				lastUser = sess.LastUserMessageTime.UTC().Format("2006-01-02T15:04:05.000Z")
			}
			out = append(out, map[string]any{
				"id":                  sess.ID,
				"firstMessage":        sess.FirstMessage,
				"messageCount":        sess.MessageCount,
				"lastUserMessageTime": lastUser,
			})
		}
		s.send(wsMessage{Type: "session_list", Data: map[string]any{"sessions": out}})
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	}

	targetID := strings.TrimSpace(args)
	if regexp.MustCompile("^[0-9]+$").MatchString(targetID) {
		if idx, err := strconv.Atoi(targetID); err == nil && idx >= 1 && idx <= len(sessions) {
			targetID = sessions[idx-1].ID
		}
	}
	var msgs []session.Message
	var err error
	for _, candidate := range sessions {
		if candidate.ID == targetID {
			msgs, err = session.LoadSessionForResume(wd, targetID)
			break
		}
	}
	if err != nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{
			"message": err.Error(),
		}})
		return
	}
	if len(msgs) == 0 {
		s.send(wsMessage{Type: "error", Data: map[string]string{
			"message": fmt.Sprintf("Session '%s' not found or empty.", targetID),
		}})
		s.send(wsMessage{Type: "command_done", Data: nil})
		return
	}

	if s.taskMgr != nil {
		if err := s.taskMgr.StopAll(context.Background()); err != nil {
			s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
			return
		}
	}
	s.stopMemoryTasks()
	replay := session.RebuildFromSession(msgs, false)
	if err := s.restoreSession(targetID, replay); err != nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
		return
	}

	s.send(wsMessage{Type: "connected", Data: map[string]any{
		"session":   targetID,
		"cwd":       wd,
		"streaming": false,
	}})
	s.send(wsMessage{Type: "clear", Data: nil})
	for _, msg := range replay {
		text := msg.ContentText()
		if text == "" {
			continue
		}
		kind := "replay_assistant"
		if msg.Role == "user" {
			kind = "replay_user"
		}
		s.send(wsMessage{Type: kind, Data: map[string]string{"content": text}})
	}

	restored := fmt.Sprintf("Session %s restored (%d messages).", targetID, len(replay))
	s.send(wsMessage{Type: "system", Data: map[string]string{"message": restored}})
	s.send(wsMessage{Type: "command_done", Data: nil})
}

func (s *Server) rotateSessionState(sessionID string) error {
	if s.taskMgr != nil {
		if err := s.taskMgr.UseSession(sessionID); err != nil {
			return err
		}
	}
	s.conv.Reset()
	s.sessionID = sessionID
	if s.ag != nil {
		s.ag.SetSessionID(sessionID)
		s.ag.Checker.SetPlanFilePath("")
		s.ag.GoalManager = s.goal()
		s.ag.FileStateCache = tools.NewFileStateCache()
		s.defaultTools.EditFile.FileStateCache = s.ag.FileStateCache
		s.defaultTools.WriteFile.FileStateCache = s.ag.FileStateCache
		s.ag.RecoveryState = compact.NewRecoveryState()
		s.ag.ClearActiveSkills()
		s.ag.SetToolFilter(teams.CoordinatorToolFilter(s.enableCoordinatorMode))
	}
	s.fileHistory = file_history.New(sessionID)
	if s.ag != nil {
		s.ag.FileHistory = s.fileHistory
	}
	s.defaultTools.EditFile.FileHistory = s.fileHistory
	s.defaultTools.WriteFile.FileHistory = s.fileHistory
	if s.todoList != nil {
		store, err := todo.NewStore(sessionID)
		if err != nil {
			return err
		}
		if err := s.todoList.UseStore(store); err != nil {
			return err
		}
	}
	return nil
}

// restoreSession mirrors restoreRemoteSession in src/remote/session-state.ts: it
// rebinds per-session state to a resumed session so it starts clean instead of
// inheriting the previous session's caches, skills, and tool restrictions.
func (s *Server) restoreSession(targetID string, replay []conversation.Message) error {
	s.snapshotMu.Lock()
	if err := s.rotateSessionState(targetID); err != nil {
		s.snapshotMu.Unlock()
		return err
	}
	s.conv.AppendMessages(replay)
	s.snapshotMu.Unlock()
	s.clearSubagents()
	return nil
}

// clearConversation mirrors AgentHandleImpl.clearConversation: it rotates to a
// fresh session id and resets every piece of session-scoped state in place, so
// /resume and the JSONL no longer see the pre-clear history.
func (s *Server) clearConversation() error {
	s.stopMemoryTasks()
	s.snapshotMu.Lock()
	defer s.snapshotMu.Unlock()
	if err := s.rotateSessionState(session.NewID()); err != nil {
		return err
	}
	s.mcpAnnounced = map[string]bool{}
	return nil
}

var agentEventLogger = AgentEventLogger{}

func (s *Server) consumeAgentEvents() {
	streamBuf := ""
	startTime := time.Now()

	for ev := range s.agentCh {
		agentEventLogger.OnEvent(ev)
		switch e := ev.(type) {
		case agent.StreamText:
			streamBuf += e.Text
			s.send(wsMessage{Type: "stream_text", Data: map[string]string{"text": e.Text}})

		case agent.ThinkingText:
			s.send(wsMessage{Type: "thinking_text", Data: map[string]string{"text": e.Text}})

		case agent.ToolUseEvent:
			s.send(wsMessage{Type: "tool_use", Data: map[string]any{
				"toolId":   e.ToolID,
				"toolName": e.ToolName,
				"args":     e.Args,
			}})

		case agent.ToolResultEvent:
			if streamBuf != "" {
				s.send(wsMessage{Type: "stream_end", Data: map[string]string{"text": streamBuf}})
				streamBuf = ""
			}
			data := map[string]any{
				"toolId":   e.ToolID,
				"toolName": e.ToolName,
				"output":   e.Output,
				"isError":  e.IsError,
				"elapsed":  e.Elapsed.Seconds(),
			}
			if e.McpApp != nil {
				data["mcpApp"] = e.McpApp
				s.mcpApps.Register(mcp.McpAppToolResult{
					ToolID:   e.ToolID,
					ToolName: e.ToolName,
					Output:   e.Output,
					IsError:  e.IsError,
					Elapsed:  e.Elapsed.Seconds(),
					McpApp: &mcp.McpApp{
						ServerName:  e.McpApp.ServerName,
						ToolName:    e.McpApp.ToolName,
						ResourceURI: e.McpApp.ResourceURI,
						Arguments:   e.McpApp.Arguments,
						Result:      e.McpApp.Result,
					},
				}, s.mcpAppHandle())
			}
			s.send(wsMessage{Type: "tool_result", Data: data})
			if !e.IsError && (e.ToolName == "ExitPlanMode" || e.ToolName == "EnterPlanMode") {
				s.exitPlanSucceeded = true
			}
			if !e.IsError && e.ToolName == "EnterPlanMode" {
				s.broadcastStatus()
			}

		case agent.PermissionRequestEvent:
			description := formatMcpPermissionDesc(e.Args, e.Decision)
			if e.AgentName != "" && e.Cwd != "" {
				description = e.AgentName + " · " + e.Cwd + "\n" + description
			}
			s.requestPermission(e.Context, permissionRequestPayload{
				ToolName:         e.ToolName,
				Description:      description,
				RememberPatterns: e.Decision.RememberPatterns,
			}, e.ResponseCh)

		case agent.AskUserQuestionEvent:
			respCh := make(chan tools.QuestionResponse, 1)
			s.requestAskUser(context.Background(), e.Questions, respCh)
			go func() {
				resp := <-respCh
				e.ResponseCh <- resp.Answers
			}()

		case agent.SteeringDelivered:
			s.send(wsMessage{Type: "steering_delivered", Data: map[string]string{"text": e.Text}})

		case agent.TurnComplete:
			if streamBuf != "" {
				s.send(wsMessage{Type: "stream_end", Data: map[string]string{"text": streamBuf}})
				streamBuf = ""
			}
			s.turnCount++
			s.send(wsMessage{Type: "turn_complete", Data: map[string]int{"turn": s.turnCount}})

		case agent.LoopComplete:
			if streamBuf != "" {
				s.send(wsMessage{Type: "stream_end", Data: map[string]string{"text": streamBuf}})
				streamBuf = ""
			}
			elapsed := time.Since(startTime).Seconds()
			s.send(wsMessage{Type: "loop_complete", Data: map[string]any{
				"totalTurns": s.turnCount,
				"elapsed":    elapsed,
				"stopReason": e.StopReason,
			}})
			if e.PlanReady || (s.ag != nil && s.ag.Checker.Mode() == permissions.ModePlan && s.exitPlanSucceeded) {
				if e.PlanReady {
					s.broadcastStatus()
				}
				s.requestPlanApproval()
			}

		case agent.UsageEvent:
			s.snapshotMu.Lock()
			s.lastUsageInput = e.InputTokens
			s.lastUsageOutput = e.OutputTokens
			s.snapshotMu.Unlock()
			s.send(wsMessage{Type: "usage", Data: s.usagePayload()})

		case agent.ErrorEvent:
			s.send(wsMessage{Type: "error", Data: map[string]string{"message": e.Message}})

		case agent.CompactEvent:
			s.send(wsMessage{Type: "compact", Data: map[string]string{"message": e.Message}})

		case agent.RetryEvent:
			s.send(wsMessage{Type: "retry", Data: map[string]any{
				"reason": e.Reason,
				"waitMs": e.Wait.Milliseconds(),
			}})
		}
	}
}

func (s *Server) listenForAskUser(done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case req, ok := <-s.askUserCh:
			if !ok {
				return
			}
			go s.answerAskUser(req)
		}
	}
}

func (s *Server) answerAskUser(req tools.AskUserRequest) {
	respCh := make(chan tools.QuestionResponse, 1)
	questions := make([]map[string]any, 0, len(req.Questions))
	for _, question := range req.Questions {
		encoded, err := json.Marshal(question)
		if err != nil {
			continue
		}
		var value map[string]any
		if json.Unmarshal(encoded, &value) == nil {
			questions = append(questions, value)
		}
	}
	s.requestAskUser(req.Context, questions, respCh)
	resp := <-respCh
	req.ResponseCh <- resp
}

func (s *Server) handlePermissionResponse(data permResponseData) {
	s.pendingPermMu.Lock()
	ch, ok := s.pendingPerms[data.ID]
	if ok {
		delete(s.pendingPerms, data.ID)
		close(s.pendingPermDone[data.ID])
		delete(s.pendingPermDone, data.ID)
	}
	payload := s.pendingPermPayloads[data.ID]
	if timer := s.pendingPermTimers[data.ID]; timer != nil {
		timer.Stop()
	}
	delete(s.pendingPermPayloads, data.ID)
	delete(s.pendingPermTimers, data.ID)
	s.pendingPermMu.Unlock()

	if !ok {
		return
	}

	var resp agent.PermissionResponse
	switch data.Response {
	case "allow":
		resp = agent.PermAllow
	case "deny":
		resp = agent.PermDeny
	case "allowAlways":
		if len(payload.RememberPatterns) == 0 {
			resp = agent.PermAllow
		} else {
			resp = agent.PermAllowAlways
		}
	default:
		resp = agent.PermDeny
	}
	ch <- agent.PermissionReply{Response: resp}
	response := data.Response
	if resp == agent.PermAllow && data.Response == "allowAlways" {
		response = "allow"
	}
	s.send(wsMessage{Type: "request_expired", Data: map[string]any{"id": data.ID, "kind": "permission", "response": response}})
}

func (s *Server) handleAskUserResponse(data askUserResponseData) {
	s.pendingAskMu.Lock()
	ch, ok := s.pendingAsks[data.ID]
	if ok {
		delete(s.pendingAsks, data.ID)
		close(s.pendingAskDone[data.ID])
		delete(s.pendingAskDone, data.ID)
	}
	if timer := s.pendingAskTimers[data.ID]; timer != nil {
		timer.Stop()
	}
	delete(s.pendingAskPayloads, data.ID)
	delete(s.pendingAskTimers, data.ID)
	s.pendingAskMu.Unlock()

	if !ok {
		return
	}

	ch <- tools.QuestionResponse{Answers: data.Answers}
	s.send(wsMessage{Type: "request_expired", Data: map[string]string{"id": data.ID, "kind": "ask"}})
}

func (s *Server) nextRequestID(prefix string) string {
	return fmt.Sprintf("%s_%s_%d", prefix, strconv.FormatInt(time.Now().UnixMilli(), 36), s.requestCounter.Add(1))
}

func (s *Server) requestPermission(ctx context.Context, payload permissionRequestPayload, ch chan<- agent.PermissionReply) {
	payload.ID = s.nextRequestID("perm")
	payload.order = s.requestCounter.Load()
	s.pendingPermMu.Lock()
	s.pendingPerms[payload.ID] = ch
	done := make(chan struct{})
	s.pendingPermDone[payload.ID] = done
	s.pendingPermPayloads[payload.ID] = payload
	s.pendingPermTimers[payload.ID] = time.AfterFunc(PendingRequestTimeoutMS*time.Millisecond, func() {
		s.expirePermission(payload.ID, true)
	})
	s.pendingPermMu.Unlock()
	s.send(wsMessage{Type: "permission_request", Data: payload})
	s.watchRequestContext(ctx, done, func() { s.expirePermission(payload.ID, false) })
}

func (s *Server) requestAskUser(ctx context.Context, questions []map[string]any, ch chan<- tools.QuestionResponse) {
	s.runMu.Lock()
	stopping := s.stopping
	s.runMu.Unlock()
	if stopping || (ctx != nil && ctx.Err() != nil) {
		ch <- tools.QuestionResponse{Answers: map[string]string{}}
		return
	}
	payload := askUserPayload{ID: s.nextRequestID("ask"), Questions: questions, order: s.requestCounter.Load()}
	s.pendingAskMu.Lock()
	s.pendingAsks[payload.ID] = ch
	done := make(chan struct{})
	s.pendingAskDone[payload.ID] = done
	s.pendingAskPayloads[payload.ID] = payload
	s.pendingAskTimers[payload.ID] = time.AfterFunc(PendingRequestTimeoutMS*time.Millisecond, func() {
		s.expireAsk(payload.ID, true)
	})
	s.pendingAskMu.Unlock()
	s.send(wsMessage{Type: "ask_user", Data: payload})
	s.watchRequestContext(ctx, done, func() { s.expireAsk(payload.ID, false) })
}

func (s *Server) watchRequestContext(ctx context.Context, done <-chan struct{}, cancel func()) {
	if ctx == nil || ctx.Done() == nil {
		return
	}
	go func() {
		select {
		case <-ctx.Done():
			cancel()
		case <-done:
		}
	}()
}

func (s *Server) expirePermission(id string, timedOut bool) {
	s.pendingPermMu.Lock()
	ch, ok := s.pendingPerms[id]
	if ok {
		delete(s.pendingPerms, id)
		close(s.pendingPermDone[id])
		delete(s.pendingPermDone, id)
		delete(s.pendingPermPayloads, id)
	}
	if timer := s.pendingPermTimers[id]; timer != nil {
		timer.Stop()
		delete(s.pendingPermTimers, id)
	}
	s.pendingPermMu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- agent.PermissionReply{Response: agent.PermDeny}:
	default:
	}
	if timedOut {
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": fmt.Sprintf("Permission request timed out after %d minutes with no response; denying automatically.", PendingRequestTimeoutMinutes)}})
	}
	s.send(wsMessage{Type: "request_expired", Data: map[string]string{"id": id, "kind": "permission"}})
}

func (s *Server) expireAsk(id string, timedOut bool) {
	s.pendingAskMu.Lock()
	ch, ok := s.pendingAsks[id]
	if ok {
		delete(s.pendingAsks, id)
		close(s.pendingAskDone[id])
		delete(s.pendingAskDone, id)
		delete(s.pendingAskPayloads, id)
	}
	if timer := s.pendingAskTimers[id]; timer != nil {
		timer.Stop()
		delete(s.pendingAskTimers, id)
	}
	s.pendingAskMu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- tools.QuestionResponse{Answers: map[string]string{}}:
	default:
	}
	if timedOut {
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": fmt.Sprintf("Question timed out after %d minutes with no answer; continuing with empty answers.", PendingRequestTimeoutMinutes)}})
	}
	s.send(wsMessage{Type: "request_expired", Data: map[string]string{"id": id, "kind": "ask"}})
}

func (s *Server) replayPendingRequests(conn *websocket.Conn) {
	s.pendingPermMu.Lock()
	permissions := make([]permissionRequestPayload, 0, len(s.pendingPermPayloads))
	for _, payload := range s.pendingPermPayloads {
		permissions = append(permissions, payload)
	}
	s.pendingPermMu.Unlock()
	sort.Slice(permissions, func(i, j int) bool { return permissions[i].order < permissions[j].order })
	for _, payload := range permissions {
		s.sendTo(conn, wsMessage{Type: "permission_request", Data: payload})
	}

	s.pendingAskMu.Lock()
	asks := make([]askUserPayload, 0, len(s.pendingAskPayloads))
	for _, payload := range s.pendingAskPayloads {
		asks = append(asks, payload)
	}
	s.pendingAskMu.Unlock()
	sort.Slice(asks, func(i, j int) bool { return asks[i].order < asks[j].order })
	for _, payload := range asks {
		s.sendTo(conn, wsMessage{Type: "ask_user", Data: payload})
	}
}

func (s *Server) cancelActiveRun() {
	s.runMu.Lock()
	s.runCanceled = true
	cancel := s.cancelStream
	s.runMu.Unlock()
	s.closePlanApproval()
	if cancel != nil {
		cancel()
	}
	go func() {
		s.snapshotMu.RLock()
		tasks, teams := s.taskMgr, s.teamMgr
		s.snapshotMu.RUnlock()
		if tasks != nil {
			_ = tasks.StopAll(context.Background())
		}
		if teams != nil {
			teams.StopAll()
		}
	}()
	s.pendingPermMu.Lock()
	permissionIDs := make([]string, 0, len(s.pendingPerms))
	for id := range s.pendingPerms {
		permissionIDs = append(permissionIDs, id)
	}
	s.pendingPermMu.Unlock()
	for _, id := range permissionIDs {
		s.expirePermission(id, false)
	}
	s.pendingAskMu.Lock()
	askIDs := make([]string, 0, len(s.pendingAsks))
	for id := range s.pendingAsks {
		askIDs = append(askIDs, id)
	}
	s.pendingAskMu.Unlock()
	for _, id := range askIDs {
		s.expireAsk(id, false)
	}
}

// broadcastRewindList mirrors RemoteServer.broadcastRewindList: it sends the
// checkpoint list, or a notice when there is nothing to rewind to.
func (s *Server) broadcastRewindList() {
	s.snapshotMu.RLock()
	defer s.snapshotMu.RUnlock()
	if s.ag == nil || s.fileHistory == nil {
		return
	}
	if !s.fileHistory.HasSnapshots() {
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": "No checkpoints to rewind to."}})
		return
	}
	snapshots := s.fileHistory.GetSnapshots()
	out := make([]map[string]any, 0, len(snapshots))
	for i, snap := range snapshots {
		out = append(out, map[string]any{
			"index":     i,
			"id":        snap.ID,
			"userText":  snap.UserText,
			"timestamp": snap.Timestamp,
			"fileCount": len(snap.Backups),
		})
	}
	s.send(wsMessage{Type: "rewind_list", Data: map[string]any{"snapshots": out}})
}

// handleRewindAction mirrors RemoteServer.handleRewindAction: it restores code
// and/or conversation to the checkpoint identified by snapshot UUID.
func (s *Server) handleRewindAction(snapshotID, action string) {
	if s.ag == nil || s.fileHistory == nil {
		return
	}
	s.runMu.Lock()
	streaming := s.streaming
	s.runMu.Unlock()
	if streaming {
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Cannot rewind while a run is in progress."}})
		return
	}
	snapshots := s.fileHistory.GetSnapshots()
	snapshotIndex := -1
	for i, candidate := range snapshots {
		if candidate.ID == snapshotID {
			snapshotIndex = i
			break
		}
	}
	if snapshotIndex < 0 {
		s.send(wsMessage{Type: "error", Data: map[string]string{
			"message": "That checkpoint is no longer available (the list changed or the session was reset). Reopen /rewind.",
		}})
		return
	}
	snap := snapshots[snapshotIndex]
	// Mirrors the reference's fire-and-forget `void handle.stopMemoryTasks()`:
	// the rewind proceeds while the in-flight extraction drains.
	if action != "code_only" {
		go s.stopMemoryTasks()
	}
	fileList := func(changed []string) string {
		if len(changed) == 0 {
			return ""
		}
		lines := make([]string, 0, len(changed))
		for _, file := range changed {
			lines = append(lines, "  "+file)
		}
		return "\n" + strings.Join(lines, "\n")
	}
	rewindFiles := func() ([]string, bool) {
		changed, err := s.fileHistory.Rewind(snapshotIndex)
		if err != nil {
			s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
			return nil, false
		}
		return changed, true
	}
	switch action {
	case "code_and_conversation":
		changed, ok := rewindFiles()
		if !ok {
			return
		}
		s.rewindConversation(snap)
		s.send(wsMessage{Type: "system", Data: map[string]string{
			"message": fmt.Sprintf("⟲ Rewound to checkpoint. Restored %d file(s) and conversation.%s", len(changed), fileList(changed)),
		}})
	case "conversation_only":
		s.rewindConversation(snap)
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": "⟲ Rewound conversation. Files unchanged."}})
	case "code_only":
		changed, ok := rewindFiles()
		if !ok {
			return
		}
		s.send(wsMessage{Type: "system", Data: map[string]string{
			"message": fmt.Sprintf("⟲ Restored %d file(s). Conversation unchanged.%s", len(changed), fileList(changed)),
		}})
	}
}

// rewindConversation mirrors RemoteServer.rewindConversation: it truncates the
// live conversation to a snapshot and replays the visible transcript. The
// snapshot's sessionLineCount is authoritative; messageIndex is the fallback.
func (s *Server) rewindConversation(snap file_history.Snapshot) {
	s.send(wsMessage{Type: "clear", Data: nil})
	replayMessage := func(role, content string) {
		if content == "" || strings.HasPrefix(content, conversation.SystemReminderOpen) {
			return
		}
		msgType := "replay_assistant"
		if role == "user" {
			msgType = "replay_user"
		}
		s.send(wsMessage{Type: msgType, Data: map[string]string{"content": content}})
	}
	wd := mustGetwd()
	if s.ag != nil {
		wd = s.ag.CurrentCwd()
	}
	if snap.SessionLineCount != nil {
		sessionFilePath := session.SessionFilePath(wd, s.sessionID)
		if sessionFilePath != "" {
			if _, err := os.Stat(sessionFilePath); err == nil {
				if terr := session.TruncateSessionLines(sessionFilePath, *snap.SessionLineCount); terr != nil {
					s.send(wsMessage{Type: "error", Data: map[string]string{"message": terr.Error()}})
					return
				}
				saved, lerr := session.LoadSession(wd, s.sessionID)
				if lerr != nil {
					s.send(wsMessage{Type: "error", Data: map[string]string{"message": lerr.Error()}})
					return
				}
				rebuilt := session.RebuildFromSession(saved, false)
				s.conv.Reset()
				s.conv.AppendMessages(rebuilt)
				s.goalManager = nil
				if s.ag != nil {
					s.ag.GoalManager = s.goal()
				}
				for _, msg := range rebuilt {
					replayMessage(msg.Role, remoteMessageText(msg))
				}
				return
			}
		}
	}
	s.conv.TruncateTo(snap.MessageIndex)
	for _, msg := range s.conv.GetMessages() {
		if msg.Role == "system" {
			continue
		}
		replayMessage(msg.Role, remoteMessageText(msg))
	}
}

// attachActivityBridge mirrors RemoteServer.attachActivityBridge: it wires the
// live activity feeds (background tasks, teammate states) the browser activity
// display consumes. Subagent progress is fed through the Agent tool's
// OnProgress callback.
func (s *Server) attachActivityBridge() {
	if s.activityAttached {
		return
	}
	s.activityAttached = true
	if s.taskMgr != nil {
		unsubscribe := s.taskMgr.Subscribe(func(tasks []tools.BackgroundTask) {
			list := make([]map[string]any, 0, len(tasks))
			for _, task := range tasks {
				kind := task.Kind
				if kind == "" {
					kind = "agent"
				}
				list = append(list, map[string]any{
					"id":     task.ID,
					"name":   task.Name,
					"kind":   kind,
					"status": task.Status,
				})
			}
			s.send(wsMessage{Type: "background_tasks", Data: map[string]any{"list": list}})
		})
		s.activityCleanups = append(s.activityCleanups, unsubscribe)
	}
	if s.teamMgr != nil && s.todoList != nil {
		unsubscribe := teams.SubscribeLeaderTasks(s.teamMgr, s.todoList, func(tasks []*todo.Task, boardID string) {
			list := make([]map[string]string, 0, len(tasks))
			for _, task := range tasks {
				list = append(list, map[string]string{
					"id":      task.ID,
					"subject": task.Subject,
					"status":  string(task.Status),
				})
			}
			s.send(wsMessage{Type: "todo_update", Data: map[string]any{"boardId": boardID, "tasks": list}})
		})
		s.activityCleanups = append(s.activityCleanups, unsubscribe)
	}
	s.teammateTimer = time.NewTicker(time.Duration(TeammatePollIntervalMS) * time.Millisecond)
	done := make(chan struct{})
	s.teammateDone = done
	ticker := s.teammateTimer
	go func() {
		for {
			select {
			case <-ticker.C:
				s.broadcastTeammates()
			case <-done:
				return
			}
		}
	}()
	s.wakeupTimer = time.NewTicker(time.Duration(WakeupPollIntervalMS) * time.Millisecond)
	wakeupDone := make(chan struct{})
	s.wakeupDone = wakeupDone
	wakeupTicker := s.wakeupTimer
	go func() {
		for {
			select {
			case <-wakeupTicker.C:
				s.runMu.Lock()
				blocked := s.streaming || s.stopping || s.ag == nil
				s.runMu.Unlock()
				s.followUpsMu.Lock()
				hasFollowUps := len(s.followUps) > 0
				s.followUpsMu.Unlock()
				if blocked || hasFollowUps {
					continue
				}
				if teams.HasLeaderNotifications(s.teamMgr) || (s.taskMgr != nil && s.taskMgr.HasNotifications()) {
					go s.runNotificationTurn()
				}
			case <-wakeupDone:
				return
			}
		}
	}()
}

// stopActivityBridge tears down the activity-bridge subscriptions and timers.
func (s *Server) stopActivityBridge() {
	for _, cleanup := range s.activityCleanups {
		cleanup()
	}
	s.activityCleanups = nil
	if s.teammateTimer != nil {
		s.teammateTimer.Stop()
		s.teammateTimer = nil
	}
	if s.teammateDone != nil {
		close(s.teammateDone)
		s.teammateDone = nil
	}
	if s.wakeupTimer != nil {
		s.wakeupTimer.Stop()
		s.wakeupTimer = nil
	}
	if s.wakeupDone != nil {
		close(s.wakeupDone)
		s.wakeupDone = nil
	}
	s.activityAttached = false
}

// broadcastTeammates mirrors the reference teammate poll: it diffs the teammate
// states by signature and broadcasts only on change.
func (s *Server) broadcastTeammates() {
	if s.teamMgr == nil {
		return
	}
	states := s.teamMgr.GetAllTeammateStates()
	signatureBytes, _ := json.Marshal(states)
	signature := string(signatureBytes)
	if signature == s.teammateSignature {
		return
	}
	s.teammateSignature = signature
	list := make([]map[string]any, 0, len(states))
	for _, state := range states {
		var lastMessage any
		if state.LastMessage != "" {
			lastMessage = state.LastMessage
		}
		activeTools := make([]map[string]string, 0, len(state.Progress.ActiveTools))
		for _, tool := range state.Progress.ActiveTools {
			activeTools = append(activeTools, map[string]string{"toolId": tool.ToolID, "toolName": tool.ToolName})
		}
		list = append(list, map[string]any{
			"name":         state.Name,
			"teamName":     state.TeamName,
			"status":       state.Status,
			"spinnerVerb":  state.SpinnerVerb,
			"lastMessage":  lastMessage,
			"turnCount":    state.Progress.TurnCount,
			"toolUseCount": state.Progress.ToolUseCount,
			"tokenCount":   state.Progress.TokenCount,
			"activeTools":  activeTools,
		})
	}
	s.send(wsMessage{Type: "teammates", Data: map[string]any{"list": list}})
}

// handleSubagentProgress mirrors RemoteServer.handleSubagentEvent: it folds a
// subagent lifecycle report into the tracked state and rebroadcasts.
func (s *Server) handleSubagentProgress(p subagent.SubAgentProgress) {
	s.subagentMu.Lock()
	if s.subagentStates == nil {
		s.subagentStates = map[string]*subagentState{}
	}
	existing := s.subagentStates[p.ToolCallID]
	if existing == nil && p.Event == nil {
		s.subagentOrder = append(s.subagentOrder, p.ToolCallID)
	}
	switch {
	case p.Event == nil && p.Status == "running":
		s.subagentStates[p.ToolCallID] = &subagentState{
			ToolCallID:  p.ToolCallID,
			Role:        p.Role,
			Background:  p.Background,
			Status:      "running",
			ActiveTools: []subagentActiveTool{},
		}
	case p.Event != nil:
		if existing != nil {
			switch ev := p.Event.(type) {
			case agent.ToolUseEvent:
				filtered := make([]subagentActiveTool, 0, len(existing.ActiveTools))
				for _, tool := range existing.ActiveTools {
					if tool.ToolID != ev.ToolID {
						filtered = append(filtered, tool)
					}
				}
				existing.ActiveTools = append(filtered, subagentActiveTool{ToolID: ev.ToolID, ToolName: ev.ToolName})
			case agent.ToolResultEvent:
				filtered := make([]subagentActiveTool, 0, len(existing.ActiveTools))
				for _, tool := range existing.ActiveTools {
					if tool.ToolID != ev.ToolID {
						filtered = append(filtered, tool)
					}
				}
				existing.ActiveTools = filtered
			case agent.TurnComplete:
				existing.TurnCount++
				existing.ActiveTools = []subagentActiveTool{}
			}
		}
	case p.Status == "completed" || p.Status == "failed" || p.Status == "stopped":
		if existing != nil {
			existing.Status = p.Status
			existing.ActiveTools = []subagentActiveTool{}
		} else {
			s.subagentStates[p.ToolCallID] = &subagentState{
				ToolCallID:  p.ToolCallID,
				Role:        p.Role,
				Background:  p.Background,
				Status:      p.Status,
				ActiveTools: []subagentActiveTool{},
			}
		}
	}
	s.subagentMu.Unlock()
	s.broadcastSubagents()
}

// clearSubagents resets the tracked subagent state and rebroadcasts, mirroring
// the reference subagentStates.clear() at run start, /clear, and /resume.
func (s *Server) clearSubagents() {
	s.subagentMu.Lock()
	s.subagentStates = map[string]*subagentState{}
	s.subagentOrder = nil
	s.subagentMu.Unlock()
	s.broadcastSubagents()
}

// broadcastSubagents mirrors RemoteServer.broadcastSubagents.
func (s *Server) broadcastSubagents() {
	s.subagentMu.Lock()
	ids := s.subagentOrder
	list := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		entry := s.subagentStates[id]
		activeTools := make([]map[string]string, 0, len(entry.ActiveTools))
		for _, tool := range entry.ActiveTools {
			activeTools = append(activeTools, map[string]string{"toolId": tool.ToolID, "toolName": tool.ToolName})
		}
		list = append(list, map[string]any{
			"toolCallId":  entry.ToolCallID,
			"role":        entry.Role,
			"background":  entry.Background,
			"turnCount":   entry.TurnCount,
			"status":      entry.Status,
			"activeTools": activeTools,
		})
	}
	s.subagentMu.Unlock()
	s.send(wsMessage{Type: "subagents", Data: map[string]any{"list": list}})
}

// runUserBash mirrors RemoteServer.runUserBash: it runs a "!command" through
// the Bash tool, streaming output to the browser and recording the result in
// the session transcript.
func (s *Server) runUserBash(ctx context.Context, wd, command string, excluded bool, input history.InputEntry) {
	if command == "" {
		prefix := "!"
		if excluded {
			prefix = "!!"
		}
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Warning: Enter a Bash command after " + prefix + "."}})
		return
	}
	bashTool, _ := s.registry.Get("Bash").(*tools.BashTool)
	if bashTool == nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": "Bash tool is unavailable"}})
		return
	}
	toolID := s.nextRequestID("user-bash")
	started := time.Now()
	s.send(wsMessage{Type: "tool_use", Data: map[string]any{"toolId": toolID, "toolName": "Bash", "args": map[string]any{"command": command}}})

	execution := tools.ExecutionContext{WorkDir: wd, SessionID: s.sessionID, TaskManager: s.taskMgr}
	if s.ag != nil {
		execution.Worktrees = s.ag.Checker
	}
	execution.OnOutput = func(output string) {
		s.send(wsMessage{Type: "tool_output", Data: map[string]any{"toolId": toolID, "output": utils.PlainTerminalText(output)}})
	}
	result := userbash.Execute(tools.WithExecutionContext(ctx, execution), bashTool, command, excluded)

	elapsed := time.Since(started).Seconds()
	status := "completed"
	if result.IsError {
		status = "failed"
	}
	if ctx.Err() != nil {
		status = "stopped"
	}
	s.send(wsMessage{Type: "tool_result", Data: map[string]any{
		"toolId":   toolID,
		"toolName": "Bash",
		"output":   result.Output,
		"isError":  result.IsError,
		"elapsed":  elapsed,
	}})
	recorded := conversation.UserBashResult{
		Command:            command,
		Output:             result.Output,
		IsError:            result.IsError,
		Elapsed:            elapsed,
		Status:             status,
		ExcludeFromContext: excluded,
	}
	message := session.Message{Content: conversation.UserBashContext(recorded), UserBash: &recorded}
	saved, err := session.SaveUserMessage(wd, s.sessionID, input, message)
	if err != nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": err.Error()}})
		return
	}
	s.conv.AppendMessages(session.RebuildFromSession([]session.Message{saved}, false))
}

// runNotificationTurn mirrors RemoteServer.runNotificationTurn: it runs the
// agent with no new user message so the notification hook can drain pending
// task/teammate notifications into a turn.
func (s *Server) runNotificationTurn() {
	s.runMu.Lock()
	if s.stopping || s.ag == nil {
		s.runMu.Unlock()
		return
	}
	s.runMu.Unlock()
	ctx, ok := s.beginRun()
	if !ok {
		return
	}
	defer s.finishRun()
	s.runAgent(ctx)
}

// handleSandboxCommand mirrors RemoteServer.handleSandboxCommand: it toggles the
// OS sandbox at runtime (terminal /sandbox parity) or reports its status.
func (s *Server) handleSandboxCommand(args string) {
	s.snapshotMu.Lock()
	args = strings.TrimSpace(args)
	changed := args == "off" || args == "auto" || args == "manual"
	defer func() {
		s.snapshotMu.Unlock()
		if changed {
			s.broadcastStatus()
		}
	}()
	if s.ag == nil || s.ag.Checker == nil {
		return
	}
	var bashTool *tools.BashTool
	if s.registry != nil {
		bashTool, _ = s.registry.Get("Bash").(*tools.BashTool)
	}
	wd := s.ag.CurrentCwd()
	switch arg := strings.TrimSpace(args); arg {
	case "off":
		s.ag.Checker.SandboxEnabled = false
		s.ag.Checker.SandboxAutoAllow = false
		s.disposeSandbox()
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Sandbox: OFF"}})
	case "auto", "manual":
		sb := s.sandboxRuntime.Get()
		available := sb != nil && sb.Available()
		if bashTool != nil {
			networkEnabled := true
			if s.sandboxCfg != nil && s.sandboxCfg.NetworkEnabled != nil {
				networkEnabled = *s.sandboxCfg.NetworkEnabled
			}
			bashTool.Sandbox = sb
			bashTool.SandboxRequired = true
			bashTool.SandboxConfig = sandbox.Config{
				AllowWrite:     []string{wd, os.TempDir()},
				DenyWrite:      nil,
				NetworkEnabled: networkEnabled,
			}
		}
		s.ag.Checker.SandboxEnabled = true
		s.ag.Checker.SandboxAutoAllow = arg == "auto"
		mode := "manual permissions"
		if arg == "auto" {
			mode = "auto-allow"
		}
		message := "Sandbox: ON + " + mode
		if !available {
			message += " (blocked: sandbox unavailable)"
		}
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": message}})
	default:
		status := "OFF"
		if s.ag.Checker.SandboxEnabled {
			status = "ON + manual"
			if s.ag.Checker.SandboxAutoAllow {
				status = "ON + auto-allow"
			}
		}
		runtime := "not initialized"
		if s.ag.Checker.SandboxEnabled {
			if sb := s.sandboxRuntime.Get(); sb != nil && sb.Available() {
				runtime = "ready"
			} else {
				runtime = "blocked (sandbox unavailable)"
			}
		}
		lines := []string{
			"Sandbox status: " + status,
			"Runtime: " + runtime,
			"",
			"Usage: /sandbox <mode>",
			"  auto   — Enable sandbox + auto-allow (recommended)",
			"  manual — Enable sandbox + manual permission confirmation",
			"  off    — Disable sandbox",
		}
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": strings.Join(lines, "\n")}})
	}
}

// broadcastStatus mirrors RemoteServer.broadcastStatus: it pushes the current
// model/mode/thinking snapshot to every client.
func (s *Server) broadcastStatus() {
	if status, ok := s.statusPayload(); ok {
		s.send(status)
	}
}

// applyPermissionMode mirrors RemoteServer.applyPermissionMode, including the
// plan-mode entry/exit system reminders and conversation reminders.
func (s *Server) applyPermissionMode(mode permissions.PermissionMode) {
	s.snapshotMu.RLock()
	ag := s.ag
	s.snapshotMu.RUnlock()
	if ag == nil || ag.Checker == nil || ag.Checker.Mode() == mode {
		return
	}
	checker := ag.Checker
	switch {
	case mode == permissions.ModePlan:
		checker.EnterPlanMode()
		planPath, err := plan_file.GetOrCreatePlanPath(checker)
		if err != nil {
			planPath = ""
		}
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Entered plan mode (read-only). Plan file: " + planPath}})
		s.planMu.Lock()
		exited := s.hasExitedPlanMode
		s.hasExitedPlanMode = false
		s.planMu.Unlock()
		if exited && plan_file.PlanExists(checker) {
			if reentry := prompt.BuildPlanModeReentryReminder(planPath, true); reentry != "" {
				s.conv.AddSystemReminder(reentry)
				s.send(wsMessage{Type: "system", Data: map[string]string{"message": reentry}})
			}
		}
	case checker.Mode() == permissions.ModePlan:
		planPath := checker.CurrentPlanPath()
		s.planMu.Lock()
		s.hasExitedPlanMode = true
		s.planMu.Unlock()
		checker.ExitPlanMode(mode)
		s.conv.AddSystemReminder(prompt.BuildPlanModeExitReminder(planPath, planPath != "" && plan_file.PlanExists(checker)))
		message := "Exited plan mode. Each edit requires confirmation."
		if mode == permissions.ModeBypass {
			message = "Exited plan mode. Entered YOLO mode."
		}
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": message}})
	default:
		checker.SetMode(mode)
	}
	s.broadcastStatus()
}

var (
	unsafeNameChars = regexp.MustCompile(`[^a-zA-Z0-9._-]`)
	trailingNameExt = regexp.MustCompile(`\.[^.]*$`)
)

type imageUploadData struct {
	ClientID   string `json:"clientId"`
	Name       string `json:"name"`
	DataBase64 string `json:"dataBase64"`
}

// handleImageUpload mirrors RemoteServer.handleImageUpload: it decodes the
// base64 payload, validates size and magic bytes, stores the image in the
// session's file-history directory, and unicasts image_saved/image_error.
func (s *Server) handleImageUpload(conn *websocket.Conn, upload imageUploadData) {
	reply := func(msg wsMessage) { s.sendTo(conn, msg) }
	fail := func(message string) {
		reply(wsMessage{Type: "image_error", Data: map[string]string{"clientId": upload.ClientID, "message": message}})
	}
	if !s.ensureAgent() {
		fail("Agent is not ready yet.")
		return
	}
	data := decodeUploadBase64(upload.DataBase64)
	if len(data) == 0 {
		fail("Uploaded image is empty.")
		return
	}
	if len(data) > MaxUploadImageBytes {
		fail(fmt.Sprintf("Uploaded image is too large (%d bytes, limit %d).", len(data), MaxUploadImageBytes))
		return
	}
	mediaType, ok := images.SniffMediaType(data)
	if !ok {
		fail("Uploaded file is not a recognized image (png, jpeg, gif, webp).")
		return
	}
	ext := ".webp"
	switch mediaType {
	case images.MediaTypePNG:
		ext = ".png"
	case images.MediaTypeJPEG:
		ext = ".jpg"
	case images.MediaTypeGIF:
		ext = ".gif"
	}
	s.snapshotMu.RLock()
	sessionID := s.sessionID
	s.snapshotMu.RUnlock()
	dir, err := file_history.FileHistoryDir(sessionID)
	if err != nil {
		fail(err.Error())
		return
	}
	if err := storage.MkdirPrivateSync(dir); err != nil {
		fail(err.Error())
		return
	}
	safeName := trailingNameExt.ReplaceAllString(unsafeNameChars.ReplaceAllString(upload.Name, "_"), "")
	if len(safeName) > 80 {
		safeName = safeName[:80]
	}
	if safeName == "" {
		safeName = "image"
	}
	path := filepath.Join(dir, fmt.Sprintf("upload-%s-%s%s", uuid.NewString(), safeName, ext))
	if err := storage.WritePrivateFileSync(path, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		fail(err.Error())
		return
	}
	reply(wsMessage{Type: "image_saved", Data: map[string]string{"clientId": upload.ClientID, "path": path}})
}

// sendFileCompletions mirrors RemoteServer.sendFileCompletions: it scans the
// agent cwd (cached for FileCacheTTLMS) and unicasts the filtered matches.
func (s *Server) sendFileCompletions(conn *websocket.Conn, requestID, query string) {
	root := mustGetwd()
	s.snapshotMu.RLock()
	if s.ag != nil {
		root = s.ag.CurrentCwd()
	}
	s.snapshotMu.RUnlock()
	s.fileCacheMu.Lock()
	var files []string
	if s.fileCacheKey == root && time.Since(s.fileCacheTime) < FileCacheTTLMS*time.Millisecond {
		files = s.fileCache
	} else {
		files = utils.ScanCwdFiles(root, 0)
		s.fileCacheKey = root
		s.fileCache = files
		s.fileCacheTime = time.Now()
	}
	s.fileCacheMu.Unlock()
	matches := utils.FilterFileMatches(files, query, 0)
	if matches == nil {
		matches = []string{}
	}
	s.sendTo(conn, wsMessage{Type: "file_complete_response", Data: map[string]any{"requestId": requestID, "matches": matches}})
}

// backgroundForegroundShells mirrors RemoteServer.backgroundForegroundShells
// (Ctrl+B parity): running foreground shells move to the background.
func (s *Server) backgroundForegroundShells() {
	s.snapshotMu.RLock()
	defer s.snapshotMu.RUnlock()
	if s.registry == nil || !tools.HasAnyForegroundTasks(s.registry) {
		return
	}
	count := tools.BackgroundAllForegroundTasks(s.registry)
	s.send(wsMessage{Type: "system", Data: map[string]string{
		"message": fmt.Sprintf("Moved %d foreground shell task(s) to the background.", count),
	}})
}

// steer mirrors AgentHandleImpl.steer: it queues a mid-run steering message and
// reports whether a run was active to receive it.
func (s *Server) steer(text string, input *history.InputEntry) bool {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.currentAgent == nil {
		return false
	}
	if _, err := s.currentAgent.Steer(text, input); err != nil {
		return false
	}
	return true
}

// handleSteeringMessage mirrors RemoteServer.handleSteeringMessage: it routes a
// message that arrived mid-run to goal control, a follow-up, or model steering.
func (s *Server) handleSteeringMessage(content string, submittedInput *history.InputEntry) {
	text := strings.TrimSpace(content)
	if text == "" {
		return
	}
	wd := mustGetwd()
	s.snapshotMu.RLock()
	ag, sessionID := s.ag, s.sessionID
	if ag != nil {
		wd = ag.CurrentCwd()
	}
	s.snapshotMu.RUnlock()
	if matches := goalControlPattern.FindStringSubmatch(text); matches != nil && ag != nil {
		cmdName := "goal"
		_, _ = history.RecordInput(history.InputOptions{Text: text, Cwd: wd, SessionID: &sessionID, Source: "ws", CommandName: &cmdName})
		result := goal.HandleGoalCommand(s.goal(), matches[1])
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": result.Message}})
		return
	}
	// Slash and Bash commands run as follow-ups instead of model steering.
	isSlashCommand := false
	if strings.HasPrefix(text, "/") {
		_, _, isSlashCommand = commands.Parse(text)
	}
	_, _, isUserBash := userbash.ParseCommand(text)
	if isSlashCommand || isUserBash {
		s.enqueueFollowUp(text, nil)
		return
	}
	if ag == nil {
		s.enqueueFollowUp(text, submittedInput)
		return
	}
	var input history.InputEntry
	if submittedInput != nil {
		input = *submittedInput
	} else {
		var err error
		input, err = history.RecordInput(history.InputOptions{Text: text, Cwd: wd, SessionID: &sessionID, Source: "ws"})
		if err != nil {
			s.enqueueFollowUp(text, nil)
			return
		}
	}
	if !s.steer(text, &input) {
		s.enqueueFollowUp(text, &input)
		return
	}
	s.send(wsMessage{Type: "steering_queued", Data: map[string]string{"text": text}})
}

// enqueueFollowUp mirrors RemoteServer.enqueueFollowUp.
func (s *Server) enqueueFollowUp(text string, input *history.InputEntry) {
	s.followUpsMu.Lock()
	s.followUps = append(s.followUps, followUpEntry{text: text, input: input})
	s.followUpsMu.Unlock()
	s.broadcastFollowUps()
}

// broadcastFollowUp mirrors RemoteServer.broadcastFollowUps.
func (s *Server) broadcastFollowUps() {
	s.followUpsMu.Lock()
	list := make([]string, 0, len(s.followUps))
	for _, entry := range s.followUps {
		list = append(list, entry.text)
	}
	s.followUpsMu.Unlock()
	s.send(wsMessage{Type: "followups", Data: map[string]any{"list": list}})
}

// drainFollowUps mirrors RemoteServer.drainFollowUps: it replays queued
// follow-ups one at a time once the streaming slot is free.
func (s *Server) drainFollowUps() {
	for {
		s.runMu.Lock()
		blocked := s.streaming || s.stopping
		s.runMu.Unlock()
		if blocked {
			return
		}
		s.followUpsMu.Lock()
		if len(s.followUps) == 0 {
			s.followUpsMu.Unlock()
			return
		}
		next := s.followUps[0]
		s.followUps = s.followUps[1:]
		s.followUpsMu.Unlock()
		s.broadcastFollowUps()
		s.handleUserMessage(next.text, next.input)
	}
}

// replaySteeringLeftovers mirrors the reference post-run replay of steering
// messages queued too late for in-run delivery.
func (s *Server) replaySteeringLeftovers(leftovers []agent.SteeringMessage) {
	for _, leftover := range leftovers {
		input := leftover.Input
		s.runMu.Lock()
		streaming := s.streaming
		s.runMu.Unlock()
		if streaming {
			s.handleSteeringMessage(leftover.Text, &input)
		} else {
			s.handleUserMessage(leftover.Text, &input)
		}
	}
}

// changeProviderConfiguration mirrors RemoteServer.changeProviderConfiguration:
// it blocks model/provider changes while a run is in flight and holds the
// streaming slot for the duration of the reconfiguration.
func (s *Server) changeProviderConfiguration(change func()) {
	if s.claimProviderConfiguration() {
		s.runProviderConfiguration(change)
	}
}

func (s *Server) submitProviderConfiguration(conn *websocket.Conn, change func()) {
	if s.claimProviderConfiguration() {
		go s.handleRequest(conn, func() { s.runProviderConfiguration(change) })
	}
}

func (s *Server) claimProviderConfiguration() bool {
	s.runMu.Lock()
	if s.streaming || s.stopping {
		s.runMu.Unlock()
		s.send(wsMessage{Type: "system", Data: map[string]string{
			"message": "Cannot change models or providers while a run is in progress.",
		}})
		return false
	}
	s.streaming = true
	s.runMu.Unlock()
	s.send(wsMessage{Type: "run_state", Data: map[string]any{"streaming": true}})
	return true
}

func (s *Server) runProviderConfiguration(change func()) {
	defer func() {
		s.runMu.Lock()
		s.streaming = false
		s.runMu.Unlock()
		s.send(wsMessage{Type: "run_state", Data: map[string]any{"streaming": false}})
		s.drainFollowUps()
	}()
	change()
}

func (s *Server) handleRequest(conn *websocket.Conn, request func()) {
	defer func() {
		if failure := recover(); failure != nil {
			s.sendTo(conn, wsMessage{Type: "system", Data: map[string]string{"message": fmt.Sprintf("Request failed: %v", failure)}})
		}
	}()
	request()
}

// rebuildClientFor mirrors the reference applyModel/applyProviderSwitch client
// rebuild: it constructs a fresh LLM client for the provider and rebinds the
// agent, Agent tool, and MCP loading strategy.
func (s *Server) rebuildClientFor(provider *config.ProviderConfig) error {
	wd := mustGetwd()
	if s.ag != nil {
		wd = s.ag.CurrentCwd()
	}
	env := prompt.DetectEnvironment(wd)
	env.Model = provider.Model
	client, err := llm.NewClient(provider, prompt.BuildSystemPrompt(env))
	if err != nil {
		return err
	}
	// Mirrors the reference applyModel/applyProviderSwitch: dispose the memory
	// tasks before the client swap so the next loop completion recreates them
	// with the new client. The swap shares OnLoopComplete's lock because the
	// lazy recreation reads s.client on its own goroutine.
	s.memoryMu.Lock()
	stale := s.memoryTasks
	s.memoryTasks = nil
	s.client = client
	s.memoryMu.Unlock()
	if stale != nil {
		stale.Dispose()
	}
	if s.ag != nil {
		s.ag.Client = client
		s.ag.Protocol = provider.Protocol
		s.ag.ContextWindow = config.GetContextWindow(provider)
		s.ag.MaxOutputTokens = config.GetMaxOutputTokens(provider)
	}
	if at, ok := s.registry.Get("Agent").(*subagent.AgentTool); ok {
		at.SetClient(client, provider)
	}
	if s.ag != nil && s.ag.Hooks != nil {
		s.ag.Hooks.AgentRunner = newAgentHookRunner(client)
	}
	mcp.DecideAndApply(s.registry, provider.BaseURL, provider.Protocol, config.GetContextWindow(provider), s.MCPLoading)
	return nil
}

// applyModel mirrors RemoteServer.applyModel: it switches the active model,
// rebuilding the client (terminal /model parity).
func (s *Server) applyModel(modelID string) {
	if !s.ensureAgent() {
		return
	}
	s.snapshotMu.Lock()
	p := s.activeProvider()
	if p == nil {
		s.snapshotMu.Unlock()
		return
	}
	nextModel := strings.TrimSpace(modelID)
	if nextModel == "" {
		s.snapshotMu.Unlock()
		return
	}
	if nextModel == p.Model {
		s.snapshotMu.Unlock()
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": fmt.Sprintf("Model already set to %s.", nextModel)}})
		return
	}
	updated := *p
	updated.Model = nextModel
	if err := s.rebuildClientFor(&updated); err != nil {
		s.snapshotMu.Unlock()
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": fmt.Sprintf("Failed to switch model: %s", err)}})
		return
	}
	s.provider = &updated
	for i := range s.providers {
		if s.providers[i].BaseURL == updated.BaseURL {
			s.providers[i].Model = updated.Model
		}
	}
	s.snapshotMu.Unlock()
	// A save failure must not undo the runtime switch.
	saved := config.PersistModel(updated.BaseURL, updated.Model) == nil
	s.broadcastStatus()
	note := fmt.Sprintf("Model set to %s and saved.", updated.Model)
	if !saved {
		note = fmt.Sprintf("Model set to %s for this session.", updated.Model)
	}
	s.send(wsMessage{Type: "system", Data: map[string]string{"message": note}})
}

// applyProviderSwitch mirrors RemoteServer.applyProviderSwitch: it switches the
// active provider, rebuilding the client (terminal parity).
func (s *Server) applyProviderSwitch(index int) {
	s.snapshotMu.Lock()
	if index < 0 || index >= len(s.providers) {
		s.snapshotMu.Unlock()
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": fmt.Sprintf("Unknown provider index: %d", index)}})
		return
	}
	provider := s.providers[index]
	needsAgent := s.ag == nil
	if needsAgent {
		s.defaultProvider = index
	}
	s.snapshotMu.Unlock()
	if needsAgent && !s.ensureAgent() {
		return
	}
	s.snapshotMu.Lock()
	if err := s.rebuildClientFor(&provider); err != nil {
		s.snapshotMu.Unlock()
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": fmt.Sprintf("Failed to switch provider: %s", err)}})
		return
	}
	s.provider = &provider
	s.defaultProvider = index
	s.snapshotMu.Unlock()
	saved := config.PersistDefaultProvider(index) == nil
	s.broadcastStatus()
	message := fmt.Sprintf("Provider switched to %s · %s.", provider.Name, provider.Model)
	if !saved {
		message += " Default provider could not be saved."
	}
	s.send(wsMessage{Type: "system", Data: map[string]string{"message": message}})
}

// handleProviderSave mirrors RemoteServer.handleProviderSave: it saves a
// provider from the browser login form and activates it.
func (s *Server) handleProviderSave(form map[string]any) {
	s.snapshotMu.Lock()
	saved, err := config.SaveProvider(form, s.providers)
	if err != nil {
		s.snapshotMu.Unlock()
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": fmt.Sprintf("Failed to save provider: %s", err)}})
		return
	}
	s.providers = saved.Providers
	s.snapshotMu.Unlock()
	message := fmt.Sprintf("Provider %s saved.", saved.Provider.Name)
	if saved.Replaced {
		message = fmt.Sprintf("Provider %s saved (replaced existing entry).", saved.Provider.Name)
	}
	s.send(wsMessage{Type: "system", Data: map[string]string{"message": message}})
	index := 0
	for i, entry := range saved.Providers {
		if entry.BaseURL == saved.Provider.BaseURL {
			index = i
			break
		}
	}
	s.applyProviderSwitch(index)
}

// broadcastModelList mirrors RemoteServer.broadcastModelList: it discovers the
// provider's models and streams loading/ready/empty/error states.
func (s *Server) broadcastModelList() {
	if !s.ensureAgent() {
		return
	}
	s.snapshotMu.RLock()
	p := s.activeProvider()
	if p == nil {
		s.snapshotMu.RUnlock()
		return
	}
	provider := *p
	s.snapshotMu.RUnlock()
	p = &provider
	s.modelListMu.Lock()
	if s.modelListCancel != nil {
		s.modelListCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.modelListCancel = cancel
	s.modelListGeneration++
	generation := s.modelListGeneration
	s.modelListMu.Unlock()
	defer func() {
		cancel()
		s.modelListMu.Lock()
		if s.modelListGeneration == generation {
			s.modelListCancel = nil
		}
		s.modelListMu.Unlock()
	}()
	current := p.Model
	discovery := llm.DiscoveryConfig{Protocol: p.Protocol, BaseURL: p.BaseURL, APIKey: p.APIKey}
	s.send(wsMessage{Type: "model_list", Data: map[string]any{"status": "loading", "models": []any{}, "current": current}})
	models, err := llm.DiscoverModels(ctx, discovery)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		s.send(wsMessage{Type: "model_list", Data: map[string]any{"status": "error", "models": []any{}, "current": current}})
		return
	}
	status := "empty"
	if len(models) > 0 {
		status = "ready"
	}
	out := make([]map[string]any, 0, len(models))
	for _, m := range models {
		name := m.DisplayName
		if name == "" {
			name = m.Name
		}
		var nameValue any
		if name != "" {
			nameValue = name
		}
		out = append(out, map[string]any{"id": m.ID, "name": nameValue})
	}
	s.send(wsMessage{Type: "model_list", Data: map[string]any{"status": status, "models": out, "current": current}})
}

// broadcastProviderList mirrors RemoteServer.broadcastProviderList: it sends the
// configured providers plus the index of the active one to every client.
func (s *Server) broadcastProviderList() {
	s.snapshotMu.RLock()
	defer s.snapshotMu.RUnlock()
	currentIndex := 0
	if s.ag == nil {
		currentIndex = s.defaultProvider
	} else if p := s.activeProvider(); p != nil {
		for i, entry := range s.providers {
			if entry.BaseURL == p.BaseURL {
				currentIndex = i
				break
			}
		}
	}
	providers := make([]map[string]string, 0, len(s.providers))
	for _, entry := range s.providers {
		providers = append(providers, map[string]string{
			"name":     entry.Name,
			"protocol": entry.Protocol,
			"base_url": entry.BaseURL,
			"model":    entry.Model,
		})
	}
	s.send(wsMessage{Type: "provider_list", Data: map[string]any{"providers": providers, "current": currentIndex}})
}

// statusPayload builds the "status" snapshot message, mirroring
// RemoteServer.statusPayload. It reports false before the agent exists.
func (s *Server) statusPayload() (wsMessage, bool) {
	s.snapshotMu.RLock()
	defer s.snapshotMu.RUnlock()
	return s.statusSnapshot()
}

func (s *Server) statusSnapshot() (wsMessage, bool) {
	if s.ag == nil || s.ag.Checker == nil {
		return wsMessage{}, false
	}
	p := s.activeProvider()
	model, providerName := "", ""
	if p != nil {
		model = p.Model
		providerName = p.Name
	}
	thinkingLevel := ""
	var thinkingLevels []string
	if tlc, ok := s.client.(llm.ThinkingLevelControl); ok {
		thinkingLevel = tlc.GetThinkingLevel()
		thinkingLevels = tlc.GetSupportedThinkingLevels()
	}
	if thinkingLevel == "" && p != nil {
		thinkingLevel = p.Thinking
	}
	if thinkingLevel == "" {
		thinkingLevel = config.DefaultThinkingLevel
	}
	if thinkingLevels == nil && p != nil {
		thinkingLevels = config.GetSupportedThinkingLevels(p)
	}
	if thinkingLevels == nil {
		thinkingLevels = []string{}
	}
	return wsMessage{Type: "status", Data: map[string]any{
		"model":            model,
		"provider":         providerName,
		"permissionMode":   string(s.ag.Checker.Mode()),
		"thinkingLevel":    thinkingLevel,
		"thinkingLevels":   thinkingLevels,
		"sandboxEnabled":   s.ag.Checker.SandboxEnabled,
		"sandboxAutoAllow": s.ag.Checker.SandboxAutoAllow,
		"contextWindow":    s.ag.ContextWindow,
	}}, true
}

// usagePayload builds the "usage" snapshot data, mirroring
// RemoteServer.usagePayload.
func (s *Server) usagePayload() map[string]any {
	s.snapshotMu.RLock()
	defer s.snapshotMu.RUnlock()
	return s.usageSnapshot()
}

func (s *Server) usageSnapshot() map[string]any {
	contextTokens, contextWindow := 0, 0
	if s.conv != nil {
		contextTokens = compact.CurrentContextTokens(s.conv)
	}
	if s.ag != nil {
		contextWindow = s.ag.ContextWindow
	}
	return map[string]any{
		"inputTokens":   s.lastUsageInput,
		"outputTokens":  s.lastUsageOutput,
		"contextTokens": contextTokens,
		"contextWindow": contextWindow,
	}
}

// startHeartbeat launches the ping/sweep loop that reaps half-open
// connections: a browser tab killed without a close frame would otherwise stay
// in the conns set forever, receiving broadcasts into a dead socket.
func (s *Server) startHeartbeat() {
	s.mu.Lock()
	if s.heartbeatDone != nil {
		s.mu.Unlock()
		return
	}
	ticker := time.NewTicker(time.Duration(HeartbeatIntervalMS) * time.Millisecond)
	done := make(chan struct{})
	s.heartbeatTicker = ticker
	s.heartbeatDone = done
	s.mu.Unlock()
	go func() {
		for {
			select {
			case <-ticker.C:
				s.sweepHeartbeat()
			case <-done:
				return
			}
		}
	}()
}

func (s *Server) sweepHeartbeat() {
	now := time.Now().UnixMilli()
	var ping []*websocket.Conn
	s.mu.Lock()
	for conn := range s.conns {
		last, ok := s.lastPongAt[conn]
		if !ok {
			last = now
		}
		if now-last > HeartbeatStaleMS {
			conn.Close()
			delete(s.conns, conn)
			delete(s.lastPongAt, conn)
			continue
		}
		ping = append(ping, conn)
	}
	s.mu.Unlock()
	for _, conn := range ping {
		_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second))
	}
}

func (s *Server) stopHeartbeat() {
	s.mu.Lock()
	if s.heartbeatTicker != nil {
		s.heartbeatTicker.Stop()
		s.heartbeatTicker = nil
	}
	if s.heartbeatDone != nil {
		close(s.heartbeatDone)
		s.heartbeatDone = nil
	}
	s.mu.Unlock()
}

func (s *Server) send(msg wsMessage) {
	if msg.Type == "clear" && s.mcpApps != nil {
		s.mcpApps.Clear()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.conns) == 0 {
		return
	}
	data, _ := json.Marshal(msg)
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for conn := range s.conns {
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			log.Printf("[ws] write error: type=%s err=%v", msg.Type, err)
		}
	}
}

// wireSkillCommands mirrors the reference's remote wireSkillsToCommands:
// skills are captured at wire time and taken names are skipped.
func (s *Server) wireSkillCommands() {
	bootstrap.WireSkillsToRegistry(s.skillCatalog, s.cmdRegistry, s)
}

func (s *Server) ActivateSkill(name, body string) {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.ag != nil {
		s.ag.ActivateSkill(name, body)
	}
	if s.currentAgent != nil {
		s.currentAgent.ActivateSkill(name, body)
	}
}

func (s *Server) SnapshotParentMessages(count int) string {
	messages := s.conv.GetMessages()
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

func remoteMessageText(message conversation.Message) string {
	if len(message.ContentBlocks) > 0 {
		return utils.ContentToText(message.ContentBlocks)
	}
	return message.Content
}

func (s *Server) RunSubagent(ctx context.Context, prompt string) (string, error) {
	if s.client == nil || s.ag == nil {
		return "", errors.New("RunSubagent: agent is not ready")
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
	wd, _ := os.Getwd()
	runtime, _ := tools.RuntimeContext(ctx)
	checker := s.ag.Checker
	if runtime.Plan != nil {
		if scoped, ok := runtime.Plan.Owner.(*permissions.Checker); ok {
			checker = scoped
		}
	}
	if runtime.RequestPermission == nil {
		runtime.RequestPermission = s.requestPermissionViaWS
	}
	ctx = tools.WithExecutionContext(ctx, runtime)
	return subagent.SpawnSubagent(ctx, definition, prompt, s.client, s.registry, s.activeProvider(), wd, nil, nil, "", checker.ForCwd(wd), subagent.SubagentRunOptions{Background: false})
}

func (s *Server) SetToolFilter(allow func(name string) bool) {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	coordinator := teams.CoordinatorToolFilter(s.enableCoordinatorMode)
	filter := allow
	if coordinator != nil {
		filter = func(name string) bool { return coordinator(name) && (allow == nil || allow(name)) }
	}
	if s.ag != nil {
		s.ag.SetToolFilter(filter)
	}
	if s.currentAgent != nil {
		s.currentAgent.SetToolFilter(filter)
	}
}

func (s *Server) ToolRegistry() *tools.Registry {
	return s.registry
}

// workflowHostContext builds the tool execution context carried into
// workflow agent runs: the permission checker plus a WS round-trip
// permission callback, mirroring createPermissionCallback.
func (s *Server) workflowHostContext(wd string) context.Context {
	execution := tools.ExecutionContext{
		WorkDir:           wd,
		SessionID:         s.sessionID,
		RequestPermission: s.requestPermissionViaWS,
	}
	if s.ag != nil && s.ag.Checker != nil {
		execution.Plan = &tools.PlanContext{Owner: s.ag.Checker}
	}
	return tools.WithExecutionContext(context.Background(), execution)
}

func (s *Server) requestPermissionViaWS(ctx context.Context, request tools.PermissionRequest) int {
	responseCh := make(chan agent.PermissionReply, 1)
	description := request.Desc
	if request.AgentName != "" && request.Cwd != "" {
		description = request.AgentName + " · " + request.Cwd + "\n" + description
	}
	s.requestPermission(ctx, permissionRequestPayload{ToolName: request.ToolName, Description: description, RememberPatterns: request.RememberPatterns}, responseCh)
	reply := <-responseCh
	return int(reply.Response)
}

func loadCustomInstructions(wd string) string {
	return memory.LoadInstructions(wd)
}

// installMemoryTasks wires the agent's loop-complete hook to lazily create and
// run the background memory tasks, mirroring the reference onLoopComplete
// (`if (!this.memoryEnabled || this.disposed) return;
// this.memoryTasks ??= new BackgroundMemoryTasks(this.client, this.cwd, ...);
// this.memoryTasks.run(conv)`). Lazy creation lets stopMemoryTasks dispose the
// tasks on resume/clear/rewind/client-swap and have them recreated on the next
// loop completion bound to the reset conversation and current client.
func (s *Server) installMemoryTasks(ag *agent.Agent, wd string) {
	ag.OnLoopComplete = func(loopConv *conversation.Manager) {
		if !s.memoryEnabled || s.disposed.Load() {
			return
		}
		s.memoryMu.Lock()
		defer s.memoryMu.Unlock()
		if s.disposed.Load() {
			return
		}
		if s.memoryTasks == nil {
			s.memoryTasks = background.New(s.client, wd, background.Callbacks{
				AppendSystem: func(message string) { s.conv.AddSystemReminder(message) },
			})
		}
		s.memoryTasks.Run(loopConv)
	}
}

// stopMemoryTasks disposes the background memory tasks and clears the reference
// so the next loop completion recreates them, mirroring the reference
// stopMemoryTasks (dispose + null).
func (s *Server) stopMemoryTasks() {
	s.memoryMu.Lock()
	tasks := s.memoryTasks
	s.memoryTasks = nil
	s.memoryMu.Unlock()
	if tasks != nil {
		tasks.Dispose()
	}
}

func newAgentHookRunner(client llm.Client) func(prompt string, ctx hooks.HookContext) (string, error) {
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

func mustGetwd() string {
	wd, _ := os.Getwd()
	return wd
}

// buildSessionStatus renders the rich /status block (src/remote/server.ts
// buildSessionStatus parity: provider, sandbox, MCP, session).
func (s *Server) buildSessionStatus() string {
	if s.ag == nil {
		return "Agent is not ready yet."
	}
	p := s.activeProvider()
	var model, providerName, protocol string
	if p != nil {
		model = p.Model
		providerName = p.Name
		protocol = p.Protocol
	}
	permMode := string(s.ag.Checker.Mode())
	sbStatus := "OFF"
	if s.ag.Checker.SandboxEnabled {
		sb := s.sandboxRuntime.Get()
		state := "blocked"
		if sb != nil && sb.Available() {
			state = "ready"
		}
		label := "ON (manual)"
		if s.ag.Checker.SandboxAutoAllow {
			label = "ON (auto-allow)"
		}
		sbStatus = label + ", " + state
	}
	memories := "disabled (enable_memory: false)"
	if s.memoryEnabled {
		count := 0
		if s.memoryMgr != nil {
			count = len(s.memoryMgr.GetMemories())
		}
		memories = strconv.Itoa(count)
	}
	skillCount := 0
	if s.skillCatalog != nil {
		skillCount = len(s.skillCatalog.List())
	}
	mcpServers := 0
	if s.mcpMgr != nil {
		mcpServers = len(s.mcpMgr.ConnectedServers())
	}
	wd, _ := os.Getwd()
	lines := []string{
		"Mode:      " + permMode,
		"Model:     " + model,
		fmt.Sprintf("Provider:  %s (%s)", providerName, protocol),
		fmt.Sprintf("Tokens:    %d in / %d out", s.lastUsageInput, s.lastUsageOutput),
		fmt.Sprintf("Tools:     %d", len(s.registry.ListTools())),
		"Sandbox:   " + sbStatus,
		"Memories:  " + memories,
		fmt.Sprintf("Skills:    %d", skillCount),
		fmt.Sprintf("MCP:       %d server(s), %d tool(s)", mcpServers, bootstrap.CountMcpTools(s.registry)),
		"Session:   " + s.sessionID,
		"Directory: " + wd,
	}
	return strings.Join(lines, "\n")
}

// buildMemoryStatus renders /memory output (src/remote/server.ts
// buildMemoryStatus parity).
func (s *Server) buildMemoryStatus(args string) string {
	if s.ag == nil {
		return "Memory is not available yet."
	}
	if !s.memoryEnabled {
		return "Auto memory is disabled (enable_memory: false in config.yaml)."
	}
	sub := ""
	if fields := strings.Fields(strings.TrimSpace(args)); len(fields) > 0 {
		sub = fields[0]
	}
	wd, _ := os.Getwd()
	mgr := memory.NewManager(wd, nil)
	if sub == "clear" {
		mgr.Clear()
		return "All memories cleared."
	}
	mems := mgr.GetMemories()
	if len(mems) == 0 {
		return "No memories saved yet. They are auto-extracted; /memory clear wipes them."
	}
	lines := make([]string, 0, len(mems))
	for _, mem := range mems {
		lines = append(lines, fmt.Sprintf("  [%s] %s — %s", mem.Type, mem.Name, mem.Description))
	}
	return fmt.Sprintf("Memories (%d):\n%s", len(mems), strings.Join(lines, "\n"))
}
