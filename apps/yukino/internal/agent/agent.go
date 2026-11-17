package agent

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/telemetry"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type Agent struct {
	Client              llm.Client
	Registry            *tools.Registry
	Protocol            string
	AgentName           string
	WorkDir             string
	MaxIterations       int
	ContextWindow       int
	MaxOutputTokens     int
	Checker             *permissions.Checker
	Hooks               *hooks.Engine
	TranscriptPath      string
	SessionID           string
	TaskManager         tools.BackgroundTaskManager
	DisableBackground   bool
	NotificationFn      func() ([]string, error)
	InstructionsFn      func() string
	MemoryContentFn     func() string
	Instructions        string
	MemoryContent       string
	SkillSection        string
	SkillDeltaFn        func() string
	MemoryRecallCh      <-chan RecallResult
	ToolNameFilter      func(name string) bool
	CoordinatorActiveFn func() bool
	OnLoopComplete      func(conv *conversation.Manager)
	GoalManager         *goal.GoalManager
	ShouldContinueGoal  func() bool
	FileHistory         *file_history.History
	FileStateCache      *tools.FileStateCache
	compactTracking     compact.AutoCompactTrackingState
	RecoveryState       *compact.RecoveryState
	eventCh             chan AgentEvent
	runCtx              context.Context
	skillInitMu         sync.Mutex
	skills              *skillState
	announcedDeferred   []string
	recallInitMu        sync.Mutex
	recall              *recallState
	steeringMu          sync.Mutex
	steeringQueue       []SteeringMessage
	// pendingFollowUps is the depth of the UI follow-up queue, written by the UI
	// goroutine (SetPendingFollowUps) and read by the run loop at goal-continuation
	// boundaries (NoPendingFollowUps). Atomic because the two run concurrently.
	pendingFollowUps int32
}

type SteeringMessage struct {
	Text  string
	Input history.InputEntry
}

func (a *Agent) Steer(text string, input *history.InputEntry) (*history.InputEntry, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	var entry history.InputEntry
	if input != nil {
		entry = *input
	} else {
		var sessionID *string
		if a.SessionID != "" {
			id := a.SessionID
			sessionID = &id
		}
		var err error
		entry, err = history.RecordInput(history.InputOptions{Text: text, Cwd: a.WorkDir, SessionID: sessionID, Source: "sdk"})
		if err != nil {
			return nil, err
		}
	}
	a.steeringMu.Lock()
	a.steeringQueue = append(a.steeringQueue, SteeringMessage{Text: text, Input: entry})
	a.steeringMu.Unlock()
	return &entry, nil
}

func (a *Agent) DrainSteering() []SteeringMessage {
	a.steeringMu.Lock()
	defer a.steeringMu.Unlock()
	messages := a.steeringQueue
	a.steeringQueue = nil
	return messages
}

func (a *Agent) RemoveSteering(inputID string) bool {
	a.steeringMu.Lock()
	defer a.steeringMu.Unlock()
	for i, message := range a.steeringQueue {
		if message.Input.ID == inputID {
			a.steeringQueue = slices.Delete(a.steeringQueue, i, i+1)
			return true
		}
	}
	return false
}

func (a *Agent) hasSteering() bool {
	a.steeringMu.Lock()
	defer a.steeringMu.Unlock()
	return len(a.steeringQueue) > 0
}

// SetPendingFollowUps records how many follow-up messages the UI has queued but
// not yet dispatched. The UI pushes this after every queue mutation so the run
// loop's goal-continuation gate reflects queued input.
func (a *Agent) SetPendingFollowUps(n int) {
	atomic.StoreInt32(&a.pendingFollowUps, int32(n))
}

// NoPendingFollowUps mirrors the reference's `shouldContinueGoal: () =>
// !followUps.hasPending()`: a goal run yields at the next turn boundary when the
// UI has queued a follow-up, so the queued input is dispatched promptly instead
// of waiting for the whole goal to finish.
func (a *Agent) NoPendingFollowUps() bool {
	return atomic.LoadInt32(&a.pendingFollowUps) == 0
}

func (a *Agent) deliverSteering(ctx context.Context, conv *conversation.Manager, ch chan AgentEvent) (int, error) {
	delivered := 0
	for ctx.Err() == nil {
		a.steeringMu.Lock()
		if len(a.steeringQueue) == 0 {
			a.steeringMu.Unlock()
			break
		}
		message := a.steeringQueue[0]
		a.steeringQueue = a.steeringQueue[1:]
		a.steeringMu.Unlock()
		conv.AppendMessages([]conversation.Message{{Role: "user", Content: message.Text, UserInput: &conversation.UserInput{ID: message.Input.ID, Timestamp: message.Input.Timestamp}}})
		if err := a.persistLastMessage(conv); err != nil {
			return delivered, err
		}
		ch <- SteeringDelivered{Text: message.Text, InputID: message.Input.ID}
		delivered++
	}
	return delivered, nil
}

