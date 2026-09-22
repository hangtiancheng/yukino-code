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

package agent

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/compact"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/file_history"
	"github.com/hangtiancheng/yukino-code/yukino/hooks"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/permissions"
	"github.com/hangtiancheng/yukino-code/yukino/plan_file"
	"github.com/hangtiancheng/yukino-code/yukino/prompt"
	"github.com/hangtiancheng/yukino-code/yukino/session"
	"github.com/hangtiancheng/yukino-code/yukino/telemetry"
	"github.com/hangtiancheng/yukino-code/yukino/tool_result"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

const (
	maxTokensCeiling          = 64000
	maxOutputTokensRecoveries = 3
	// maxRateLimitRetries bounds consecutive 429 retries before the agent gives
	// up (TS MAX_RATE_LIMIT_RETRIES); maxRetryDelay caps a parsed Retry-After
	// (TS MAX_RETRY_DELAY_MS = 60s).
	maxRateLimitRetries = 3
	maxRetryDelay       = 60 * time.Second
)

type Agent struct {
	Client        llm.Client
	Registry      *tools.Registry
	Protocol      string
	WorkDir       string
	MaxIterations int
	ContextWindow int
	// MaxOutputTokens is the model's max output budget; used by Layer 2 to
	// compute the effective window for the compaction threshold. Zero falls
	// back to the summaryOutputReserve default inside compact.
	MaxOutputTokens int
	Checker         *permissions.Checker
	Hooks           *hooks.Engine
	// SessionID identifies the on-disk session log this agent appends to. When
	// set, Layer 2 compaction writes a compact_boundary record into that session
	// so a later resume can rebuild the compacted state instead of replaying the
	// full pre-compaction transcript. Empty disables boundary persistence (tests,
	// one-shot callers).
	SessionID      string
	NotificationFn func() []string
	// BackgroundTaskManager, when non-nil, is the per-run background shell
	// manager carried into every tool execution context (TS: Agent
	// config.taskManager → ctx.taskManager). Subagent runs create their own so
	// backgrounded shells notify and settle with this loop, not the host's.
	BackgroundTaskManager tools.BackgroundTaskManager
	// BackgroundTasksDisabled injects an explicit nil manager into the tool
	// context, blocking the tools' fallback to their host-wired instance
	// manager (TS: backgroundTasks:false for in-process teammate turns).
	BackgroundTasksDisabled bool
	// activeTelemetry is the agent-run telemetry handle for the current Run
	// (nil under the noop runtime). executeSingleTool reads it to wrap tool
	// executions in yukino.tool.execute observations (TS: the run-local
	// telemetry handle is in scope where observeToolExecution is called).
	activeTelemetry *telemetry.AgentTelemetry
	// ToolNameFilter, when non-nil, drops any tool whose Name returns false from the schemas sent to
	// the LLM. The filter is consulted at the top of every iteration so callers can flip Coordinator
	// Mode on or off (e.g., when a team is created/torn down) without restarting the agent.
	Instructions  string
	MemoryContent string
	// SkillSection is the listing text of available skills. It is project-scoped,
	// so it goes into the first system-reminder alongside instructions and memory
	// rather than the system prompt.
	SkillSection string
	// SkillDeltaFn returns the listing of skills newly appeared since the last call
	// (previously announced ones are omitted). When skills are installed mid-session,
	// only the new entries are appended — the full listing is not resent and the
	// system prompt is left untouched.
	SkillDeltaFn func() string
	// MemoryRecallCh is a non-blocking memory recall channel: prefetch runs in
	// parallel with the main LLM call; the result is read and injected after
	// tool execution completes.
	MemoryRecallCh <-chan RecallResult
	ToolNameFilter func(name string) bool
	// CoordinatorActiveFn, when non-nil, reports whether Coordinator Mode is currently in effect.
	// Consulted every iteration alongside ToolNameFilter so the scheduling guidance appears exactly
	// when the tool set is narrowed, and disappears once the team is torn down.
	CoordinatorActiveFn func() bool
	// OnLoopComplete, when non-nil, is invoked fire-and-forget after the agent reaches LoopComplete
	// (final assistant message, no tool calls remaining). Used by ch09 background memory extraction.
	// Replaces the original stopHooks dispatcher; failures are silent and must not block the main
	// loop. The callback receives the live conversation — do not mutate it from another goroutine.
	OnLoopComplete func(conv *conversation.Manager)
	FileHistory    *file_history.History
	// FileStateCache is the read-before-edit gate carried into every tool
	// execution context (TS: AgentConfig.fileStateCache → ctx.fileStateCache).
	// The host wires the registry-shared cache; subagent runs set a fresh one
	// per run (TS spawn.ts), and nil disables the gate for the run.
	FileStateCache *tools.FileStateCache
	// OnPermissionRequest answers ask decisions synchronously instead of
	// emitting PermissionRequestEvent (TS: AgentConfig.onPermissionRequest /
	// PermissionRequestHandler). Subagent loops inherit the parent's handler
	// through the tool context; the host-driven main loop leaves it nil and
	// uses the event channel. A failing handler — a returned error or a
	// panic, which is recovered so a misbehaving callback cannot take down
	// the shared server — is reported to the model as
	// `Permission request failed: <msg>. The tool was not executed.` (TS: the
	// catch around the awaited callback).
	OnPermissionRequest permissions.RequestHandler
	// PermissionsHeadless marks a loop with no approval path at all (TS:
	// onPermissionRequest undefined): an ask decision settles immediately with
	// the TS no-handler message instead of prompting anyone. Teammate turns and
	// parentless subagent runs use it.
	PermissionsHeadless bool
	compactTracking     compact.AutoCompactTrackingState
	// RecoveryState holds the snapshots needed to rebuild working context
	// after Layer 2 collapses the conversation into a summary: most-recent
	// file reads and skill invocations. The struct is concurrency-safe so
	// the streaming executor can write to it from multiple goroutines.
	RecoveryState *compact.RecoveryState
	// activeSkills tracks which Skill SOPs have been activated in this session,
	// in activation order (TS: a Map — iteration order is insertion order, and
	// re-activating an existing skill keeps its position while updating the
	// body). Used by /skills to show what's active and by restoreContext to
	// re-inject SOPs after compaction.
	activeSkillOrder []string
	activeSkills     map[string]string
	// announcedDeferred is the deferred tool list last announced to the model, in lexicographic
	// order. Comparing it with the current list tells us whether the pool changed; if not,
	// the reminder is not re-sent.
	announcedDeferred []string
	// recallMu guards the two fields below: tool execution writes from multiple
	// goroutines, while memory recall prefetch reads and writes from its own.
	recallMu sync.Mutex
	// recentToolNames holds recently invoked tool names, deduplicated in call order.
	// Passed to the memory recall selector so it skips usage-guide memories for
	// these tools, while still surfacing pitfall and warning memories.
	recentToolNames []string
	// surfacedMemPaths records memory file paths already injected this session;
	// pre-filtered before recall to avoid the same memory occupying a selector
	// slot every turn.
	surfacedMemPaths map[string]struct{}
}

