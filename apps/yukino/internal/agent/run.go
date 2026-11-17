package agent

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/plan_file"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/telemetry"
	"github.com/yukino-js/yukino/yukino/internal/tool_result"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type runState struct {
	maxOutput        int
	escalated        bool
	outputRecoveries int
	transientRetries int
	summarizingGoal  bool
	outcome          string
	telemetry        *telemetry.AgentTelemetry
}

func (a *Agent) restoreContext(conv *conversation.Manager) {
	// The reference joins [skillSection, ...activeSkills].filter(Boolean), so an
	// empty skill section is dropped rather than contributing a blank segment.
	var sections []string
	if a.SkillSection != "" {
		sections = append(sections, a.SkillSection)
	}
	activeSkills := a.GetActiveSkills()
	names := make([]string, 0, len(activeSkills))
	for name := range activeSkills {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		sections = append(sections, "## Active skill: "+name+"\n"+activeSkills[name])
	}
	instructions, memory := a.Instructions, a.MemoryContent
	if a.InstructionsFn != nil {
		instructions = a.InstructionsFn()
	}
	if a.MemoryContentFn != nil {
		memory = a.MemoryContentFn()
	}
	conv.InjectLongTermMemory(instructions, memory, strings.Join(sections, "\n\n"))
}

func (a *Agent) Run(ctx context.Context, conv *conversation.Manager) <-chan AgentEvent {
	ch := make(chan AgentEvent, 32)
	// Store the run context so emitHook can pass it as the hooks' abort signal,
	// mirroring the reference Agent's stored abortSignal.
	a.runCtx = ctx
	go func() {
		agentTelemetry := telemetry.StartAgentTelemetry(a.SessionID, a.Client)
		state := runState{maxOutput: a.MaxOutputTokens, outcome: "interrupted", telemetry: agentTelemetry}
		defer close(ch)
		defer func() {
			outcome := state.outcome
			if ctx.Err() != nil {
				outcome = "interrupted"
			}
			telemetry.EndAgentTelemetry(agentTelemetry, outcome)
		}()
		defer a.emitHook(hooks.EventSessionEnd, "", nil)
		if a.GoalManager != nil {
			defer a.GoalManager.EndRun()
		}
		a.restoreContext(conv)
		if a.FileHistory != nil {
			label := "Before agent run"
			messages := conv.GetMessages()
			for i := len(messages) - 1; i >= 0; i-- {
				if messages[i].Role == "user" {
					if messages[i].ContentBlocks == nil {
						label = messages[i].Content
					}
					break
				}
			}
			a.FileHistory.MakeSnapshot(conv.Len(), label, a.sessionLineCount())
		}
		if a.GoalManager != nil {
			a.GoalManager.BeginTurn()
		}
		a.emitHook(hooks.EventSessionStart, "", nil)
		if state.maxOutput <= 0 {
			state.maxOutput = config.DefaultMaxOutputTokens
		}
		for iteration := 1; ; iteration++ {
			if ctx.Err() != nil {
				ch <- LoopComplete{TotalTurns: iteration - 1, StopReason: "interrupted"}
				return
			}
			if a.GoalManager != nil {
				g := a.GoalManager.Get()
				if state.summarizingGoal || (g != nil && g.Status == "budget_limited") {
					canSummarize := !state.summarizingGoal &&
						(a.Checker == nil || a.Checker.Mode() != permissions.ModePlan) &&
						(a.ShouldContinueGoal == nil || a.ShouldContinueGoal()) &&
						!a.hasSteering() &&
						g != nil && g.BudgetSummaryPending
					if !canSummarize {
						ch <- StreamText{Text: "\n" + a.GoalManager.Format() + "\n"}
						ch <- LoopComplete{TotalTurns: iteration - 1, StopReason: "budget_limited"}
						state.outcome = "completed"
						return
					}
					state.summarizingGoal = true
				}
			}
			if !state.summarizingGoal && a.MaxIterations > 0 && iteration > a.MaxIterations {
				state.outcome = "error"
				ch <- ErrorEvent{Message: fmt.Sprintf("Agent reached maximum iterations (%d)", a.MaxIterations)}
				return
			}
			if !a.runTurn(ctx, ch, conv, iteration, &state) {
				return
			}
		}
	}()
	return ch
}