func (a *Agent) CurrentCwd() string {
	if a.Checker != nil {
		if wt := a.Checker.WorktreeSession(); wt != nil {
			return wt.WorktreePath
		}
	}
	return a.WorkDir
}

func (a *Agent) agentName() string {
	if a.AgentName != "" {
		return a.AgentName
	}
	return "main"
}

type RecallResult struct {
	Reminder string
	Paths    []string
}

const maxRecentTools = 10

type recallState struct {
	mu               sync.Mutex
	recentToolNames  []string
	surfacedMemPaths map[string]struct{}
}

func (a *Agent) recallState() *recallState {
	a.recallInitMu.Lock()
	defer a.recallInitMu.Unlock()
	if a.recall == nil {
		a.recall = &recallState{}
	}
	return a.recall
}

func (a *Agent) ShareRecall(parent *Agent) {
	state := parent.recallState()
	a.recallInitMu.Lock()
	a.recall = state
	a.recallInitMu.Unlock()
}

func (a *Agent) RecordRecentTool(name string) {
	if name == "" {
		return
	}
	state := a.recallState()
	state.mu.Lock()
	defer state.mu.Unlock()
	if i := slices.Index(state.recentToolNames, name); i >= 0 {
		state.recentToolNames = slices.Delete(state.recentToolNames, i, i+1)
	}
	state.recentToolNames = append(state.recentToolNames, name)
	if len(state.recentToolNames) > maxRecentTools {
		state.recentToolNames = state.recentToolNames[1:]
	}
}

func (a *Agent) RecallHints() ([]string, map[string]struct{}) {
	state := a.recallState()
	state.mu.Lock()
	defer state.mu.Unlock()
	tools := slices.Clone(state.recentToolNames)
	surfaced := make(map[string]struct{}, len(state.surfacedMemPaths))
	for p := range state.surfacedMemPaths {
		surfaced[p] = struct{}{}
	}
	return tools, surfaced
}

func (a *Agent) ResetRecall() {
	state := a.recallState()
	state.mu.Lock()
	defer state.mu.Unlock()
	state.recentToolNames = nil
	state.surfacedMemPaths = nil
}

func (a *Agent) MarkMemoriesSurfaced(paths []string) {
	if len(paths) == 0 {
		return
	}
	state := a.recallState()
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.surfacedMemPaths == nil {
		state.surfacedMemPaths = make(map[string]struct{}, len(paths))
	}
	for _, p := range paths {
		state.surfacedMemPaths[p] = struct{}{}
	}
}

func (a *Agent) ActivateSkill(name, body string) {
	state := a.skillState()
	state.mu.Lock()
	defer state.mu.Unlock()
	state.values[name] = body
}

func (a *Agent) ClearActiveSkills() {
	state := a.skillState()
	state.mu.Lock()
	defer state.mu.Unlock()
	clear(state.values)
}

func (a *Agent) GetActiveSkills() map[string]string {
	state := a.skillState()
	state.mu.RLock()
	defer state.mu.RUnlock()
	out := make(map[string]string, len(state.values))
	for k, v := range state.values {
		out[k] = v
	}
	return out
}

type skillState struct {
	mu     sync.RWMutex
	values map[string]string
}

func (a *Agent) skillState() *skillState {
	a.skillInitMu.Lock()
	defer a.skillInitMu.Unlock()
	if a.skills == nil {
		a.skills = &skillState{values: map[string]string{}}
	}
	return a.skills
}

func (a *Agent) ShareActiveSkills(parent *Agent) {
	state := parent.skillState()
	a.skillInitMu.Lock()
	a.skills = state
	a.skillInitMu.Unlock()
}

func (a *Agent) SetToolFilter(allow func(name string) bool) {
	a.ToolNameFilter = allow
}

func (a *Agent) ToolRegistry() *tools.Registry {
	return a.Registry
}

func New(client llm.Client, registry *tools.Registry, protocol string) *Agent {
	wd, _ := os.Getwd()
	return &Agent{
		Client:         client,
		Registry:       registry,
		Protocol:       protocol,
		WorkDir:        wd,
		MaxIterations:  0,
		ContextWindow:  200000,
		RecoveryState:  compact.NewRecoveryState(),
		FileStateCache: tools.NewFileStateCache(),
	}
}