// RecallResult holds the output of a single memory recall pass: the rendered
// system-reminder body and the selected memory file paths. Paths are only
// marked as surfaced once the reminder is actually injected into the conversation.
type RecallResult struct {
	Reminder string
	Paths    []string
}

// maxRecentTools is the upper bound on recent tool names passed to the memory recall selector.
const maxRecentTools = 10

// RecordRecentTool records a just-executed tool name. Re-invoking the same
// tool moves it to the tail, so the list reflects most-recent-use order rather
// than first-use order.
func (a *Agent) RecordRecentTool(name string) {
	if name == "" {
		return
	}
	a.recallMu.Lock()
	defer a.recallMu.Unlock()
	if i := slices.Index(a.recentToolNames, name); i >= 0 {
		a.recentToolNames = slices.Delete(a.recentToolNames, i, i+1)
	}
	a.recentToolNames = append(a.recentToolNames, name)
	if len(a.recentToolNames) > maxRecentTools {
		a.recentToolNames = a.recentToolNames[1:]
	}
}

// RecallHints returns snapshots of the two pieces of state used by memory
// recall: recently used tool names, and memory paths already injected this
// session. The returned values are copies, safe for use in any goroutine.
func (a *Agent) RecallHints() ([]string, map[string]struct{}) {
	a.recallMu.Lock()
	defer a.recallMu.Unlock()
	tools := slices.Clone(a.recentToolNames)
	surfaced := make(map[string]struct{}, len(a.surfacedMemPaths))
	for p := range a.surfacedMemPaths {
		surfaced[p] = struct{}{}
	}
	return tools, surfaced
}

// MarkMemoriesSurfaced records which memories were injected this turn so the
// next recall excludes them first.
func (a *Agent) MarkMemoriesSurfaced(paths []string) {
	if len(paths) == 0 {
		return
	}
	a.recallMu.Lock()
	defer a.recallMu.Unlock()
	if a.surfacedMemPaths == nil {
		a.surfacedMemPaths = make(map[string]struct{}, len(paths))
	}
	for _, p := range paths {
		a.surfacedMemPaths[p] = struct{}{}
	}
}

// deferredReminderMarker is the fixed prefix of the deferred-tool reminder. It is used to check
// whether the reminder still exists in history: after compaction collapses history into a summary
// the original message is gone and must be re-sent.
const deferredReminderMarker = "The following deferred tools are available via ToolSearch."

// ActivateSkill records a skill activation. The body is kept for /skills listing and compaction
// recovery, but is NOT re-injected every turn — it lives in the conversation as a regular message.
// Re-activating an existing skill updates its body while keeping its original
// position in the injection order (TS: Map.set on an existing key).
func (a *Agent) ActivateSkill(name, body string) {
	if a.activeSkills == nil {
		a.activeSkills = make(map[string]string)
	}
	if _, exists := a.activeSkills[name]; !exists {
		a.activeSkillOrder = append(a.activeSkillOrder, name)
	}
	a.activeSkills[name] = body
}

// ClearActiveSkills drops every pinned SOP. Called by /clear so a fresh conversation doesn't carry
// over SOPs from a prior task. Safe to call when no skills were ever activated.
func (a *Agent) ClearActiveSkills() {
	a.activeSkills = nil
	a.activeSkillOrder = nil
}

// GetActiveSkills returns a copy of the currently-pinned SOPs (name → body). Used by tests and by
// /skills to surface what's active.
func (a *Agent) GetActiveSkills() map[string]string {
	out := make(map[string]string, len(a.activeSkills))
	maps.Copy(out, a.activeSkills)
	return out
}

// combinedSkillSection builds the skill text injected as long-term memory: the
// listing plus every active skill's SOP body in activation order (TS
// restoreContext: [skillSection, ...activeSkills].filter(Boolean).join("\n\n")).
// Without this, a compaction that collapses the conversation would drop the
// active SOPs the model is still relying on.
func (a *Agent) combinedSkillSection() string {
	parts := make([]string, 0, len(a.activeSkills)+1)
	if a.SkillSection != "" {
		parts = append(parts, a.SkillSection)
	}
	for _, name := range a.activeSkillOrder {
		// TS filter(Boolean) only drops the empty skillSection — an entry with
		// an empty body still renders its header.
		parts = append(parts, "## Active skill: "+name+"\n"+a.activeSkills[name])
	}
	return strings.Join(parts, "\n\n")
}

// restoreContext re-injects the long-term memory block (instructions,
// memories, active skills) — at loop start and after a compaction wiped it
// (TS: restoreContext).
func (a *Agent) restoreContext(conv *conversation.Manager) {
	conv.InjectLongTermMemory(a.Instructions, a.MemoryContent, a.combinedSkillSection())
}

// SetToolFilter installs a tool visibility filter for the current conversation. The filter is
// consulted at the top of every iteration so callers can flip Coordinator mode on or off without
// restarting the agent. Passing nil clears any previous filter.
func (a *Agent) SetToolFilter(allow func(name string) bool) {
	a.ToolNameFilter = allow
}

// ToolRegistry returns the live tool registry. Named ToolRegistry (not just Registry, even though
// that would match the field name) to avoid the method/field collision Go disallows. Matches the
// skills.SkillHost contract.
func (a *Agent) ToolRegistry() *tools.Registry {
	return a.Registry
}

func New(client llm.Client, registry *tools.Registry, protocol string) *Agent {
	wd, _ := os.Getwd()
	return &Agent{
		Client:        client,
		Registry:      registry,
		Protocol:      protocol,
		WorkDir:       wd,
		MaxIterations: 0,
		// TS getContextWindow defaults to 1_000_000 (config/index.ts). The Go
		// default matches so auto-compaction triggers at the same ratio; hosts
		// that infer a smaller window from config/model override this.
		ContextWindow: 1000000,
		// TS constructor: maxOutput = config.maxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS
		// (128_000). Without this default the max_tokens escalation gate
		// (maxOutput < 64000) would always pass on a zero value, where TS with
		// the default never escalates.
		MaxOutputTokens: 128000,
		RecoveryState:   compact.NewRecoveryState(),
	}
}

// SetSessionID wires the on-disk session log id onto the agent so Layer 2
// compaction can persist a compact_boundary record into the same session the TUI
// is appending plain messages to. Called from the TUI right after the agent is
// constructed (and again after a resume switches sessions).
func (a *Agent) SetSessionID(id string) { a.SessionID = id }

