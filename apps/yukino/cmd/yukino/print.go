package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/workflow"
)

// printOwnsSignals marks that print mode installed its own SIGINT/SIGTERM
// handlers, so main.go's global handler defers shutdown to it.
var printOwnsSignals atomic.Bool

type printResult struct {
	Type       string          `json:"type"`
	Result     string          `json:"result"`
	DurationMs int64           `json:"duration_ms"`
	NumTurns   int             `json:"num_turns"`
	ToolCalls  []*toolCallInfo `json:"tool_calls"`
	Usage      resultUsage     `json:"usage"`
}

// toolCallInfo mirrors the reference result line's tool_calls entry.
type toolCallInfo struct {
	Tool    string  `json:"tool"`
	ToolID  string  `json:"tool_id"`
	Elapsed float64 `json:"elapsed"`
}

// resultUsage mirrors the reference result line's usage object (camelCase).
type resultUsage struct {
	InputTokens              int `json:"inputTokens"`
	OutputTokens             int `json:"outputTokens"`
	CacheReadInputTokens     int `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int `json:"cacheCreationInputTokens"`
}

func runPrint(userPrompt string, cfg *config.AppConfig, hookCfgs []config.HookConfig, outputFormat string) (int, error) {
	p := config.ResolveDefaultProvider(cfg.Providers, cfg.DefaultProvider)
	wd, _ := os.Getwd()
	startTime := time.Now()
	isJSON := outputFormat == "stream-json"

	sessionID := session.NewID()
	goalManager := goal.NewGoalManager(wd, sessionID)

	// The goal command runs before any runtime chunk is built, mirroring the
	// reference maintenance-mode fast path.
	cmdName, cmdArgs, isCmd := commands.Parse(userPrompt)
	var commandName *string
	if isCmd && cmdName == "goal" {
		goalName := "goal"
		commandName = &goalName
	}
	input, err := history.RecordInput(history.InputOptions{Cwd: wd, SessionID: &sessionID, Source: "print", Text: userPrompt, CommandName: commandName})
	if err != nil {
		return 0, err
	}
	if isCmd && cmdName == "goal" {
		result := goal.HandleGoalCommand(goalManager, cmdArgs)
		if isJSON {
			emitJSON(map[string]any{"type": "goal", "message": result.Message, "goal": goalManager.Get()})
		} else {
			fmt.Println(result.Message)
		}
		if result.Prompt == "" {
			if isJSON {
				emitJSON(printResult{Type: "result", Result: result.Message, DurationMs: time.Since(startTime).Milliseconds(), NumTurns: 0, ToolCalls: []*toolCallInfo{}, Usage: resultUsage{}})
			}
			if result.IsError {
				return 1, nil
			}
			return 0, nil
		}
		userPrompt = result.Prompt
	}

	if isCmd && cmdName == "ultracode" {
		userPrompt = workflow.UltracodePrompt + "\n\nTask: " + cmdArgs
	} else if isCmd {
		for _, name := range workflow.ListNamedWorkflows(filepath.Join(wd, workflow.WorkflowDirName)) {
			if name == cmdName {
				userPrompt = workflow.BuildNamedWorkflowPrompt(cmdName, cmdArgs)
				break
			}
		}
	}

	instructionsContent := loadPrintInstructions(wd)

	env := prompt.DetectEnvironment(wd)
	env.Model = p.Model
	systemPrompt := prompt.BuildSystemPrompt(env)

	client, err := llm.NewClient(p, systemPrompt)
	if err != nil {
		return 0, err
	}

	// Print mode feeds the raw prompt to the agent and session; @ref
	// expansion is a UI/remote concern only (mirrors the reference). The
	// message is persisted before any runtime chunk is built, so even the
	// /workflows command path leaves it in the session.
	conv := conversation.NewManager()
	recorded, err := session.SaveUserMessage(wd, sessionID, input, session.Message{Content: userPrompt})
	if err != nil {
		return 0, err
	}
	conv.AppendMessages([]conversation.Message{recorded.ToConversation()})

	taskMgr := subagent.NewTaskManager()
	if err := taskMgr.UseSession(sessionID); err != nil {
		return 0, err
	}
	// Mirrors the reference finally block: background tasks and team runtimes
	// stop first, then the registry disposes, then MCP disconnects.
	var (
		teamMgr  *teams.TeamManager
		registry *tools.Registry
		mcpMgr   *mcp.Manager
	)
	defer func() {
		_ = taskMgr.StopAll(context.Background())
		if teamMgr != nil {
			teamMgr.CloseAll()
		}
		if registry != nil {
			_ = registry.Dispose()
		}
		if mcpMgr != nil {
			mcpMgr.DisconnectAll()
		}
	}()
	store, err := todo.NewStore(sessionID)
	if err != nil {
		return 0, err
	}
	todoList, err := todo.NewTaskList(store)
	if err != nil {
		return 0, err
	}
	loader := subagent.NewAgentLoader()
	loader.LoadAll()

	teamMgr = teams.NewTeamManager(wd)
	teamMgr.CoordinatorMode = cfg.EnableCoordinatorMode

	defaultTools := bootstrap.CreateToolRegistry(todoList, bootstrap.ToolRegistryOptions{
		InteractionMode: "non-interactive",
		TeamMgr:         teamMgr,
		WorkDir:         wd,
		GoalManager:     func() *goal.GoalManager { return goalManager },
	})
	registry = defaultTools.Registry

	// Print mode intentionally bypasses permission prompts.
	checker := permissions.NewChecker(
		permissions.NewPathSandbox(wd, true),
		permissions.NewRuleEngine(wd),
		permissions.ModeBypass,
	)
	bootstrap.ConfigureBashSandbox(registry, wd, cfg.Sandbox, checker)
	teamMgr.SetPermissionChecker(checker)

	tools.AttachBackgroundTaskManager(registry, taskMgr)
	registry.Register(&teams.TeamCreateTool{TeamMgr: teamMgr})
	registry.Register(&teams.TeamDeleteTool{TeamMgr: teamMgr})
	registry.Register(&teams.TeamListTool{TeamMgr: teamMgr})
	registry.Register(&teams.SendMessageTool{TeamMgr: teamMgr, SenderName: "leader"})
	registry.Register(&teams.TaskStopTool{TeamMgr: teamMgr, TaskManager: taskMgr})
	registry.Register(&tools.SyntheticOutputTool{})

	registry.Register(&subagent.AgentTool{
		Client:       client,
		Provider:     p,
		Registry:     registry,
		Protocol:     p.Protocol,
		TaskMgr:      taskMgr,
		Loader:       loader,
		Conversation: conv,
		TeamMgr:      teamMgr,
	})
	workflow.AttachWorkflow(workflow.WorkflowServiceOptions{
		WorkflowBackendOptions: workflow.WorkflowBackendOptions{
			Registry:    registry,
			GetClient:   func() llm.Client { return client },
			GetProvider: func() *config.ProviderConfig { return p },
		},
		Cwd:         wd,
		TaskManager: taskMgr,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	printOwnsSignals.Store(true)
	defer printOwnsSignals.Store(false)
	var aborted atomic.Bool
	var signalExit atomic.Int32
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	go func() {
		sig := <-sigCh
		if sig == syscall.SIGTERM {
			signalExit.Store(143)
		} else {
			signalExit.Store(130)
		}
		aborted.Store(true)
		cancel()
		for _, task := range taskMgr.List() {
			taskMgr.Stop(task.ID)
		}
	}()

	// Connect to MCP. Done after all built-in tools are registered: the MCP
	// tool load mode compares total schema size against the context window,
	// so it only computes accurately once all tools are in place.
	if len(cfg.MCPServers) > 0 {
		mcpMgr = mcp.NewManager(false)
		result := mcpMgr.ConnectAll(context.Background(), cfg.MCPServers)
		for _, connected := range result.Tools {
			registry.Register(connected.Tool)
		}
		for _, connectError := range result.Errors {
			fmt.Fprintf(os.Stderr, "MCP warning: %s: %s\n", connectError.ServerName, connectError.Error)
		}
		mcp.DecideAndApply(registry, p.BaseURL, p.Protocol, config.GetContextWindow(p), cfg.MCPLoading)
	}

	if isCmd && cmdName == "workflows" {
		service := workflow.GetWorkflowService(registry)
		message := "Workflow service is not initialized"
		if service != nil {
			hostCtx := tools.WithExecutionContext(ctx, tools.ExecutionContext{
				WorkDir:   wd,
				SessionID: sessionID,
				Plan:      &tools.PlanContext{Owner: checker},
			})
			result, err := service.Command(cmdArgs, hostCtx)
			if err != nil {
				return 0, err
			}
			message = result
		}
		if !isJSON {
			fmt.Printf("%s\n", message)
		}
		_ = taskMgr.WaitAll(context.Background(), func(task tools.BackgroundTask) bool { return task.Kind != "shell" })
		drained, err := taskMgr.DrainNotifications()
		if err != nil {
			return 1, err
		}
		for _, task := range drained {
			notification := subagent.FormatAgentTaskNotification(task)
			if isJSON {
				emitJSON(map[string]any{"type": "task_notification", "notification": notification})
			} else {
				fmt.Printf("%s\n", notification)
			}
		}
		if isJSON {
			emitJSON(printResult{Type: "result", Result: message, DurationMs: time.Since(startTime).Milliseconds(), NumTurns: 0, ToolCalls: []*toolCallInfo{}, Usage: resultUsage{}})
		}
		return 0, nil
	}

	ag := agent.New(client, registry, p.Protocol)
	ag.ContextWindow = config.GetContextWindow(p)
	ag.MaxOutputTokens = config.GetMaxOutputTokens(p)
	ag.Instructions = instructionsContent
	ag.SetSessionID(sessionID)
	ag.GoalManager = goalManager
	ag.Checker = checker

	if len(hookCfgs) > 0 {
		eng := hooks.NewEngine(hookCfgs)
		ag.Hooks = eng
	}

	ag.NotificationFn = func() ([]string, error) {
		messages := teams.DrainLeadMailbox(teamMgr)
		drained, err := taskMgr.DrainNotifications()
		if err != nil {
			return nil, err
		}
		for _, task := range drained {
			messages = append(messages, subagent.FormatAgentTaskNotification(task))
		}
		return messages, nil
	}
	ag.ToolNameFilter = teams.CoordinatorToolFilter(cfg.EnableCoordinatorMode)
	ag.CoordinatorActiveFn = teams.CoordinatorActiveFn(cfg.EnableCoordinatorMode)

	if at, ok := registry.Get("Agent").(*subagent.AgentTool); ok {
		at.ParentChecker = ag.Checker
	}

	ch := ag.Run(ctx, conv)

	var resultText string
	var numTurns int
	var exitCode int
	var totalUsage resultUsage
	var toolCalls []*toolCallInfo
	callsByID := make(map[string]*toolCallInfo)

	for ev := range ch {
		if isJSON {
			emitStreamJSON(ev)
		} else if st, ok := ev.(agent.StreamText); ok {
			fmt.Print(st.Text)
		}

		switch e := ev.(type) {
		case agent.StreamText:
			resultText += e.Text
		case agent.ToolUseEvent:
			call := &toolCallInfo{Tool: e.ToolName, ToolID: e.ToolID}
			toolCalls = append(toolCalls, call)
			callsByID[e.ToolID] = call
		case agent.ToolResultEvent:
			if call, ok := callsByID[e.ToolID]; ok {
				call.Elapsed = e.Elapsed.Seconds()
			}
		case agent.TurnComplete:
			numTurns++
		case agent.UsageEvent:
			totalUsage.InputTokens += e.InputTokens
			totalUsage.OutputTokens += e.OutputTokens
			totalUsage.CacheReadInputTokens += e.CacheReadTokens
			totalUsage.CacheCreationInputTokens += e.CacheCreationTokens
		case agent.ErrorEvent:
			if !aborted.Load() {
				exitCode = 1
			}
			if !isJSON {
				fmt.Fprintf(os.Stderr, "\nError: %s\n", e.Message)
			}
		case agent.LoopComplete:
			if e.StopReason == "interrupted" && !aborted.Load() {
				exitCode = 1
			}
		}
	}

	// Wait only for background Agent tasks: their results feed the final
	// answer. Shell tasks (backgrounded Bash/PowerShell commands) can run
	// indefinitely (dev servers, auto-backgrounded timeouts) and would hang
	// -p mode forever; whatever finished is drained below and the deferred
	// StopAll kills the rest.
	_ = taskMgr.WaitAll(context.Background(), func(task tools.BackgroundTask) bool { return task.Kind != "shell" })
	notifications, err := taskMgr.DrainNotifications()
	if err != nil {
		return 1, err
	}
	durationMs := time.Since(startTime).Milliseconds()

	if !isJSON && resultText != "" && !strings.HasSuffix(resultText, "\n") {
		fmt.Print("\n")
	}
	for _, task := range notifications {
		notification := subagent.FormatAgentTaskNotification(task)
		conv.AddSystemReminder(notification)
		last := conv.GetMessages()[conv.Len()-1]
		_ = session.SaveMessage(wd, sessionID, session.Message{Role: last.Role, Content: last.Content, Timestamp: time.Now().Unix()})
		if isJSON {
			emitJSON(map[string]any{"type": "task_notification", "notification": notification})
		} else {
			fmt.Printf("%s\n", notification)
		}
	}
	if isJSON {
		emitJSON(printResult{Type: "result", Result: resultText, DurationMs: durationMs, NumTurns: numTurns, ToolCalls: toolCalls, Usage: totalUsage})
	}

	if aborted.Load() {
		exitCode = int(signalExit.Load())
	}
	return exitCode, nil
}

// emitStreamJSON mirrors the reference emitStreamJson: each agent event becomes
// a single JSON line on stdout. Events not listed here are not emitted.
func emitStreamJSON(ev agent.AgentEvent) {
	switch e := ev.(type) {
	case agent.StreamText:
		emitJSON(map[string]any{"type": "stream_text", "text": e.Text})
	case agent.ThinkingText:
		emitJSON(map[string]any{"type": "thinking_text", "text": e.Text})
	case agent.ToolUseEvent:
		emitJSON(map[string]any{"type": "tool_use", "tool_name": e.ToolName, "tool_id": e.ToolID, "args": e.Args})
	case agent.ToolResultEvent:
		emitJSON(map[string]any{"type": "tool_result", "tool_name": e.ToolName, "tool_id": e.ToolID, "output": e.Output, "is_error": e.IsError, "elapsed": e.Elapsed.Seconds()})
	case agent.UsageEvent:
		emitJSON(map[string]any{"type": "usage", "input_tokens": e.InputTokens, "output_tokens": e.OutputTokens, "cache_read_input_tokens": e.CacheReadTokens, "cache_creation_input_tokens": e.CacheCreationTokens})
	case agent.ErrorEvent:
		emitJSON(map[string]any{"type": "error", "message": e.Message})
	case agent.TurnComplete:
		emitJSON(map[string]any{"type": "turn_complete"})
	case agent.LoopComplete:
		emitJSON(map[string]any{"type": "loop_complete", "stopReason": e.StopReason})
	case agent.SteeringDelivered:
		emitJSON(map[string]any{"type": "steering_delivered", "text": e.Text, "inputId": e.InputID})
	case agent.RetryEvent:
		emitJSON(map[string]any{"type": "retry", "reason": e.Reason, "delay": e.Wait.Milliseconds()})
	case agent.CompactEvent:
		emitJSON(map[string]any{"type": "compact", "message": e.Message})
	}
}

func emitJSON(v any) {
	data, _ := json.Marshal(v)
	fmt.Println(string(data))
}

func loadPrintInstructions(wd string) string {
	return memory.LoadInstructions(wd)
}