func (a *Agent) SetSessionID(id string) { a.SessionID = id }

func (a *Agent) currentToolSchemas() []map[string]any {
	schemas := a.Registry.GetAllSchemas(a.Protocol)
	if a.ToolNameFilter == nil {
		return schemas
	}
	return filterSchemasByName(schemas, a.ToolNameFilter)
}

func (a *Agent) emitHook(event hooks.EventName, message string, args map[string]any) {
	if a.Hooks == nil {
		return
	}
	for _, result := range a.Hooks.Fire(event, hooks.HookContext{
		Event:   event,
		Args:    args,
		Message: message,
	}, hooks.HookRuntimeOptions{Cwd: a.CurrentCwd(), Abort: a.runCtx}) {
		a.Hooks.RecordNotification(result.Output)
	}
}

func filterSchemasByName(schemas []map[string]any, allow func(name string) bool) []map[string]any {
	out := make([]map[string]any, 0, len(schemas))
	for _, s := range schemas {
		name := tools.SchemaName(s)
		if allow(name) {
			out = append(out, s)
		}
	}
	return out
}

type toolExecResult struct {
	toolID        string
	toolName      string
	output        string
	isError       bool
	elapsed       time.Duration
	contentBlocks []map[string]any
	mcpApp        *tools.McpAppResult
}