// currentToolSchemas builds the schema list the next API call will use,
// honouring any active ToolNameFilter (e.g. Teams coordinator mode).
// Shared between the recovery attachment (which lists what's still
// available after compact) and the actual Stream call so both views
// stay consistent.
// currentToolSchemas returns the schemas actually sent on this turn, after
// the per-turn tool filter. The recovery attachment uses registryToolNames
// instead, because it must advertise every registered capability regardless
// of the active filter.
func (a *Agent) currentToolSchemas() []map[string]any {
	schemas := a.Registry.GetAllSchemas(a.Protocol)
	if a.ToolNameFilter == nil {
		return schemas
	}
	// The filter is the sole authority; no exception branches are retained.
	return filterSchemasByName(schemas, a.ToolNameFilter)
}

// registryToolNames lists every registered tool name, unfiltered (TS:
// registry.listTools().map(t => t.name)). Used by the compact recovery
// attachment.
func (a *Agent) registryToolNames() []string {
	if a.Registry == nil {
		return nil
	}
	toolList := a.Registry.ListTools()
	names := make([]string, 0, len(toolList))
	for _, tool := range toolList {
		names = append(names, tool.Name())
	}
	return names
}

// turnSignal is the control-flow result of one turn's body, run inside a
// closure so a deferred turn_end hook fires on every exit path (TS fires
// turn_end in an inner finally).
type turnSignal int

const (
	// turnNext advances to the next iteration (normal end or a retry/continue).
	turnNext turnSignal = iota
	// turnReturn exits the Run loop.
	turnReturn
)