// sessionFilePath mirrors this.sessionFilePath in the reference.
func (a *Agent) sessionFilePath() string {
	if a.TranscriptPath != "" {
		return a.TranscriptPath
	}
	if a.WorkDir == "" || a.SessionID == "" {
		return ""
	}
	return session.SessionFilePath(a.WorkDir, a.SessionID)
}

// sessionLineCount returns the session-log line coordinate for snapshots,
// mirroring sessionLineCount(this.sessionFilePath) in the reference.
func (a *Agent) sessionLineCount() *int {
	path := a.sessionFilePath()
	if path == "" {
		return nil
	}
	count, exists, err := session.SessionLineCount(path)
	if err != nil || !exists {
		return nil
	}
	return &count
}

// persistLast persists the last conversation message; on failure it records the
// error outcome, emits an ErrorEvent, and reports false so the caller stops the
// turn. This mirrors the reference, where a persistence error propagates and
// fails the run instead of being silently dropped.
func (a *Agent) persistLast(ch chan AgentEvent, conv *conversation.Manager, state *runState) bool {
	if err := a.persistLastMessage(conv); err != nil {
		state.outcome = "error"
		ch <- ErrorEvent{Message: err.Error()}
		return false
	}
	return true
}

func (a *Agent) runTurn(ctx context.Context, ch chan AgentEvent, conv *conversation.Manager, iteration int, state *runState) bool {
	var schemas []map[string]any
	if !state.summarizingGoal {
		schemas = a.currentToolSchemas()
	}
	names := make([]string, 0, len(schemas))
	for _, schema := range schemas {
		if name := tools.SchemaName(schema); name != "" {
			names = append(names, name)
		}
	}
	coordinating := a.CoordinatorActiveFn != nil && a.CoordinatorActiveFn()
	guidance := prompt.BuildToolGuidance(names, coordinating)
	if guidance == "" && conv.HasReminderContaining(prompt.ToolGuidanceMarker) {
		guidance = prompt.ToolGuidanceMarker + "\n" + NoCallableToolsReminder
	}
	if guidance != "" {
		conv.AddSystemReminderIfChanged(prompt.ToolGuidanceMarker, guidance)
	}
	if a.Checker != nil {
		wt := a.Checker.WorktreeSession()
		if wt != nil || conv.HasReminderContaining(WorkingDirectoryMarker) {
			branch := ""
			if wt != nil {
				branch = wt.WorktreeBranch
			}
			cwd := a.CurrentCwd()
			conv.AddSystemReminderIfChanged(WorkingDirectoryMarker, BuildWorkingDirectoryReminder(cwd, branch, memory.LoadInstructions(cwd)))
		}
	}
	goalReminder := ""
	if a.GoalManager != nil {
		goalReminder = a.GoalManager.Reminder()
	}
	if goalReminder == "" && conv.HasReminderContaining(goal.PersistentGoalMarker) {
		goalReminder = NoPersistentGoalReminder
	}
	if goalReminder != "" {
		conv.AddSystemReminderIfChanged(goal.PersistentGoalMarker, goalReminder)
	}
	if a.Checker != nil && a.Checker.Mode() == permissions.ModePlan {
		path, err := plan_file.GetOrCreatePlanPath(a.Checker)
		if err != nil {
			ch <- ErrorEvent{Message: err.Error()}
			return false
		}
		conv.AddSystemReminder(prompt.BuildPlanModeReminder(path, plan_file.PlanExists(a.Checker), iteration, prompt.PlanCapabilities{
			CanAskUser: a.hasToolSchema(schemas, "AskUserQuestion"), CanExitPlanMode: a.hasToolSchema(schemas, "ExitPlanMode"), CanSendMessage: a.hasToolSchema(schemas, "SendMessage"), CanWriteFile: a.hasToolSchema(schemas, "WriteFile"), CanEditFile: a.hasToolSchema(schemas, "EditFile"), CanDelegate: a.hasToolSchema(schemas, "Agent"), IsCoordinator: coordinating, IsSubagent: a.Checker.IsSubagent(), IsTeammate: a.Checker.Teammate, ReadOnly: a.Checker.ReadOnly, RequiresLeaderPlanApproval: a.Checker.RequiresLeaderPlanApproval,
		}))
	}
	if coordinating {
		conv.AddSystemReminder(prompt.CoordinatorReminder(iteration))
	}
	var deferred []string
	if !state.summarizingGoal {
		for _, name := range a.Registry.GetDeferredToolNames() {
			if a.ToolNameFilter == nil || a.ToolNameFilter(name) {
				deferred = append(deferred, name)
			}
		}
	}
	deferredGuidance := prompt.BuildDeferredToolGuidance(deferred, names, a.Registry.McpLoadingMode == tools.McpLoadingDispatch)
	if deferredGuidance == "" && conv.HasReminderContaining(prompt.DeferredGuidanceMarker) {
		deferredGuidance = prompt.DeferredGuidanceMarker + "\n" + NoDeferredToolsReminder
	}
	if deferredGuidance != "" {
		conv.AddSystemReminderIfChanged(prompt.DeferredGuidanceMarker, deferredGuidance)
	}
	drainHooks := func() bool {
		if a.Hooks != nil {
			for _, note := range a.Hooks.DrainNotifications() {
				conv.AddSystemReminder(note)
				if !a.persistLast(ch, conv, state) {
					return false
				}
			}
		}
		return true
	}
	if !drainHooks() {
		return false
	}
	if a.NotificationFn != nil {
		notes, err := a.NotificationFn()
		if err != nil {
			// The reference lets a notification-drain failure (e.g. task
			// persistence) abort the run.
			return false
		}
		for _, note := range notes {
			conv.AddSystemReminder(note)
			if !a.persistLast(ch, conv, state) {
				return false
			}
		}
	}
	if a.SkillDeltaFn != nil {
		if delta := a.SkillDeltaFn(); delta != "" {
			conv.AddSystemReminder(NewSkillsReminderPrefix + delta)
		}
	}
	a.emitHook(hooks.EventTurnStart, "", nil)
	defer a.emitHook(hooks.EventTurnEnd, "", nil)
	a.emitHook(hooks.EventPreSend, "", nil)
	if !drainHooks() {
		return false
	}
	if !state.summarizingGoal {
		mc, err := compact.ManageContext(ctx, conv, a.Client, a.ContextWindow, state.maxOutput, &a.compactTracking, a.RecoveryState, names, schemas, a.sessionFilePath())
		if err != nil {
			ch <- ErrorEvent{Message: err.Error()}
			return false
		}
		if mc.Message != "" {
			if mc.Boundary != nil {
				if path := a.sessionFilePath(); path != "" {
					_ = session.SaveTranscriptCompactBoundary(path, mc.Boundary.Summary, mc.Boundary.Keep)
				}
			}
			ch <- CompactEvent{Message: mc.Message, Boundary: mc.Boundary}
		}
		if mc.Compacted {
			a.restoreContext(conv)
			if guidance != "" {
				conv.AddSystemReminderIfChanged(prompt.ToolGuidanceMarker, guidance)
			}
			if deferredGuidance != "" {
				conv.AddSystemReminderIfChanged(prompt.DeferredGuidanceMarker, deferredGuidance)
			}
		}
	}
	if ctx.Err() != nil {
		ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
		return false
	}
	if state.summarizingGoal {
		summary := ""
		if (a.Checker == nil || a.Checker.Mode() != permissions.ModePlan) && (a.ShouldContinueGoal == nil || a.ShouldContinueGoal()) && !a.hasSteering() {
			summary = a.GoalManager.TakeBudgetSummary()
		}
		if summary == "" {
			ch <- LoopComplete{TotalTurns: iteration, StopReason: "budget_limited"}
			state.outcome = "completed"
			return false
		}
		conv.AddUserMessage(summary)
		if !a.persistLast(ch, conv, state) {
			return false
		}
	}
	streamCtx := ctx
	if state.escalated || a.MaxOutputTokens > 0 {
		streamCtx = llm.WithMaxOutputTokens(ctx, state.maxOutput)
	}
	if state.summarizingGoal {
		// Goal-summarizing turns skip provider retries (reference passes
		// maxRetries: 0) so a budget-limited summary is not delayed by backoff.
		streamCtx = llm.WithMaxRetries(streamCtx, 0)
	}
	events, errs := a.Client.Stream(streamCtx, conv, schemas)
	events, errs = telemetry.ObserveLlmStream(a.Client, events, errs, state.telemetry)
	var text strings.Builder
	var calls []llm.ToolCallComplete
	var thinking []conversation.ThinkingBlock
	var usage llm.UsageInfo
	var streamErr error
	receivedEnd, receivedThinking := false, false
	stopReason := "end_turn"
	for events != nil || errs != nil {
		select {
		case event, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			if ctx.Err() != nil {
				continue
			}
			switch e := event.(type) {
			case llm.TextDelta:
				text.WriteString(e.Text)
				ch <- StreamText{Text: e.Text}
			case llm.ThinkingDelta:
				receivedThinking = true
				ch <- ThinkingText{Text: e.Text}
			case llm.ThinkingComplete:
				thinking = append(thinking, conversation.ThinkingBlock{Type: "thinking", Thinking: e.Thinking, Signature: e.Signature})
				ch <- ThinkingComplete{Thinking: e.Thinking, Signature: e.Signature}
			case llm.RedactedThinkingComplete:
				thinking = append(thinking, conversation.ThinkingBlock{Type: "redacted_thinking", Data: e.Data})
			case llm.ToolCallComplete:
				calls = append(calls, e)
				ch <- ToolUseEvent{ToolID: e.ToolID, ToolName: e.ToolName, Args: e.Arguments}
			case llm.StreamEnd:
				receivedEnd = true
				stopReason = e.StopReason
				usage = e.Usage
				if a.GoalManager != nil {
					a.GoalManager.AddTokens(float64(usage.InputTokens + usage.OutputTokens + usage.CacheReadTokens + usage.CacheCreationTokens))
				}
				ch <- UsageEvent{InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens, CacheReadTokens: usage.CacheReadTokens, CacheCreationTokens: usage.CacheCreationTokens}
			}
		case err, ok := <-errs:
			if !ok {
				errs = nil
			} else if err != nil {
				streamErr = err
			}
		}
	}
	persistPartial := func() bool {
		if text.Len() > 0 || len(thinking) > 0 {
			conv.AddAssistantFull(text.String(), thinking, nil)
			return a.persistLast(ch, conv, state)
		}
		return true
	}
	if ctx.Err() != nil {
		if !persistPartial() {
			return false
		}
		ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
		return false
	}
	if streamErr == nil && !receivedEnd {
		streamErr = &llm.LLMError{Message: "Provider stream ended without a completion event"}
	}
	if streamErr != nil {
		var tooLong *llm.ContextTooLongError
		if errors.As(streamErr, &tooLong) {
			result, err := compact.ForceCompact(ctx, conv, a.Client, a.RecoveryState, names, schemas, a.sessionFilePath(), "")
			if err != nil || !result.Compacted {
				if !persistPartial() {
					return false
				}
				state.outcome = "error"
				ch <- ErrorEvent{Message: streamErr.Error()}
				return false
			}
			conv.ClearUsageAnchor()
			a.restoreContext(conv)
			if result.Boundary != nil {
				if path := a.sessionFilePath(); path != "" {
					_ = session.SaveTranscriptCompactBoundary(path, result.Boundary.Summary, result.Boundary.Keep)
				}
			}
			ch <- CompactEvent{Message: "Auto-compacted due to context length: " + result.Message, Boundary: result.Boundary}
			return true
		}
		if delay, retry := llm.LLMRetryDelay(streamErr, state.transientRetries); retry && !state.summarizingGoal && text.Len() == 0 && !receivedThinking && len(thinking) == 0 && len(calls) == 0 {
			state.transientRetries++
			reason := "temporary provider failure"
			var rate *llm.RateLimitError
			if errors.As(streamErr, &rate) {
				reason = "rate limited"
			}
			ch <- RetryEvent{Reason: reason, Wait: delay}
			timer := time.NewTimer(delay)
			defer timer.Stop()
			select {
			case <-timer.C:
				return true
			case <-ctx.Done():
				ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
				return false
			}
		}
		if !persistPartial() {
			return false
		}
		state.outcome = "error"
		ch <- ErrorEvent{Message: streamErr.Error()}
		return false
	}
	state.transientRetries = 0
	a.emitHook(hooks.EventPostReceive, text.String(), nil)
	anchor := func() {
		conv.RecordUsageAnchor(usage.InputTokens, usage.OutputTokens, usage.CacheReadTokens, usage.CacheCreationTokens)
	}
	budgetLimited := false
	if a.GoalManager != nil {
		if g := a.GoalManager.Get(); g != nil && g.Status == "budget_limited" {
			budgetLimited = true
		}
	}
	if stopReason == "max_tokens" && len(calls) == 0 && !state.summarizingGoal && !budgetLimited {
		ceiling := min(maxTokensCeiling, a.ContextWindow)
		recovery := ""
		reason := ""
		if !state.escalated && state.maxOutput < ceiling {
			state.maxOutput = ceiling
			state.escalated = true
			recovery = MaxTokensResumePrompt
			reason = "max_tokens escalation"
		} else if state.outputRecoveries < maxOutputTokensRecoveries {
			state.outputRecoveries++
			recovery = MaxTokensRecoveryPrompt
			reason = fmt.Sprintf("max_tokens recovery %d/%d", state.outputRecoveries, maxOutputTokensRecoveries)
		}
		if recovery != "" {
			if text.Len() > 0 || len(thinking) > 0 {
				if !persistPartial() {
					return false
				}
				anchor()
				conv.AddUserMessage(recovery)
				if !a.persistLast(ch, conv, state) {
					return false
				}
			}
			ch <- RetryEvent{Reason: reason}
			return true
		}
	} else {
		state.outputRecoveries = 0
	}
	executor := NewStreamingExecutor(a.Registry, ch, state.telemetry)
	var uses []conversation.ToolUseBlock
	for _, call := range calls {
		if stopReason == "max_tokens" {
			call.ParseError = MaxTokensTruncatedArgsNotice
		}
		if state.summarizingGoal || budgetLimited {
			call.ParseError = GoalBudgetLimitedNotice
		}
		uses = append(uses, conversation.ToolUseBlock{ToolUseID: call.ToolID, ToolName: call.ToolName, Arguments: call.Arguments, ParseError: call.ParseError, ProviderItemID: call.ProviderItemID})
		executor.Submit(toolCallInfo{toolID: call.ToolID, toolName: call.ToolName, arguments: call.Arguments, parseError: call.ParseError})
	}
	if text.Len() > 0 || len(thinking) > 0 || len(uses) > 0 {
		conv.AddAssistantFull(text.String(), thinking, uses)
		if !a.persistLast(ch, conv, state) {
			return false
		}
	}
	anchor()
	if len(calls) == 0 {
		ch <- TurnComplete{Turn: iteration}
		// A budget-limited summary turn yields control back to the loop-top budget
		// check, which stops the run with the budget_limited reason.
		if state.summarizingGoal || budgetLimited {
			return true
		}
		if ctx.Err() != nil {
			ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
			return false
		}
		if a.hasSteering() {
			delivered, err := a.deliverSteering(ctx, conv, ch)
			if err != nil {
				state.outcome = "error"
				ch <- ErrorEvent{Message: err.Error()}
				return false
			}
			if delivered > 0 || ctx.Err() != nil {
				return true
			}
		}
		if (stopReason == "end_turn" || stopReason == "stop") && a.GoalManager != nil &&
			(a.Checker == nil || a.Checker.Mode() != permissions.ModePlan) &&
			(a.ShouldContinueGoal == nil || a.ShouldContinueGoal()) {
			if contPrompt := a.GoalManager.Continuation(); contPrompt != "" {
				if a.FileHistory != nil {
					summary := []rune(text.String())
					if len(summary) > 60 {
						summary = summary[:60]
					}
					a.FileHistory.MakeSnapshot(conv.Len(), string(summary), a.sessionLineCount())
				}
				conv.AddUserMessage(contPrompt)
				if !a.persistLast(ch, conv, state) {
					return false
				}
				a.GoalManager.BeginTurn()
				return true
			}
		}
		if a.FileHistory != nil {
			summary := []rune(text.String())
			if len(summary) > 60 {
				summary = append(summary[:60], []rune("...")...)
			}
			a.FileHistory.MakeSnapshot(conv.Len(), string(summary), a.sessionLineCount())
		}
		state.outcome = "completed"
		ch <- LoopComplete{TotalTurns: iteration, StopReason: stopReason}
		if a.OnLoopComplete != nil {
			go func() { defer func() { _ = recover() }(); a.OnLoopComplete(conv) }()
		}
		return false
	}
	results := executor.ExecuteAll(ctx, a)
	artifactSessionID := a.toolResultSessionID(conv)
	exempt := map[string]bool{}
	for _, call := range calls {
		if tool_result.IsSpillReadback(call.ToolName, call.Arguments, a.CurrentCwd(), artifactSessionID) {
			exempt[call.ToolID] = true
		}
	}
	var toolResults []conversation.ToolResultBlock
	planReady := false
	for _, result := range results {
		record := conversation.ToolResultBlock{ToolUseID: result.toolID, Content: result.output, IsError: result.isError, ContentBlocks: result.contentBlocks}
		if utf8.RuneCountInString(record.Content) > tools.MaxOutputChars && !exempt[result.toolID] {
			replacement := tool_result.PersistLargeResult(artifactSessionID, result.toolID, record.Content)
			if replacement != record.Content {
				tool_result.ReplaceToolResultContent(&record, replacement)
			}
			exempt[result.toolID] = true
		}
		toolResults = append(toolResults, record)
		if !result.isError && (result.toolName == "EnterPlanMode" || result.toolName == "ExitPlanMode") {
			planReady = true
		}
	}
	tool_result.ApplyBudget(toolResults, artifactSessionID, exempt)
	conv.AddToolResultsMessage(toolResults)
	if !a.persistLast(ch, conv, state) {
		return false
	}
	ch <- TurnComplete{Turn: iteration}
	if ctx.Err() != nil {
		ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
		return false
	}
	if state.summarizingGoal || budgetLimited {
		return true
	}
	if a.MemoryRecallCh != nil {
		select {
		case recall := <-a.MemoryRecallCh:
			if recall.Reminder != "" {
				conv.AddSystemReminder(recall.Reminder)
				a.MarkMemoriesSurfaced(recall.Paths)
			}
			a.MemoryRecallCh = nil
		default:
		}
	}
	if planReady {
		state.outcome = "completed"
		ch <- LoopComplete{TotalTurns: iteration, PlanReady: true, StopReason: "end_turn"}
		return false
	}
	if _, err := a.deliverSteering(ctx, conv, ch); err != nil {
		state.outcome = "error"
		ch <- ErrorEvent{Message: err.Error()}
		return false
	}
	return true
}