func extractFilePath(args map[string]any) string {
	for _, key := range []string{"file_path", "path", "pattern", "target"} {
		if v, ok := args[key].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// permissionCall is one entry of the call graph checked before execution:
// the outer tool plus, for McpCall, the routed target.
type permissionCall struct {
	name     string
	category tools.ToolCategory
	args     map[string]any
}

// toolPreparation is the loop-side approval state carried into the executor,
// mirroring the reference's submitted-call context (prepared arguments, the
// hook call graph, and the execution context with the approved mode).
type toolPreparation struct {
	tool      tools.Tool
	arguments map[string]any
	hookCalls []permissionCall
	execution tools.ExecutionContext
}

// prepareToolCall mirrors the reference executeBatch pre-submit pipeline:
// dispatch-level abort check, tool filter, McpCall routing, pre-tool hooks,
// and the permission decision/request all run in the loop, sequentially,
// before anything executes. A non-nil toolExecResult is reported inline and
// never reaches the executor.
func (a *Agent) prepareToolCall(ctx context.Context, eventCh chan AgentEvent, tc toolCallInfo) (*toolPreparation, *toolExecResult) {
	fail := func(output string) *toolExecResult {
		return &toolExecResult{toolID: tc.toolID, toolName: tc.toolName, output: output, isError: true}
	}
	// Once the user interrupts, don't launch the remaining calls; report
	// them as interrupted so every tool_use keeps a paired tool_result.
	if ctx.Err() != nil {
		return nil, fail(tools.CommandInterruptedError)
	}
	if a.ToolNameFilter != nil && !a.ToolNameFilter(tc.toolName) {
		return nil, fail(fmt.Sprintf("Tool '%s' is not available to this agent.", tc.toolName))
	}
	tool := a.Registry.Get(tc.toolName)
	arguments := tc.arguments
	var target tools.Tool
	if router, ok := tool.(*tools.McpCallTool); ok {
		arguments = router.PrepareArguments(arguments)
		if resolved := router.ResolveTarget(arguments); resolved != nil {
			target = resolved
			if a.ToolNameFilter != nil && !a.ToolNameFilter(target.Name()) {
				return nil, fail(fmt.Sprintf("Tool '%s' is not available to this agent.", target.Name()))
			}
		}
	}
	category := tools.CategoryCommand
	if tool != nil {
		category = tool.Category()
	}
	calls := []permissionCall{{name: tc.toolName, category: category, args: arguments}}
	if target != nil {
		inner, _ := arguments["arguments"].(map[string]any)
		calls = append(calls, permissionCall{name: target.Name(), category: target.Category(), args: inner})
	}
	if a.Hooks != nil {
		for _, call := range calls {
			if rejected, reason := a.Hooks.FirePreToolHooks(call.name, call.args, hooks.HookRuntimeOptions{Cwd: a.CurrentCwd(), Abort: ctx}); rejected {
				return nil, fail("Rejected by hook: " + reason)
			}
		}
	}
	if a.Checker != nil {
		decisions := make([]permissions.Decision, len(calls))
		for i, call := range calls {
			decisions[i] = a.Checker.CheckNamed(call.name, call.category, call.args)
		}
		if target != nil && decisions[0].Effect == permissions.Allow && decisions[0].Reason == "Permission rule: allow" && decisions[1].Effect == permissions.Ask && strings.HasPrefix(decisions[1].Reason, "Mode:") {
			decisions[1] = decisions[0]
		}
		decision := decisions[0]
		for _, candidate := range decisions {
			if candidate.Effect == permissions.Ask {
				decision = candidate
				break
			}
		}
		for _, candidate := range decisions {
			if candidate.Effect == permissions.Deny {
				decision = candidate
				break
			}
		}
		if decision.Effect == permissions.Deny {
			return nil, fail(BuildPermissionDeniedOutput(decision.Reason))
		}
		if decision.Effect == permissions.Ask {
			patterns := append([]string{}, a.Checker.RememberPatterns(tc.toolName, tc.arguments)...)
			decision.RememberPatterns = patterns
			// Mirrors requestToolPermission: an abort before or during the
			// request resolves the race as "deny", so the tool result is the
			// plain rejection (the dispatch-level abort check reports the
			// interruption for the remaining calls).
			if ctx.Err() != nil {
				return nil, fail(conversation.RejectedToolResult)
			}
			response := make(chan PermissionReply, 1)
			request := PermissionRequestEvent{Context: ctx, AgentName: a.agentName(), Cwd: a.CurrentCwd(), ToolName: tc.toolName, ToolID: tc.toolID, Args: tc.arguments, Decision: decision, Desc: permissions.DescribeToolAction(tc.toolName, tc.arguments), ResponseCh: response}
			var reply PermissionReply
			select {
			case eventCh <- request:
				select {
				case reply = <-response:
				case <-ctx.Done():
					return nil, fail(conversation.RejectedToolResult)
				}
			case <-ctx.Done():
				return nil, fail(conversation.RejectedToolResult)
			}
			if reply.Response == PermDeny {
				return nil, fail(conversation.RejectedToolResult)
			}
			if reply.Response == PermAllowAlways && len(patterns) == 0 {
				reply.Response = PermAllow
			}
			// Persist exactly the displayed scopes, and only while the run
			// is live (reference: response === "allowAlways" && !aborted).
			if reply.Response == PermAllowAlways && ctx.Err() == nil {
				if err := a.Checker.AllowAlways(tc.toolName, tc.arguments, patterns); err != nil {
					return nil, fail("Permission request failed: " + err.Error() + ". The tool was not executed.")
				}
			}
		}
	}
	approvedMode := permissions.PermissionMode("")
	if a.Checker != nil {
		approvedMode = a.Checker.Mode()
	}

	var planning *tools.PlanContext
	if a.Checker != nil {
		planning = &tools.PlanContext{Owner: a.Checker, IsPlanMode: func() bool { return a.Checker.Mode() == permissions.ModePlan }, EnterPlanMode: func() { a.Checker.EnterPlanMode() }, IsSubagent: a.Checker.IsSubagent(), IsTeammate: a.Checker.Teammate}
	}
	var worktrees tools.WorktreeRuntime
	if a.Checker != nil {
		worktrees = a.Checker
	}
	execution := tools.ExecutionContext{Worktrees: worktrees, Plan: planning, RequestPermission: func(requestCtx context.Context, request tools.PermissionRequest) int {
		response := make(chan PermissionReply, 1)
		agentName := request.AgentName
		if agentName == "" {
			agentName = a.agentName()
		}
		cwd := request.Cwd
		if cwd == "" {
			cwd = a.CurrentCwd()
		}
		select {
		case eventCh <- PermissionRequestEvent{Context: requestCtx, AgentName: agentName, Cwd: cwd, ToolName: request.ToolName, ToolID: request.ToolCallID, Args: request.Args, Desc: request.Desc, Decision: permissions.Decision{RememberPatterns: request.RememberPatterns}, ResponseCh: response}:
		case <-requestCtx.Done():
			return int(PermDeny)
		}
		select {
		case reply := <-response:
			return int(reply.Response)
		case <-requestCtx.Done():
			return int(PermDeny)
		}
	}, IsAgentRuntime: true, FileStateCache: a.FileStateCache, FileHistory: a.FileHistory, WorkDir: a.CurrentCwd(), SessionID: a.SessionID, ToolCallID: tc.toolID, TaskManager: a.TaskManager, DisableBackground: a.DisableBackground, CanReadSearchPath: func(path string) bool { return a.Checker == nil || a.Checker.CanReadSearchPath(path) }, CanTraverseSearchPath: func(path string) bool { return a.Checker == nil || a.Checker.CanTraverseSearchPath(path) }, CheckPermission: func(name string, args map[string]any) *tools.ToolResult {
		if a.Checker == nil {
			return nil
		}
		category := tools.CategoryWrite
		if name == "Bash" || name == "PowerShell" {
			category = tools.CategoryCommand
		}
		decision := a.Checker.CheckNamed(name, category, args)
		if decision.Effect == permissions.Deny || decision.Effect == permissions.Ask && approvedMode != "" && a.Checker.Mode() != approvedMode {
			return &tools.ToolResult{Output: fmt.Sprintf("Permission changed while waiting: %s. Request approval again before retrying.", decision.Reason), IsError: true}
		}
		return nil
	}}
	return &toolPreparation{tool: tool, arguments: arguments, hookCalls: calls, execution: execution}, nil
}

// executePreparedCall mirrors the reference executor's executeCall: parse
// errors, a pre-start abort, and unknown tools are reported without running
// anything; otherwise the approved tool executes under telemetry observation
// and panics become tool errors.
func (a *Agent) executePreparedCall(ctx context.Context, tc toolCallInfo, prep *toolPreparation, agentTelemetry *telemetry.AgentTelemetry) (executionResult toolExecResult) {
	start := time.Now()
	fail := func(output string) toolExecResult {
		return toolExecResult{toolID: tc.toolID, toolName: tc.toolName, output: output, isError: true}
	}
	defer func() {
		if value := recover(); value != nil {
			executionResult = fail(fmt.Sprintf("Error executing %s: %v", tc.toolName, value))
			executionResult.elapsed = time.Since(start)
		}
	}()
	if tc.parseError != "" {
		return fail("Error: " + tc.parseError + ". The tool was not executed.")
	}
	if ctx.Err() != nil {
		return fail(tools.ExecutionCancelledError)
	}
	if prep == nil || prep.tool == nil {
		// On invalid tool name, return a single error and let the model
		// self-correct with another tool; keep the loop running.
		return fail(fmt.Sprintf("Error: unknown tool '%s'", tc.toolName))
	}
	result := telemetry.ObserveToolExecution(tc.toolName, func() tools.ToolResult {
		return prep.tool.Execute(tools.WithExecutionContext(ctx, prep.execution), prep.arguments)
	}, func(r tools.ToolResult) bool { return r.IsError }, agentTelemetry)
	a.RecordRecentTool(tc.toolName)
	return toolExecResult{
		toolID:        tc.toolID,
		toolName:      tc.toolName,
		output:        result.Output,
		isError:       result.IsError,
		elapsed:       time.Since(start),
		contentBlocks: result.ContentBlocks,
		mcpApp:        result.McpApp,
	}
}

// finalizeToolResult mirrors the reference processToolResult: the ReadFile
// recovery snapshot and the post-tool hooks (routed target first, then the
// outer call) run sequentially as each executor result completes.
func (a *Agent) finalizeToolResult(ctx context.Context, tc toolCallInfo, prep *toolPreparation, r toolExecResult) {
	if !r.isError && tc.toolName == "ReadFile" && len(r.contentBlocks) == 0 {
		if path, _ := tc.arguments["file_path"].(string); path != "" {
			a.RecoveryState.RecordFileRead(path, r.output)
		}
	}
	if a.Hooks == nil {
		return
	}
	calls := []permissionCall{{name: tc.toolName, args: tc.arguments}}
	if prep != nil && len(prep.hookCalls) > 0 {
		calls = prep.hookCalls
	}
	for i := len(calls) - 1; i >= 0; i-- {
		call := calls[i]
		for _, hookResult := range a.Hooks.Fire(hooks.EventPostToolUse, hooks.HookContext{Event: hooks.EventPostToolUse, ToolName: call.name, Args: call.args, FilePath: extractFilePath(call.args), Message: r.output}, hooks.HookRuntimeOptions{Cwd: a.CurrentCwd(), Abort: ctx}) {
			a.Hooks.RecordNotification(hookResult.Output)
		}
	}
}

func (a *Agent) persistLastMessage(conv *conversation.Manager) error {
	if a.TranscriptPath == "" && (a.WorkDir == "" || a.SessionID == "") {
		return nil
	}
	msgs := conv.GetMessages()
	if len(msgs) == 0 {
		return nil
	}
	record := session.FromConversation(msgs[len(msgs)-1])
	if a.TranscriptPath != "" {
		return session.SaveTranscriptMessage(a.TranscriptPath, record)
	}
	return session.SaveMessage(a.WorkDir, a.SessionID, record)
}

func (a *Agent) hasToolSchema(schemas []map[string]any, name string) bool {
	for _, schema := range schemas {
		if tools.SchemaName(schema) == name {
			return true
		}
	}
	return false
}