func (a *Agent) Run(ctx context.Context, conv *conversation.Manager) <-chan AgentEvent {
	ch := make(chan AgentEvent, 32)

	go func() {
		defer close(ch)

		// Telemetry mirrors the TS agent (index.ts:248, 774-782): the agent-run
		// observation opens before session_start and ends after the session_end
		// hook on every exit path (LIFO defer order). agentTelemetry is nil when
		// the runtime is noop, making the whole chain zero-cost.
		agentTelemetry := telemetry.StartAgentTelemetry(a.SessionID, a.Client)
		a.activeTelemetry = agentTelemetry
		defer func() {
			a.activeTelemetry = nil
			outcome := telemetry.AgentOutcomeCompleted
			if ctx.Err() != nil {
				outcome = telemetry.AgentOutcomeInterrupted
			}
			telemetry.EndAgentTelemetry(agentTelemetry, outcome)
		}()
		defer a.emitHook(ctx, hooks.EventSessionEnd, "", nil)

		// TS order: restoreContext runs before the session_start hook.
		a.restoreContext(conv)

		a.emitHook(ctx, hooks.EventSessionStart, "", nil)

		maxTokensEscalated := false
		outputRecoveries := 0
		rateLimitRetries := 0

		// The recovery attachment advertises every registered tool name,
		// unfiltered by the per-turn tool filter (TS: registry.listTools()
		// -> toolSchemaNames), so a compacted conversation is still told about
		// capabilities the current filter happens to hide.
		toolSchemaNames := a.registryToolNames()

		for iteration := 1; ; iteration++ {
			// TS checks the abort signal before the iteration bookkeeping:
			// an interrupted loop ends with "interrupted", not a
			// max-iterations error.
			if ctx.Err() != nil {
				// Interrupted before the turn started: surface it as an interrupted
				// loop completion rather than exiting silently (TS index.ts:266-267).
				ch <- LoopComplete{TotalTurns: iteration - 1, StopReason: "interrupted"}
				return
			}

			if a.MaxIterations > 0 && iteration > a.MaxIterations {
				ch <- ErrorEvent{Message: fmt.Sprintf("Agent reached maximum iterations (%d)", a.MaxIterations)}
				return
			}

			// Compute the tool schema list once per iteration so the recovery
			// attachment (when compact fires) and the actual Stream call below
			// agree on what's wired up. Skill filters can only change between
			// iterations, never within one.
			toolSchemas := a.currentToolSchemas()

			// Plan mode: inject structured workflow reminder.
			if a.Checker != nil && a.Checker.Mode == permissions.ModePlan {
				planPath := plan_file.GetOrCreatePlanPath(a.WorkDir)
				a.Checker.PlanFilePath = planPath
				planExists := plan_file.PlanExists(a.WorkDir)
				reminder := prompt.BuildPlanModeReminder(planPath, planExists, iteration)
				conv.AddSystemReminder(reminder)
			}

			// Coordinator Mode: inject scheduling guidance alongside the narrowed tool set.
			// Delivered via system-reminder rather than the system prompt: in long sessions
			// the initial constraints get buried, and appending each turn keeps them salient.
			// The system prompt is a cache prefix — mutating it invalidates the entire cache.
			if a.CoordinatorActiveFn != nil && a.CoordinatorActiveFn() {
				conv.AddSystemReminder(prompt.CoordinatorReminder(iteration))
			}

			// Inject deferred tool names into system-reminder so the model knows what's available via
			// ToolSearch. In dispatch mode these tools never enter tools[], so the
			// model must be explicitly told to invoke them via McpCall; otherwise
			// it reads the schema but has no way to call the tool.
			// Sent only when needed, not every turn. The reminder is appended to history, so once
			// sent it stays in context; re-sending identical content each turn would only waste
			// window space: ~60 MCP tools produce a list of 500+ tokens, which adds up to 20k+
			// over 40 turns.
			//
			// Two cases require re-sending: the pool changed (MCP servers connect asynchronously
			// and may reconnect), or the previous reminder was removed by compaction. The latter
			// is detected by scanning history, avoiding the need for a separate hook in the
			// compaction path.
			if deferredNames := a.Registry.GetDeferredToolNames(); len(deferredNames) > 0 {
				poolChanged := !slices.Equal(a.announcedDeferred, deferredNames)
				if poolChanged || !conv.HasReminderContaining(deferredReminderMarker) {
					reminder := deferredReminderMarker + " Their schemas are NOT loaded - use ToolSearch with query \"select:<name>[,<name>...]\" to load tool schemas"
					if a.Registry.McpLoadingMode == tools.McpLoadingDispatch {
						reminder += ", then invoke them with the McpCall tool"
					} else {
						reminder += " before calling them"
					}
					conv.AddSystemReminder(reminder + ":\n" + strings.Join(deferredNames, "\n"))
					a.announcedDeferred = deferredNames
				}
			}

			// Drain queued hook notifications and any external notifications (e.g. a
			// team mailbox) into system reminders for this turn (TS ordering).
			if a.Hooks != nil {
				for _, note := range a.Hooks.DrainNotifications() {
					if note.Output != "" {
						conv.AddSystemReminder(note.Output)
					}
				}
			}
			if a.NotificationFn != nil {
				for _, note := range a.NotificationFn() {
					conv.AddSystemReminder(note)
				}
			}

			// Skills added mid-session: only append the newly appeared entries,
			// without resending the full listing or touching the system prompt,
			// to avoid invalidating the cache prefix.
			if a.SkillDeltaFn != nil {
				if delta := a.SkillDeltaFn(); delta != "" {
					conv.AddSystemReminder("The following skills became available:\n" + delta)
				}
			}

			a.emitHook(ctx, hooks.EventTurnStart, "", nil)

			// The turn body runs inside a closure so a deferred turn_end hook
			// fires on every exit path — normal completion, retries, errors, and
			// interrupts (TS fires turn_end in an inner finally).
			sig := func() turnSignal {
				defer a.emitHook(ctx, hooks.EventTurnEnd, "", nil)

				a.emitHook(ctx, hooks.EventPreSend, "", nil)
				// Pre-send and turn-start hook output must reach the request they prepare.
				if a.Hooks != nil {
					for _, note := range a.Hooks.DrainNotifications() {
						if note.Output != "" {
							conv.AddSystemReminder(note.Output)
						}
					}
				}

				// Layer 2: auto-compact
				// Layer 1 (tool result budget) is already applied when results enter history;
				// the stored content is at its final size, so token estimation uses it directly.
				mc := compact.ManageContext(ctx, conv, a.Client, a.WorkDir, a.SessionID, a.ContextWindow, a.MaxOutputTokens, &a.compactTracking, a.RecoveryState, toolSchemaNames, toolSchemas)
				if mc.Message != "" {
					ch <- CompactEvent{Message: mc.Message}
				}
				if mc.Compacted {
					// ReplaceWithCompacted already cleared the usage anchor; TS
					// only calls restoreContext here (index.ts:402-404).
					a.restoreContext(conv)
				}

				events, errs := a.Client.Stream(ctx, conv, toolSchemas)
				// Wrap the raw stream with the generation observation and LLM
				// metrics (TS index.ts:412-420). Passthrough — same channels,
				// no goroutine — when telemetry is disabled.
				events, errs = telemetry.ObserveLlmStream(ctx, a.Client, events, errs, agentTelemetry)

				var text strings.Builder
				var toolCalls []llm.ToolCallComplete
				var thinkingBlocks []conversation.ThinkingBlock
				// TS initializes stopReason to "end_turn"; a stream that never
				// reports stream_end keeps the default.
				stopReason := "end_turn"
				sawStreamEnd := false
				var usage llm.UsageInfo

				executor := NewStreamingExecutor(a.Registry, ch)

				for ev := range events {
					// Interrupted mid-stream: stop consuming; the partial text is
					// saved by the post-stream interrupt checkpoint (TS looping=false).
					if ctx.Err() != nil {
						break
					}
					switch e := ev.(type) {
					case llm.ThinkingDelta:
						ch <- ThinkingText{Text: e.Text}
					case llm.ThinkingComplete:
						thinkingBlocks = append(thinkingBlocks, conversation.ThinkingBlock{
							Thinking:  e.Thinking,
							Signature: e.Signature,
						})
						ch <- ThinkingComplete{Thinking: e.Thinking, Signature: e.Signature}
					case llm.TextDelta:
						text.WriteString(e.Text)
						ch <- StreamText{Text: e.Text}
					case llm.ToolCallStart:
						// TS emits nothing on start; the tool_use event fires once on
						// complete so the host does not see a duplicate.
					case llm.ToolCallDelta:
						// ignore
					case llm.ToolCallComplete:
						toolCalls = append(toolCalls, e)
						ch <- ToolUseEvent{
							ToolID:   e.ToolID,
							ToolName: e.ToolName,
							Args:     e.Arguments,
						}
						// Collect tool calls; batch-execute by safety category after streaming completes.
						executor.Submit(toolCallInfo{
							toolID:    e.ToolID,
							toolName:  e.ToolName,
							arguments: e.Arguments,
						})
					case llm.StreamEnd:
						stopReason = e.StopReason
						usage = e.Usage
						sawStreamEnd = true
					}
				}

				// TS yields the usage event the moment stream_end arrives —
				// before the error/interrupt checkpoints — and only when a
				// stream_end was actually received.
				if sawStreamEnd {
					ch <- UsageEvent{
						InputTokens:         usage.InputTokens,
						OutputTokens:        usage.OutputTokens,
						CacheReadTokens:     usage.CacheReadTokens,
						CacheCreationTokens: usage.CacheCreationTokens,
					}
				}

				// Handle stream errors.
				select {
				case err := <-errs:
					if err != nil {
						// Interrupted: save the partial text and end the loop (TS
						// index.ts:477-488 checks abortSignal in the stream catch).
						if ctx.Err() != nil {
							if text.String() != "" || len(thinkingBlocks) > 0 {
								conv.AddAssistantFull(text.String(), thinkingBlocks, nil)
								a.persistLastMessage(conv)
							}
							ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
							return turnReturn
						}
						retry, compacted, interrupted := a.handleStreamError(ctx, ch, conv, err, &rateLimitRetries)
						if interrupted {
							// TS: an abort during the rate-limit wait ends the loop
							// as interrupted (index.ts:531-534) instead of
							// surfacing the rate-limit error.
							ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
							return turnReturn
						}
						if retry {
							if compacted {
								conv.ClearUsageAnchor()
								a.restoreContext(conv)
							}
							return turnNext // retry the turn
						}
						// Generic stream error: TS saves the partial assistant text
						// before surfacing the error (index.ts:538-541).
						if text.String() != "" || len(thinkingBlocks) > 0 {
							conv.AddAssistantFull(text.String(), thinkingBlocks, nil)
							a.persistLastMessage(conv)
						}
						ch <- ErrorEvent{Message: err.Error()}
						return turnReturn
					}
				default:
				}

				// The stream completed without error: reset the rate-limit retry budget
				// so a later burst of 429s gets its full allowance (TS resets after a
				// successful stream).
				rateLimitRetries = 0

				// Interrupted after a successful stream: save the partial text and end
				// the loop instead of burning an LLM call that would immediately abort
				// (TS index.ts:550-557).
				if ctx.Err() != nil {
					if text.String() != "" || len(thinkingBlocks) > 0 {
						conv.AddAssistantFull(text.String(), thinkingBlocks, nil)
						a.persistLastMessage(conv)
					}
					ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
					return turnReturn
				}

				a.emitHook(ctx, hooks.EventPostReceive, text.String(), nil)

				anchorAfterAssistant := func() {
					conv.RecordUsageAnchor(
						usage.InputTokens,
						usage.OutputTokens,
						usage.CacheReadTokens,
						usage.CacheCreationTokens,
					)
				}

				// Handle max_tokens stop reason.
				if stopReason == "max_tokens" {
					// The escalated ceiling stays inside the context window (TS:
					// Math.min(MAX_TOKENS_CEILING, contextWindow) — a pure min).
					ceiling := min(maxTokensCeiling, a.ContextWindow)
					setter, hasSetter := a.Client.(llm.MaxTokensSetter)
					// Escalate only once, only when the current budget is below the
					// ceiling, and only if the client supports it. When the client
					// has no setter this falls through to the recovery branch instead
					// of looping forever on the escalation path (TS guard).
					if !maxTokensEscalated && a.MaxOutputTokens < ceiling && hasSetter {
						setter.SetMaxOutputTokens(ceiling)
						a.MaxOutputTokens = ceiling
						maxTokensEscalated = true
						if text.String() != "" {
							conv.AddAssistantFull(text.String(), thinkingBlocks, nil)
							a.persistLastMessage(conv)
							anchorAfterAssistant()
							conv.AddUserMessage("Output token limit hit. Resume directly from where you stopped. Do not apologize or repeat previous content. Pick up mid-thought if needed.")
						}
						ch <- RetryEvent{Reason: "max_tokens escalation", Wait: 0}
						return turnNext
					} else if outputRecoveries < maxOutputTokensRecoveries {
						// Multi-turn recovery.
						outputRecoveries++
						conv.AddAssistantFull(text.String(), thinkingBlocks, nil)
						a.persistLastMessage(conv)
						anchorAfterAssistant()
						conv.AddUserMessage("Output token limit hit. Resume directly from where you stopped. Break remaining work into smaller pieces.")
						ch <- RetryEvent{Reason: fmt.Sprintf("max_tokens recovery %d/%d", outputRecoveries, maxOutputTokensRecoveries), Wait: 0}
						return turnNext
					}
					// Exhausted: fall through to normal completion.
				} else {
					// Reset recovery counter on successful turn.
					outputRecoveries = 0
				}

				if len(toolCalls) == 0 {
					conv.AddAssistantFull(text.String(), thinkingBlocks, nil)
					a.persistLastMessage(conv)
					// TS records the usage anchor on the shared path before the
					// tool-branch split (index.ts:635-642), so the final no-tool
					// turn is anchored too — the long-lived Go Agent reuses the
					// anchor on the next Run.
					anchorAfterAssistant()
					if a.FileHistory != nil {
						// The 60-char truncation lives in MakeSnapshot (TS:
						// file-history makeSnapshot), applied by UTF-16 units.
						a.FileHistory.MakeSnapshot(conv.Len(), text.String())
					}
					ch <- LoopComplete{TotalTurns: iteration, StopReason: stopReason}
					if a.OnLoopComplete != nil {
						// Called synchronously with panic isolation (TS
						// index.ts:764-770): the callback may touch the conversation,
						// so it must not race the loop from another goroutine. A slow
						// callback must spawn its own goroutine rather than block here.
						func() {
							defer func() { _ = recover() }()
							a.OnLoopComplete(conv)
						}()
					}
					return turnReturn
				}

				var toolUses []conversation.ToolUseBlock
				for _, tc := range toolCalls {
					toolUses = append(toolUses, conversation.ToolUseBlock{
						ToolUseID: tc.ToolID,
						ToolName:  tc.ToolName,
						Arguments: tc.Arguments,
						// TS spreads event.providerItemId into the stored
						// tool_use (index.ts:457-459); the OpenAI Responses
						// client reads it back to build function_call_output.
						ProviderItemID: tc.ProviderItemID,
					})
				}
				conv.AddAssistantFull(text.String(), thinkingBlocks, toolUses)
				a.persistLastMessage(conv)
				// Anchor real usage to the conversation now that the assistant message
				// is in place; subsequent tool results + next user message are
				// estimated incrementally on top of this baseline.
				anchorAfterAssistant()

				// Batch-execute by safety category: read-only tools concurrently, write/command tools serially.
				results := executor.ExecuteAll(ctx, a)

				// Spill-file readback results are exempt from spilling: if the content the model
				// just read back were persisted and replaced with a preview, the model would never
				// see the full text and would loop between "read back" and "spill" indefinitely.
				exempt := make(map[string]bool)
				for _, tc := range toolCalls {
					if tool_result.IsSpillReadback(tc.ToolName, tc.Arguments, a.WorkDir, a.SessionID) {
						exempt[tc.ToolID] = true
					}
				}

				var toolResults []conversation.ToolResultBlock
				for _, r := range results {
					ch <- ToolResultEvent{
						ToolID:        r.toolID,
						ToolName:      r.toolName,
						Output:        r.output,
						IsError:       r.isError,
						Elapsed:       r.elapsed,
						ContentBlocks: r.contentBlocks,
					}

					content := r.output
					spilled := false
					if utils.UTF16Len(content) > tools.MaxOutputChars && !exempt[r.toolID] {
						// Single result exceeds limit: persist to disk and replace with preview.
						// If the write fails the original is retained; either way the result is
						// marked exempt so the aggregate budget won't retry it.
						content = tool_result.PersistLargeResult(a.WorkDir, a.SessionID, r.toolID, r.output)
						spilled = content != r.output
						exempt[r.toolID] = true
					}
					block := conversation.ToolResultBlock{
						ToolUseID:     r.toolID,
						Content:       content,
						IsError:       r.isError,
						ContentBlocks: r.contentBlocks,
					}
					if spilled {
						// The text fallback and the rich text blocks must tell the same
						// story, or the model receives the original output through
						// ContentBlocks and never sees the spill preview.
						tool_result.ReplaceToolResultContent(&block, content)
					}
					toolResults = append(toolResults, block)
				}

				// Aggregate budget: parallel tool results land in a single message, so the
				// per-item threshold cannot prevent the combined total from exceeding the limit.
				// Process the entire batch before it enters history so the message is born final.
				tool_result.ApplyBudget(toolResults, exempt, a.WorkDir, a.SessionID)

				// Only end the loop when ExitPlanMode actually succeeded: an errored
				// call (e.g. invoked outside plan mode) must flow back to the model as
				// a normal tool_result so it can self-correct instead of the turn
				// ending on a dangling error (TS agent/index.ts:703-715).
				exitPlanSucceeded := false
				for _, tc := range toolCalls {
					if tc.ToolName != "ExitPlanMode" {
						continue
					}
					for _, r := range results {
						if r.toolID == tc.ToolID && !r.isError {
							exitPlanSucceeded = true
							break
						}
					}
					if exitPlanSucceeded {
						break
					}
				}
				conv.AddToolResultsMessage(toolResults)
				a.persistLastMessage(conv)

				// The user interrupted while tools were running: results are already
				// recorded, so end the loop here instead of burning an LLM call that
				// would immediately abort (TS index.ts:722-726).
				if ctx.Err() != nil {
					ch <- TurnComplete{Turn: iteration}
					ch <- LoopComplete{TotalTurns: iteration, StopReason: "interrupted"}
					return turnReturn
				}

				// Non-blocking memory recall: check whether the prefetch is ready after tool execution.
				if a.MemoryRecallCh != nil {
					select {
					case recall := <-a.MemoryRecallCh:
						if recall.Reminder != "" {
							conv.AddSystemReminder(recall.Reminder)
							// Only mark as surfaced once actually injected. Unconsumed
							// recall results leave no trace so those memories remain
							// eligible in the next recall pass.
							a.MarkMemoriesSurfaced(recall.Paths)
						}
						a.MemoryRecallCh = nil // consume only once
					default:
						// Prefetch not ready yet; will check again next iteration.
					}
				}

				if exitPlanSucceeded {
					ch <- TurnComplete{Turn: iteration}
					ch <- LoopComplete{TotalTurns: iteration, StopReason: "end_turn"}
					return turnReturn
				}
				ch <- TurnComplete{Turn: iteration}
				return turnNext
			}()
			if sig == turnReturn {
				return
			}
		}
	}()

	return ch
}

// emitHook fires a hook event when an Engine is configured. Failures are non-fatal and surface via
// the hook notification queue (drained into the next turn's system reminders).
func (a *Agent) emitHook(ctx context.Context, event hooks.EventName, message string, args map[string]any) {
	if a.Hooks == nil {
		return
	}
	a.Hooks.RunHooks(hooks.HookContext{
		EventName: event,
		ToolArgs:  args,
		Message:   message,
	}, hooks.RuntimeOptions{WorkDir: a.WorkDir, Ctx: ctx})
}

// filterSchemasByName keeps only the tool schemas whose "name" passes the allow predicate. Used by
// Coordinator Mode to restrict a Lead agent to coordination-only tools while teammates do the
// actual work.
func filterSchemasByName(schemas []map[string]any, allow func(name string) bool) []map[string]any {
	out := make([]map[string]any, 0, len(schemas))
	for _, s := range schemas {
		name, _ := s["name"].(string)
		if allow(name) {
			out = append(out, s)
		}
	}
	return out
}

// handleStreamError returns (retry, compacted, interrupted): retry signals the
// caller to re-run the turn; compacted signals that a ForceCompact rewrote the
// conversation, so the caller must drop its usage anchor (its AnchorCount no
// longer maps to the new transcript); interrupted signals that the rate-limit
// wait was cut short by cancellation, which TS reports as an interrupted loop
// rather than an error. rateLimitRetries bounds consecutive 429 retries (TS
// MAX_RATE_LIMIT_RETRIES); when exhausted, retry is false so the caller
// surfaces the error instead of looping forever.
func (a *Agent) handleStreamError(ctx context.Context, ch chan AgentEvent, conv *conversation.Manager, err error, rateLimitRetries *int) (retry, compacted, interrupted bool) {
	var ctxErr *llm.ContextTooLongError
	if errors.As(err, &ctxErr) {
		// Tool results in history are already at their final form (budget applied on ingest),
		// so pass nil and let ForceCompact use conv's own messages directly.
		result, compactErr := compact.ForceCompact(ctx, conv, a.Client, a.WorkDir, a.SessionID, a.ContextWindow, a.RecoveryState, a.registryToolNames(), a.currentToolSchemas(), "")
		if compactErr == nil && result.Compacted {
			ch <- CompactEvent{Message: "Auto-compacted due to context length: " + result.Message}
			return true, true, false // retry, and the anchor is now stale
		}
		// Not compacted (or the summarizer failed): surface the original
		// context-too-long error to the caller (TS index.ts:504-506).
		return false, false, false
	}

	var rlErr *llm.RateLimitError
	if errors.As(err, &rlErr) {
		if *rateLimitRetries >= maxRateLimitRetries {
			return false, false, false // exhausted: caller surfaces the error
		}
		*rateLimitRetries++
		wait := parseRetryAfter(rlErr.RetryAfter)
		ch <- RetryEvent{Reason: "rate limited", Wait: wait}
		select {
		case <-time.After(wait):
			return true, false, false // retry without compaction
		case <-ctx.Done():
			// TS interruptibleSleep resolves early on abort; the caller yields
			// loop_complete "interrupted" (index.ts:531-534).
			return false, false, true
		}
	}

	return false, false, false
}

// retryAfterSecondsRe is the TS Retry-After delta-seconds shape.
var retryAfterSecondsRe = regexp.MustCompile(`^\d+(?:\.\d+)?$`)

// parseRetryAfter accepts delta-seconds (including fractional) and HTTP dates,
// bounding the result to maxRetryDelay to avoid overflow (TS parseRetryAfter).
func parseRetryAfter(header string) time.Duration {
	value := strings.TrimSpace(header)
	if value == "" {
		return 5 * time.Second
	}
	// delta-seconds, optionally fractional — TS accepts only a plain decimal
	// (`^\d+(?:\.\d+)?$`), so "1e3"/"+5"/".5"/"-5" fall through to the date
	// branch and end at the 5s default.
	if retryAfterSecondsRe.MatchString(value) {
		secs, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return 5 * time.Second
		}
		d := time.Duration(secs * float64(time.Second))
		if d > maxRetryDelay {
			return maxRetryDelay
		}
		if d < 0 {
			return 0
		}
		return d
	}
	// HTTP date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT").
	if len(value) >= 4 && value[3] == ',' {
		if t, err := http.ParseTime(value); err == nil {
			d := time.Until(t)
			if d < 0 {
				d = 0
			}
			if d > maxRetryDelay {
				return maxRetryDelay
			}
			return d
		}
	}
	return 5 * time.Second
}

type toolExecResult struct {
	toolID   string
	toolName string
	output   string
	isError  bool
	elapsed  time.Duration
	// contentBlocks lets tools pass structured content blocks through to the
	// conversation history. Only ToolSearch on the official endpoint populates
	// this (tool_reference); all other tools leave it empty and use plain text.
	contentBlocks []map[string]any
}

// extractFilePath pulls the hook-context file path exactly like TS
// (strArg(args, "file_path", strArg(args, "path", ""))): only file_path with a
// path fallback, so hooks can do path-glob matching (`file_path =* "**/*.go"`).
func extractFilePath(args map[string]any) string {
	// TS uses strArg(args, "file_path", strArg(args, "path", "")): a present
	// string wins even when empty, so `path` is only consulted when file_path
	// is missing or not a string.
	for _, key := range []string{"file_path", "path"} {
		if v, ok := args[key].(string); ok {
			return v
		}
	}
	return ""
}

// precheckTool runs the pre-execution gauntlet for a single call in the TS
// executeBatch order: tool filter → pre-tool hooks → unknown-tool → McpCall
// target resolution → permission decision (with the interactive ask flow).
// It returns (result, true) when the call is blocked and the result must be
// reported as-is, or (_, false) when the call is cleared to run. Blocked
// results carry elapsed 0, exactly like the TS events.
func (a *Agent) precheckTool(ctx context.Context, eventCh chan AgentEvent, tc toolCallInfo) (toolExecResult, bool) {
	// Enforce the tool filter at execution time (TS: the filter is the single
	// authority — a filtered-out tool must not run even if the model calls it).
	if a.ToolNameFilter != nil && !a.ToolNameFilter(tc.toolName) {
		return toolExecResult{
			toolID:   tc.toolID,
			toolName: tc.toolName,
			output:   fmt.Sprintf("Tool '%s' is not available to this agent.", tc.toolName),
			isError:  true,
		}, true
	}

	// Fire pre-tool hooks before the permission check (TS ordering: the hooks
	// run even for an unknown tool name).
	if a.Hooks != nil {
		hookCtx := hooks.HookContext{
			EventName: hooks.EventPreToolUse,
			ToolName:  tc.toolName,
			ToolArgs:  tc.arguments,
			FilePath:  extractFilePath(tc.arguments),
		}
		if rejected, msg := a.Hooks.RunPreToolHooks(hookCtx, hooks.RuntimeOptions{WorkDir: a.WorkDir, Ctx: ctx}); rejected {
			return toolExecResult{
				toolID:   tc.toolID,
				toolName: tc.toolName,
				output:   "Rejected by hook: " + msg,
				isError:  true,
			}, true
		}
	}

	tool := a.Registry.Get(tc.toolName)
	// TS: the permission check runs even for an unknown tool name, with the
	// category falling back to "command" (agent/index.ts `tool?.category ??
	// "command"`); the unknown-tool error itself comes from the executor stage
	// (runClearedTool), after the permission decision.
	category := tools.CategoryCommand
	if tool != nil {
		category = tool.Category()
	}

	// McpCall routes to an inner tool: resolve the target so the permission
	// check and the tool filter also cover it (TS: the routed target gets a
	// second check with the inner arguments, otherwise McpCall would bypass
	// target-level rules and could even drive a built-in tool).
	var mcpTarget tools.Tool
	var mcpInnerArgs map[string]any
	if mcpCall, ok := tool.(*tools.McpCallTool); ok {
		if mcpTarget = mcpCall.ResolveTarget(tc.arguments); mcpTarget != nil {
			if a.Registry.Get(mcpTarget.Name()) == nil ||
				(a.ToolNameFilter != nil && !a.ToolNameFilter(mcpTarget.Name())) {
				return toolExecResult{
					toolID:   tc.toolID,
					toolName: tc.toolName,
					output:   fmt.Sprintf("Tool '%s' is not available to this agent.", mcpTarget.Name()),
					isError:  true,
				}, true
			}
			// TS: asRecord(tu.arguments.arguments ?? {}) — an array becomes an
			// indexed object rather than collapsing to {}.
			mcpInnerArgs = utils.AsRecord(tc.arguments["arguments"])
		}
	}

	if a.Checker != nil {
		decisions := []permissions.Decision{a.Checker.CheckNamed(tc.toolName, category, tc.arguments)}
		if mcpTarget != nil {
			decisions = append(decisions, a.Checker.CheckNamed(mcpTarget.Name(), mcpTarget.Category(), mcpInnerArgs))
		}
		// deny wins, then ask, else the wrapper decision (TS: find deny ?? find ask ?? first).
		decision := decisions[0]
		found := false
		for _, d := range decisions {
			if d.Effect == permissions.Deny {
				decision, found = d, true
				break
			}
		}
		if !found {
			for _, d := range decisions {
				if d.Effect == permissions.Ask {
					decision, found = d, true
					break
				}
			}
		}

		if decision.Effect == permissions.Deny {
			return toolExecResult{
				toolID:   tc.toolID,
				toolName: tc.toolName,
				output: fmt.Sprintf("Permission denied: %s. This operation has been blocked by the security policy. "+
					"Inform the user that the command was denied; do not describe what the command would do.", decision.Reason),
				isError: true,
			}, true
		}
		if decision.Effect == permissions.Ask {
			var resp PermissionResponse
			switch {
			case a.PermissionsHeadless:
				// TS: ask without an approval handler settles with this exact
				// message; nobody is prompted.
				return toolExecResult{
					toolID:   tc.toolID,
					toolName: tc.toolName,
					output:   "Permission required, but this agent has no approval handler. The tool was not executed.",
					isError:  true,
				}, true
			case a.OnPermissionRequest != nil:
				// TS callback path (inherited by subagent loops). A failing
				// handler settles with the TS error message (TS: catch around
				// the awaited onPermissionRequest).
				answer, herr := callPermissionHandler(a.OnPermissionRequest, tc.toolName, tc.arguments, decision, tc.toolID)
				if herr != nil {
					return toolExecResult{
						toolID:   tc.toolID,
						toolName: tc.toolName,
						output:   fmt.Sprintf("Permission request failed: %s. The tool was not executed.", herr),
						isError:  true,
					}, true
				}
				switch answer {
				case tools.PermissionAllow:
					resp = PermAllow
				case tools.PermissionAllowAlways:
					resp = PermAllowAlways
				default:
					resp = PermDeny
				}
			default:
				resp = a.awaitPermission(ctx, eventCh, tc.toolName, tc.arguments)
			}
			if resp == PermDeny {
				return toolExecResult{
					toolID:   tc.toolID,
					toolName: tc.toolName,
					output:   conversation.RejectedToolResult,
					isError:  true,
				}, true
			}
			// TS persists allowAlways only when the turn is not aborted. The
			// rule lands in the project rule file; the engine re-reads it on
			// every evaluation, so it takes effect right after this turn. The
			// persist runs inside the TS try block, so a write failure also
			// settles with the failed-request message and blocks execution.
			if resp == PermAllowAlways && ctx.Err() == nil {
				if err := a.Checker.AllowAlways(tc.toolName, tc.arguments); err != nil {
					return toolExecResult{
						toolID:   tc.toolID,
						toolName: tc.toolName,
						output:   fmt.Sprintf("Permission request failed: %s. The tool was not executed.", err),
						isError:  true,
					}, true
				}
			}
		}
	}
	return toolExecResult{}, false
}

// callPermissionHandler invokes the TS-shaped approval callback, converting a
// panic into an error (TS: the catch around the awaited onPermissionRequest —
// any throw settles the call with "Permission request failed: ..."). The
// recover also keeps a misbehaving host callback from taking down the shared
// server process.
func callPermissionHandler(h permissions.RequestHandler, toolName string, args map[string]any, decision permissions.Decision, toolCallID string) (answer tools.PermissionAnswer, err error) {
	defer func() {
		if r := recover(); r != nil {
			answer = tools.PermissionDeny
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("%v", r)
			}
		}
	}()
	return h(toolName, args, decision, toolCallID)
}

// awaitPermission emits the permission request event and blocks until the
// consumer answers or the run is cancelled (TS host handlers race the abort
// signal and resolve as a denial when the turn is cancelled).
func (a *Agent) awaitPermission(ctx context.Context, eventCh chan AgentEvent, toolName string, args map[string]any) PermissionResponse {
	respCh := make(chan PermissionResponse, 1)
	desc := permissions.DescribeToolAction(toolName, args)
	eventCh <- PermissionRequestEvent{
		ToolName:   toolName,
		Desc:       desc,
		Args:       args,
		ResponseCh: respCh,
	}
	select {
	case resp := <-respCh:
		return resp
	case <-ctx.Done():
		return PermDeny
	}
}

// runClearedTool executes a call that passed precheckTool: telemetry-wrapped
// tool.Execute plus the post-execution bookkeeping (recall hints, ReadFile
// recovery snapshot, post_tool_use hooks). Elapsed measures only the
// execution, like the TS collectResults timer (permission waits and hooks are
// not counted).
func (a *Agent) runClearedTool(ctx context.Context, eventCh chan AgentEvent, tc toolCallInfo) (ret toolExecResult) {
	start := time.Now()

	// A tool panic must not take down the whole server process: recover it into
	// an error result so the model can self-correct (TS streaming-executor wraps
	// each call and returns "Error executing X: ...").
	defer func() {
		if r := recover(); r != nil {
			ret = toolExecResult{
				toolID:   tc.toolID,
				toolName: tc.toolName,
				output:   fmt.Sprintf("Error executing %s: %v", tc.toolName, r),
				isError:  true,
				elapsed:  time.Since(start),
			}
		}
	}()

	tool := a.Registry.Get(tc.toolName)
	if tool == nil {
		// TS streaming-executor: an unknown tool name settles here, after the
		// permission gauntlet, with a single error that lets the model
		// self-correct with another tool.
		return toolExecResult{
			toolID:   tc.toolID,
			toolName: tc.toolName,
			output:   fmt.Sprintf("Error: unknown tool '%s'", tc.toolName),
			isError:  true,
		}
	}

	// Resolve relative paths against the session workDir, not the server cwd.
	execCtx := tools.WithWorkDir(ctx, a.WorkDir)
	// TS ToolContext: sessionId, toolCallId, fileStateCache and fileHistory
	// ride on the per-call context. Attaching them unconditionally matters: an
	// empty session id or a nil cache/history is the TS shape for subagent
	// runs, and shared tool instances must not fall back to the host-wired
	// fields in that case.
	execCtx = tools.WithSessionID(execCtx, a.SessionID)
	execCtx = tools.WithToolCallID(execCtx, tc.toolID)
	execCtx = tools.WithFileStateCache(execCtx, a.FileStateCache)
	execCtx = tools.WithFileHistory(execCtx, a.FileHistory)
	// TS spawn.ts/agent: the per-run background task manager rides on the
	// tool context; an explicit nil disables backgrounding for this run.
	if a.BackgroundTaskManager != nil {
		execCtx = tools.ContextWithBackgroundTaskManager(execCtx, a.BackgroundTaskManager)
	} else if a.BackgroundTasksDisabled {
		execCtx = tools.ContextWithBackgroundTaskManager(execCtx, nil)
	}
	// TS: ctx.permissionChecker = this.checker — the loop's own security
	// checker rides on the tool context, so child loops spawned by tools
	// (AgentTool) inherit it instead of a host-wired field.
	execCtx = permissions.ContextWithChecker(execCtx, a.Checker)
	// TS: ctx.onPermissionRequest = this.onPermissionRequest — the loop's own
	// approval path rides on the tool context, so child loops spawned by tools
	// (AgentTool) inherit it. Headless loops propagate nothing, and their
	// children end up handler-less exactly like TS.
	if !a.PermissionsHeadless {
		if a.OnPermissionRequest != nil {
			execCtx = permissions.ContextWithRequestHandler(execCtx, a.OnPermissionRequest)
		} else {
			execCtx = permissions.ContextWithRequestHandler(execCtx, func(toolName string, args map[string]any, _ permissions.Decision, _ string) (tools.PermissionAnswer, error) {
				switch a.awaitPermission(ctx, eventCh, toolName, args) {
				case PermAllow:
					return tools.PermissionAllow, nil
				case PermAllowAlways:
					return tools.PermissionAllowAlways, nil
				default:
					return tools.PermissionDeny, nil
				}
			})
		}
	}
	// TS agent: every tool execution is wrapped in a yukino.tool.execute
	// observation (observeToolExecution); nil handle = noop telemetry =
	// direct call.
	var result tools.ToolResult
	if a.activeTelemetry != nil {
		telemetryHandle := a.activeTelemetry
		result = telemetry.ObserveToolExecution(tc.toolName, telemetryHandle, func() tools.ToolResult {
			return tool.Execute(execCtx, tc.arguments)
		})
	} else {
		result = tool.Execute(execCtx, tc.arguments)
	}
	a.RecordRecentTool(tc.toolName)

	// Snapshot exactly what ReadFile returned to the model (with line numbers,
	// honoring offset/limit) so recovery stays aligned with what it saw; skip
	// image reads, which carry content blocks rather than text (TS).
	if !result.IsError && tc.toolName == "ReadFile" && len(result.ContentBlocks) == 0 {
		if p, _ := tc.arguments["file_path"].(string); p != "" {
			a.RecoveryState.RecordFileRead(p, result.Output)
		}
	}

	if a.Hooks != nil {
		a.Hooks.RunHooks(hooks.HookContext{
			EventName: hooks.EventPostToolUse,
			ToolName:  tc.toolName,
			ToolArgs:  tc.arguments,
			FilePath:  extractFilePath(tc.arguments),
			Message:   result.Output,
		}, hooks.RuntimeOptions{WorkDir: a.WorkDir, Ctx: ctx})
	}

	return toolExecResult{
		toolID:        tc.toolID,
		toolName:      tc.toolName,
		output:        result.Output,
		isError:       result.IsError,
		elapsed:       time.Since(start),
		contentBlocks: result.ContentBlocks,
	}
}

// executeSingleTool runs one call end to end: the collectResults-style abort
// check, the pre-execution gauntlet, then the execution. The serial executor
// path and direct callers use this; the parallel executor runs precheckTool
// serially for the whole batch first and only then launches runClearedTool
// concurrently, matching the TS submit/collect split.
func (a *Agent) executeSingleTool(ctx context.Context, eventCh chan AgentEvent, tc toolCallInfo) toolExecResult {
	// TS collectResults re-checks the abort signal when each pending call
	// starts; an aborted call reports the cancelled-before-start wording.
	if ctx.Err() != nil {
		return toolExecResult{
			toolID:   tc.toolID,
			toolName: tc.toolName,
			output:   "Tool execution was cancelled before it started.",
			isError:  true,
		}
	}
	if r, blocked := a.precheckTool(ctx, eventCh, tc); blocked {
		return r
	}
	return a.runClearedTool(ctx, eventCh, tc)
}

// persistLastMessage writes the most recently appended conversation message to the session log.
//
// Persistence lives in the main loop rather than in individual frontends: both TUI and Web share
// the same recording path, ensuring intermediate assistant text and complete tool-call chains are
// captured so sessions can be faithfully restored on resume. Skipped (no disk write) when WorkDir
// or SessionID is empty (one-shot callers, sub-agents).
func (a *Agent) persistLastMessage(conv *conversation.Manager) {
	if a.WorkDir == "" || a.SessionID == "" {
		return
	}
	msgs := conv.GetMessages()
	if len(msgs) == 0 {
		return
	}
	session.SaveMessage(a.WorkDir, a.SessionID, session.FromConversation(msgs[len(msgs)-1]))
}
