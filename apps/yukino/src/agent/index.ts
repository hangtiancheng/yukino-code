/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { AgentEvent } from "./events.js";
import { StreamingExecutor } from "./streaming-executor.js";

import { manageContext, forceCompact, AutoCompactTrackingState } from "@/compact/compact.js";
import { RecoveryState } from "@/compact/recovery.js";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS } from "@/config/index.js";
import type { ConversationManager } from "@/conversation/index.js";
import type { ToolUseBlock, ToolResultBlock } from "@/conversation/index.js";
import { REJECTED_TOOL_RESULT } from "@/conversation/pairing.js";
import type { FileHistory } from "@/file-history/index.js";
import type { HookEngine, EventName } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError, RateLimitError } from "@/llm/errors.js";
import type { UsageInfo } from "@/llm/events.js";
import type { RecallResult } from "@/memory/manager.js";
import type { PermissionChecker } from "@/permissions/index.js";
import { getOrCreatePlanPath, planExists } from "@/plan-file/index.js";
import { coordinatorReminder } from "@/prompt/coordinator.js";
import { buildPlanModeReminder } from "@/prompt/plan-mode.js";
import { saveMessage, toolUsesToRecords, toolResultsToRecords } from "@/session/index.js";
import { getSessionFilePath } from "@/session/index.js";
import type { TaskManager } from "@/subagent/task-manager.js";
import {
  endAgentTelemetry,
  observeLlmStream,
  startAgentTelemetry,
  type AgentTelemetry,
} from "@/telemetry/instrumentation.js";
import {
  applyBudget,
  isSpillReadback,
  persistLargeResult,
  replaceToolResultContent,
} from "@/tool-result/index.js";
import type { FileStateCache } from "@/tools/file-state-cache.js";
import { McpCallTool } from "@/tools/mcp-call.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { PermissionRequestHandler, ToolResult } from "@/tools/types.js";
import { asErrorString, asRecord, strArg } from "@/utils/index.js";

// Submodule namespaces for library consumers (Agent.<Sub>.*).
export * as Events from "./events.js";
export * as StreamingExecutor from "./streaming-executor.js";

// When the model stops on max_tokens, escalate its output ceiling once to this
// value, then attempt a bounded number of multi-turn recoveries.
const MAX_TOKENS_CEILING = 64000;
const MAX_TOKENS_RECOVERIES = 3;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60000;
// Tool output exceeding this threshold is spilled to disk rather than truncated
// outright, to avoid losing critical information.
// Per-result spill threshold before entering conversation history: once the
// character count exceeds this value the full content is written to disk and
// only a preview plus the file path is retained in history. Set to 50000
// (rather than a smaller value) so the model can see enough content in one
// pass without needing an extra ReadFile round-trip to view the full result.
const MAX_OUTPUT_CHARS = 50000;

// Fixed prefix of the deferred-tool reminder. Used to detect whether the reminder
// is still present in history: after compaction collapses history into a summary,
// the original reminder is gone and must be re-injected.
const DEFERRED_REMINDER_MARKER = "The following deferred tools are available via ToolSearch.";

export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  workDir: string;
  sessionId?: string;
  hookEngine?: HookEngine;
  fileHistory?: FileHistory;
  fileStateCache?: FileStateCache;
  abortSignal?: AbortSignal;
  contextWindow?: number;
  maxOutput?: number;
  recoveryState?: RecoveryState;
  maxIterations?: number;
  notificationFn?: () => string[];
  /**
   * Background task registry owned by this loop. Injected into every tool
   * context so backgrounded Bash commands register — and later notify — here
   * instead of on the host-level default. Subagent runs pass their own;
   * explicit `null` disables backgrounding for the whole loop (in-process
   * teammate turns) even when tools carry a host-wired manager.
   */
  taskManager?: TaskManager | null;
  onLoopComplete?: (conversation: ConversationManager) => void;
  activeSkills?: Map<string, string>;
  toolFilter?: (name: string) => boolean;
  // coordinatorActiveFn reports whether coordinator mode is currently active.
  // Checked each turn alongside toolFilter so that dispatch guidance appears
  // while tools are narrowed and disappears once the Team is torn down.
  coordinatorActiveFn?: () => boolean;
  // Project instructions and memory content, need re-injection after compaction
  instructions?: string;
  memoryContent?: string;
  /** Available skill listing. Project-scoped, so injected via the first system-reminder instead of the system prompt */
  skillSection?: string;
  /** Returns newly discovered skills since the last call; previously notified ones are excluded */
  skillDeltaFn?: () => string;
  // Non-blocking memory recall: prefetch promise runs in parallel with the main LLM call, injected after tool execution
  memoryRecallPromise?: Promise<RecallResult>;
  /**
   * Called when recall results are actually injected into the conversation.
   * Receives the memory paths surfaced this turn. Since the Agent is recreated
   * each turn, the caller maintains the injected set across turns.
   */
  onMemoriesSurfaced?: (paths: string[]) => void;
  onPermissionRequest?: PermissionRequestHandler;
}

export class Agent {
  // Deferred tool names announced to the model last time, in lexicographic order.
  // Compared against the current pool to skip re-injection when nothing changed.
  private announcedDeferred: string[] = [];
  private client: LLMClient;
  private registry: ToolRegistry;
  private checker: PermissionChecker;
  private conversation: ConversationManager;
  private workDir: string;
  private sessionId: string;
  private sessionFilePath: string;
  private hookEngine?: HookEngine;
  private fileHistory?: FileHistory;
  private fileStateCache?: FileStateCache;
  private abortSignal?: AbortSignal;
  private contextWindow: number;
  private maxOutput: number;
  private recoveryState: RecoveryState;
  private maxIterations: number;
  private notificationFn?: () => string[];
  private taskManager?: TaskManager | null;
  private onLoopComplete?: (conversation: ConversationManager) => void;
  private compactTracking = new AutoCompactTrackingState();

  private onPermissionRequest?: AgentConfig["onPermissionRequest"];
  private toolFilter?: (name: string) => boolean;
  private coordinatorActiveFn?: () => boolean;

  activeSkills: Map<string, string>;
  private instructions: string;
  private memoryContent: string;
  private skillSection: string;
  private skillDeltaFn?: () => string;
  private memoryRecallPromise?: Promise<RecallResult>;
  private memoryRecallConsumed = false;
  /** Whether the prefetch has settled, and its result. The main loop checks this flag without awaiting. */
  private memoryRecallSettled = false;
  private memoryRecallValue?: RecallResult;
  private onMemoriesSurfaced?: (paths: string[]) => void;

  constructor(config: AgentConfig) {
    this.client = config.client;
    this.registry = config.registry;
    this.checker = config.checker;
    this.conversation = config.conversation;
    this.workDir = config.workDir;
    this.sessionId = config.sessionId ?? "";
    this.sessionFilePath = config.sessionId
      ? getSessionFilePath(config.workDir, config.sessionId)
      : "";
    this.hookEngine = config.hookEngine;
    this.fileHistory = config.fileHistory;
    this.fileStateCache = config.fileStateCache;
    this.abortSignal = config.abortSignal;
    this.contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.maxOutput = config.maxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.recoveryState = config.recoveryState ?? new RecoveryState();
    this.maxIterations = config.maxIterations ?? 0;
    this.notificationFn = config.notificationFn;
    this.taskManager = config.taskManager;
    this.onLoopComplete = config.onLoopComplete;
    this.onPermissionRequest = config.onPermissionRequest;
    this.activeSkills = config.activeSkills ?? new Map<string, string>();
    this.toolFilter = config.toolFilter;
    this.coordinatorActiveFn = config.coordinatorActiveFn;
    this.instructions = config.instructions ?? "";
    this.memoryContent = config.memoryContent ?? "";
    this.skillSection = config.skillSection ?? "";
    this.skillDeltaFn = config.skillDeltaFn;
    this.memoryRecallPromise = config.memoryRecallPromise;
    this.onMemoriesSurfaced = config.onMemoriesSurfaced;
    // Stash the prefetch result and set the flag as soon as it resolves, so the main loop can poll without awaiting
    void this.memoryRecallPromise?.then(
      (r) => {
        this.memoryRecallValue = r;
        this.memoryRecallSettled = true;
      },
      () => {
        this.memoryRecallSettled = true;
      },
    );
  }

  private restoreContext(): void {
    const skills = [
      this.skillSection,
      ...[...this.activeSkills].map(([name, body]) => `## Active skill: ${name}\n${body}`),
    ]
      .filter(Boolean)
      .join("\n\n");
    this.conversation.injectLongTermMemory(this.instructions, this.memoryContent, skills);
  }

  async *run(): AsyncGenerator<AgentEvent> {
    const telemetry = startAgentTelemetry(this.sessionId, this.client);
    this.restoreContext();
    // The filter is the sole authority — no exception branches.
    const toolSchemas = this.registry.getAllSchemas(
      this.client.protocol ?? "anthropic",
      this.toolFilter,
    );
    const toolSchemaNames = this.registry.listTools().map((t) => t.name);

    let maxTokensEscalated = false;
    let outputRecoveries = 0;
    let rateLimitRetries = 0;
    let iteration = 0;

    await this.fireLifecycle("session_start");
    try {
      let looping = true;
      while (looping) {
        if (this.abortSignal?.aborted) {
          yield { type: "loop_complete", stopReason: "interrupted" };
          return;
        }
        iteration++;
        if (this.maxIterations > 0 && iteration > this.maxIterations) {
          yield {
            type: "error",
            error: new Error(`Agent reached maximum iterations (${String(this.maxIterations)})`),
          };
          return;
        }

        let fullText = "";
        const thinkingBlocks: { thinking: string; signature: string }[] = [];
        const toolUses: ToolUseBlock[] = [];
        let stopReason = "end_turn";

        let lastUsage: UsageInfo | null = null;

        // Plan mode: sync the plan path onto the checker (so the Layer-0 plan-file
        // write exception works however plan mode was entered) and inject a
        // per-turn reminder keeping the model read-only.
        if (this.checker.mode === "plan") {
          const planPath = getOrCreatePlanPath(this.workDir);
          this.checker.planFilePath = planPath;
          this.conversation.addSystemReminder(
            buildPlanModeReminder(planPath, planExists(this.workDir), iteration),
          );
        }

        // Coordinator mode: inject dispatch guidance while the tool set is narrowed.
        // Delivered via system-reminder rather than the system prompt: in long
        // sessions the initial constraint gets buried, so a per-turn reminder is
        // needed to pull the model back. Also, the system prompt is a cached
        // prefix — mutating it would invalidate the entire cache and re-incur cost.
        if (this.coordinatorActiveFn?.()) {
          this.conversation.addSystemReminder(coordinatorReminder(iteration));
        }

        // Deferred-load tools are hidden from the model (omitted from tools[] in dispatch mode; present but flagged defer_loading in native mode), so the name list has to be repeated.
        // In dispatch mode these tools never make it into tools[] at all, so we also have to explain that invocation goes through McpCall —
        // otherwise the model reads the schema with no idea where to call it from.
        // Only inject when necessary instead of every turn. The reminder is pushed into
        // history and stays in context, so re-injecting identical content each turn just
        // wastes window space: ~60 MCP tools produce a 500+ token list, which adds up to
        // 20k+ tokens over 40 turns.
        //
        // Two cases require re-injection: the pool changed (MCP servers connect
        // asynchronously and may disconnect/reconnect), or the previous reminder was
        // removed by compaction. The latter is detected by scanning history, avoiding
        // the need for a hook on the compaction path.
        const deferredNames = this.registry.getDeferredToolNames();
        if (deferredNames.length > 0) {
          const poolChanged =
            deferredNames.length !== this.announcedDeferred.length ||
            deferredNames.some((n, i) => n !== this.announcedDeferred[i]);
          if (poolChanged || !this.conversation.hasReminderContaining(DEFERRED_REMINDER_MARKER)) {
            let reminder =
              DEFERRED_REMINDER_MARKER +
              ' Their schemas are NOT loaded - use ToolSearch with query "select:<name>[,<name>...]" ' +
              "to load tool schemas";
            reminder +=
              this.registry.mcpLoadingMode === "dispatch"
                ? ", then invoke them with the McpCall tool"
                : " before calling them";
            this.conversation.addSystemReminder(reminder + ":\n" + deferredNames.join("\n"));
            this.announcedDeferred = deferredNames;
          }
        }

        // Drain queued hook notifications and any external notifications (e.g. a
        // team mailbox) into system reminders for this turn.
        if (this.hookEngine) {
          for (const note of this.hookEngine.drainNotifications()) {
            this.conversation.addSystemReminder(note);
          }
        }
        if (this.notificationFn) {
          for (const note of this.notificationFn()) {
            this.conversation.addSystemReminder(note);
          }
        }
        // Skills added mid-conversation: only send the delta, not the full listing,
        // and never touch the system prompt to avoid invalidating the cache prefix.
        if (this.skillDeltaFn) {
          const delta = this.skillDeltaFn();
          if (delta) {
            this.conversation.addSystemReminder("The following skills became available:\n" + delta);
          }
        }

        await this.fireLifecycle("turn_start");
        try {
          await this.fireLifecycle("pre_send");
          // Pre-send and turn-start prompts must reach the request they prepare.
          for (const note of this.hookEngine?.drainNotifications() ?? []) {
            this.conversation.addSystemReminder(note);
          }

          // Layer 1: auto-compact when the window fills up
          // Tool results are already budget-processed at the time they enter
          // history, so message sizes in the transcript are final — estimate
          // tokens directly from them.
          const mc = await manageContext(
            this.conversation,
            this.client,
            this.contextWindow,
            this.maxOutput,
            this.compactTracking,
            this.recoveryState,
            toolSchemaNames,
            toolSchemas,
            this.sessionFilePath,
            this.abortSignal,
          );
          if (mc.message) {
            yield {
              type: "compact",
              message: mc.message,
              boundary: mc.boundary,
            };
          }
          if (mc.compacted) {
            this.restoreContext();
          }
          if (this.abortSignal?.aborted) {
            yield { type: "loop_complete", stopReason: "interrupted" };
            return;
          }

          try {
            // Initiate API call directly with the conversation — no need to rebuild
            const stream = observeLlmStream(
              this.client,
              this.client.stream(this.conversation, toolSchemas, this.abortSignal),
              telemetry,
            );

            for await (const event of stream) {
              if (this.abortSignal?.aborted) {
                looping = false;
                break;
              }
              switch (event.type) {
                case "text_delta":
                  fullText += event.text;
                  yield { type: "stream_text", text: event.text };
                  break;

                case "thinking_delta":
                  yield { type: "thinking_text", text: event.text };
                  break;

                case "thinking_complete":
                  thinkingBlocks.push({
                    thinking: event.thinking,
                    signature: event.signature,
                  });
                  yield {
                    type: "thinking_complete",
                    thinking: event.thinking,
                    signature: event.signature,
                  };
                  break;

                case "tool_call_start":
                  break;

                case "tool_call_complete":
                  toolUses.push({
                    toolUseId: event.toolId,
                    toolName: event.toolName,
                    arguments: event.arguments,
                    ...(event.providerItemId ? { providerItemId: event.providerItemId } : {}),
                  });
                  yield {
                    type: "tool_use",
                    toolName: event.toolName,
                    toolId: event.toolId,
                    args: event.arguments,
                  };
                  break;

                case "stream_end":
                  stopReason = event.stopReason;
                  lastUsage = event.usage;
                  yield { type: "usage", usage: event.usage };
                  break;
              }
            }
          } catch (err) {
            if (this.abortSignal?.aborted) {
              if (fullText || thinkingBlocks.length > 0) {
                this.conversation.addAssistantFull(fullText, thinkingBlocks, []);
                this.persistLastMessage();
              }
              yield { type: "loop_complete", stopReason: "interrupted" };
              return;
            }

            // Self-heal: context too long → force-compact, then retry the turn.
            if (err instanceof ContextTooLongError) {
              try {
                const result = await forceCompact(
                  this.conversation,
                  this.client,
                  this.recoveryState,
                  toolSchemaNames,

                  toolSchemas,
                  this.sessionFilePath,
                  this.abortSignal,
                );
                if (!result.compacted) {
                  yield { type: "error", error: err };
                  return;
                }
                this.conversation.clearUsageAnchor();
                this.restoreContext();
                yield {
                  type: "compact",
                  message: "Auto-compacted due to context length: " + result.message,
                  boundary: result.boundary,
                };
                continue;
              } catch {
                yield { type: "error", error: err };
                return;
              }
            }

            // Self-heal: rate limited → wait (Retry-After header or 5s), then retry.
            if (err instanceof RateLimitError) {
              if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
                yield { type: "error", error: err };
                return;
              }
              rateLimitRetries++;
              const waitMs = parseRetryAfter(err.retryAfter);
              yield { type: "retry", reason: "rate limited", delay: waitMs };
              if (await this.interruptibleSleep(waitMs)) {
                yield { type: "loop_complete", stopReason: "interrupted" };
                return;
              }
              continue;
            }

            if (fullText || thinkingBlocks.length > 0) {
              this.conversation.addAssistantFull(fullText, thinkingBlocks, []);
              this.persistLastMessage();
            }
            yield {
              type: "error",
              error: err instanceof Error ? err : new Error(asErrorString(err)),
            };
            return;
          }

          rateLimitRetries = 0;
          if (this.abortSignal?.aborted) {
            if (fullText || thinkingBlocks.length > 0) {
              this.conversation.addAssistantFull(fullText, thinkingBlocks, []);
              this.persistLastMessage();
            }
            yield { type: "loop_complete", stopReason: "interrupted" };
            return;
          }

          await this.fireLifecycle("post_receive", fullText);

          // Handle the max_tokens stop reason: escalate the output ceiling once,
          // then do up to N multi-turn recoveries before giving up. Each recovery
          // re-prompts the model to resume from where it stopped. The escalated
          // ceiling stays inside the context window (PI never requests more than
          // the model window can hold).
          if (stopReason === "max_tokens") {
            const ceiling = Math.min(MAX_TOKENS_CEILING, this.contextWindow);
            if (!maxTokensEscalated && this.maxOutput < ceiling && this.client.setMaxOutputTokens) {
              this.client.setMaxOutputTokens?.(ceiling);
              this.maxOutput = ceiling;
              maxTokensEscalated = true;
              if (fullText) {
                this.conversation.addAssistantFull(fullText, thinkingBlocks, []);
                this.persistLastMessage();
                if (lastUsage) {
                  this.conversation.recordUsageAnchor(
                    lastUsage.inputTokens,
                    lastUsage.outputTokens,
                    lastUsage.cacheReadInputTokens,
                    lastUsage.cacheCreationInputTokens,
                  );
                }
                this.conversation.addUserMessage(
                  "Output token limit hit. Resume directly from where you stopped. Do not apologize or repeat previous content. Pick up mid-thought if needed.",
                );
              }
              yield {
                type: "retry",
                reason: "max_tokens escalation",
                delay: 0,
              };
              continue;
            } else if (outputRecoveries < MAX_TOKENS_RECOVERIES) {
              outputRecoveries++;
              this.conversation.addAssistantFull(fullText, thinkingBlocks, []);
              this.persistLastMessage();
              if (lastUsage) {
                this.conversation.recordUsageAnchor(
                  lastUsage.inputTokens,
                  lastUsage.outputTokens,
                  lastUsage.cacheReadInputTokens,
                  lastUsage.cacheCreationInputTokens,
                );
              }
              this.conversation.addUserMessage(
                "Output token limit hit. Resume directly from where you stopped. Break remaining work into smaller pieces.",
              );
              yield {
                type: "retry",
                reason: `max_tokens recovery ${String(outputRecoveries)}/${String(MAX_TOKENS_RECOVERIES)}`,
                delay: 0,
              };
              continue;
            }
            // Exhausted recoveries: fall through to normal completion.
          } else {
            outputRecoveries = 0;
          }

          this.conversation.addAssistantFull(fullText, thinkingBlocks, toolUses);
          this.persistLastMessage();

          if (lastUsage) {
            this.conversation.recordUsageAnchor(
              lastUsage.inputTokens,
              lastUsage.outputTokens,
              lastUsage.cacheReadInputTokens,
              lastUsage.cacheCreationInputTokens,
            );
          }

          if (toolUses.length > 0) {
            const results = await this.executeTools(toolUses, telemetry);
            for (const r of results) {
              yield r;
            }

            // Readback results from spill files are exempt from spilling: if we
            // re-spill content the model just read back into a preview, it will
            // never see the full text and will loop between "read back" and "spill".
            const exemptIds = new Set<string>();
            for (const tu of toolUses) {
              if (isSpillReadback(tu.toolName, tu.arguments, this.workDir, this.sessionId)) {
                exemptIds.add(tu.toolUseId);
              }
            }

            const toolResults: ToolResultBlock[] = [];
            for (const r of results) {
              if (r.type === "tool_result") {
                const toolResult: ToolResultBlock = {
                  toolUseId: r.toolId,
                  content: r.output,
                  ...(r.contentBlocks?.length ? { contentBlocks: r.contentBlocks } : {}),
                  isError: r.isError,
                };
                if (toolResult.content.length > MAX_OUTPUT_CHARS && !exemptIds.has(r.toolId)) {
                  // Single result exceeds the limit: write to disk and replace its
                  // text fallback and rich text blocks with the same preview.
                  const replacement = persistLargeResult(
                    this.workDir,
                    this.sessionId,
                    r.toolId,
                    toolResult.content,
                  );
                  if (replacement !== toolResult.content) {
                    replaceToolResultContent(toolResult, replacement);
                  }
                  exemptIds.add(r.toolId);
                }
                toolResults.push(toolResult);
              }
            }
            // Aggregate budget: results from a parallel tool batch land in a single
            // message, so the per-result threshold alone cannot guard against a
            // combined overflow. Process the entire batch before it enters history
            // so the message is in its final form from the start.
            applyBudget(toolResults, this.workDir, this.sessionId, exemptIds);
            // Only end the loop when ExitPlanMode actually succeeded: an errored
            // call (e.g. invoked outside plan mode) must flow back to the model as
            // a normal tool_result so it can self-correct instead of the turn
            // ending on a dangling error.
            const exitPlanSucceeded = toolUses.some((tu) => {
              if (tu.toolName !== "ExitPlanMode") {
                return false;
              }
              const result = results.find(
                (r) => r.type === "tool_result" && r.toolId === tu.toolUseId,
              );
              return result?.type === "tool_result" && !result.isError;
            });
            this.conversation.addToolResultsMessage(toolResults);
            this.persistLastMessage();

            // The user interrupted while tools were running: results are already
            // recorded, so end the loop here instead of burning an LLM call that
            // would immediately abort.
            if (this.abortSignal?.aborted) {
              yield { type: "turn_complete" };
              yield { type: "loop_complete", stopReason: "interrupted" };
              return;
            }

            // Non-blocking memory recall: after tool execution, check whether the prefetch has settled.
            // The settled state is populated by the prefetch itself; here we only read the flag without awaiting.
            if (
              this.memoryRecallPromise &&
              !this.memoryRecallConsumed &&
              this.memoryRecallSettled
            ) {
              const recall = this.memoryRecallValue;
              if (recall?.reminder) {
                this.conversation.addSystemReminder(recall.reminder);
                // Only mark as "surfaced" once the reminder is actually injected. Unconsumed recall
                // results leave no trace, so those memories remain eligible for the next recall.
                this.onMemoriesSurfaced?.(recall.paths);
              }
              this.memoryRecallConsumed = true;
            }

            if (exitPlanSucceeded) {
              yield { type: "turn_complete" };
              yield { type: "loop_complete", stopReason: "end_turn" };
              return;
            }

            yield { type: "turn_complete" };
          } else {
            looping = false;
            if (this.fileHistory) {
              const summary = fullText.length > 60 ? fullText.slice(0, 60) + "..." : fullText;
              this.fileHistory.makeSnapshot(this.conversation.len(), summary);
            }
            yield { type: "loop_complete", stopReason };
            // Fire-and-forget post-completion hook (e.g. background memory
            // extraction).
            if (this.onLoopComplete) {
              try {
                this.onLoopComplete(this.conversation);
              } catch {
                /* non-fatal */
              }
            }
          }
        } finally {
          await this.fireLifecycle("turn_end");
        }
      }
    } finally {
      try {
        await this.fireLifecycle("session_end");
      } finally {
        endAgentTelemetry(telemetry, this.abortSignal?.aborted ? "interrupted" : "completed");
      }
    }
  }

  // Fire a lifecycle hook event and queue any non-empty hook output as a
  // notification to be surfaced on the next turn. No-op without a HookEngine.
  private async fireLifecycle(event: EventName, message?: string): Promise<void> {
    if (!this.hookEngine) {
      return;
    }
    const results = await this.hookEngine.fire(
      event,
      { event, message },
      { workDir: this.workDir, abortSignal: this.abortSignal },
    );
    for (const r of results) {
      if (r.output) {
        this.hookEngine.recordNotification(r.output);
      }
    }
  }

  // Sleep for ms, resolving early with `true` if the abort signal fires during
  // the wait (ctx-aware). Resolves `false` on timeout.
  private interruptibleSleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.abortSignal?.aborted) {
        resolve(true);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.abortSignal?.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      this.abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async executeTools(
    toolUses: ToolUseBlock[],
    telemetry: AgentTelemetry,
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // Partition by adjacency: consecutive read-only tools form one parallel batch; write/command tools each get their own batch
    const batches = this.partitionToolCalls(toolUses);

    for (const batch of batches) {
      const batchEvents = await this.executeBatch(
        batch.blocks,
        batch.concurrent && batch.blocks.length > 1,
        telemetry,
      );
      events.push(...batchEvents);
    }

    return events;
  }

  private partitionToolCalls(
    toolUses: ToolUseBlock[],
  ): { concurrent: boolean; blocks: ToolUseBlock[] }[] {
    const batches: { concurrent: boolean; blocks: ToolUseBlock[] }[] = [];
    for (const tu of toolUses) {
      const tool = this.registry.get(tu.toolName);
      // Safety is determined by the actual arguments of this call, not just the tool category.
      // ls and rm are both Bash — the former can run concurrently with ReadFile, the latter must be exclusive.
      const safe = tool
        ? (tool.isConcurrencySafe?.(tu.arguments ?? {}) ?? tool.category === "read")
        : false;

      if (safe && batches.length > 0 && batches[batches.length - 1].concurrent) {
        batches[batches.length - 1].blocks.push(tu);
      } else {
        batches.push({ concurrent: safe, blocks: [tu] });
      }
    }
    return batches;
  }

  // executeBatch runs a set of tool calls through permission checks, hooks,
  // and the streaming executor. When parallel is true all calls run
  // concurrently; otherwise they run one at a time.
  private async executeBatch(
    toolUses: ToolUseBlock[],
    parallel: boolean,
    telemetry: AgentTelemetry,
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const executor = new StreamingExecutor(
      this.registry,
      {
        workDir: this.workDir,
        sessionId: this.sessionId,
        taskManager: this.taskManager,
        abortSignal: this.abortSignal,
        fileHistory: this.fileHistory,
        fileStateCache: this.fileStateCache,
        permissionChecker: this.checker,
        onPermissionRequest: this.onPermissionRequest,
      },
      telemetry,
    );

    for (const tu of toolUses) {
      // Once the user interrupts, don't launch the remaining calls; report
      // them as interrupted so every tool_use keeps a paired tool_result.
      if (this.abortSignal?.aborted) {
        events.push({
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: "Error: command interrupted",
          isError: true,
          elapsed: 0,
        });
        continue;
      }

      if (this.toolFilter && !this.toolFilter(tu.toolName)) {
        events.push({
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: `Tool '${tu.toolName}' is not available to this agent.`,
          isError: true,
          elapsed: 0,
        });
        continue;
      }

      // Fire pre-tool hooks
      if (this.hookEngine) {
        const hookResult = await this.hookEngine.firePreToolHooks(tu.toolName, tu.arguments, {
          workDir: this.workDir,
          abortSignal: this.abortSignal,
        });
        if (hookResult.rejected) {
          events.push({
            type: "tool_result",
            toolName: tu.toolName,
            toolId: tu.toolUseId,
            output: `Rejected by hook: ${hookResult.reason}`,
            isError: true,
            elapsed: 0,
          });
          continue;
        }
      }

      const tool = this.registry.get(tu.toolName);
      const category = tool?.category ?? "command";

      const target = tool instanceof McpCallTool ? tool.resolveTarget(tu.arguments) : undefined;
      if (
        target &&
        (!this.registry.get(target.name) || (this.toolFilter && !this.toolFilter(target.name)))
      ) {
        events.push({
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: `Tool '${target.name}' is not available to this agent.`,
          isError: true,
          elapsed: 0,
        });
        continue;
      }
      const decisions = [this.checker.check(tu.toolName, category, tu.arguments)];
      if (target) {
        decisions.push(
          this.checker.check(target.name, target.category, asRecord(tu.arguments.arguments ?? {})),
        );
      }
      const decision =
        decisions.find((d) => d.effect === "deny") ??
        decisions.find((d) => d.effect === "ask") ??
        decisions[0];

      if (decision.effect === "deny") {
        events.push({
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: `Permission denied: ${decision.reason}. This operation has been blocked by the security policy. Inform the user that the command was denied; do not describe what the command would do.`,
          isError: true,
          elapsed: 0,
        });
        continue;
      }

      if (decision.effect === "ask" && !this.onPermissionRequest) {
        events.push({
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output:
            "Permission required, but this agent has no approval handler. The tool was not executed.",
          isError: true,
          elapsed: 0,
        });
        continue;
      }
      if (decision.effect === "ask" && this.onPermissionRequest) {
        let response: "allow" | "deny" | "allowAlways";
        try {
          response = await this.onPermissionRequest(
            tu.toolName,
            tu.arguments,
            decision,
            tu.toolUseId,
          );
          if (response === "allowAlways" && !this.abortSignal?.aborted) {
            this.checker.allowAlways(tu.toolName, tu.arguments);
          }
        } catch (err) {
          events.push({
            type: "tool_result",
            toolName: tu.toolName,
            toolId: tu.toolUseId,
            output: `Permission request failed: ${asErrorString(err)}. The tool was not executed.`,
            isError: true,
            elapsed: 0,
          });
          continue;
        }
        if (response === "deny") {
          events.push({
            type: "tool_result",
            toolName: tu.toolName,
            toolId: tu.toolUseId,
            output: REJECTED_TOOL_RESULT,
            isError: true,
            elapsed: 0,
          });
          continue;
        }
      }

      executor.submit(tu.toolUseId, tu.toolName, tu.arguments);

      // Sequential mode: collect after every single call.
      if (!parallel) {
        const batchResults = await executor.collectResults();
        for (const r of batchResults) {
          await this.processToolResult(r, toolUses, events);
        }
      }
    }

    // Parallel mode: collect all results at once.
    if (parallel) {
      const batchResults = await executor.collectResults();
      for (const r of batchResults) {
        await this.processToolResult(r, toolUses, events);
      }
    }

    return events;
  }

  // processToolResult handles a single executor result: records file-read
  // snapshots, emits the tool_result event, and fires post-tool hooks.
  private async processToolResult(
    r: {
      toolId: string;
      toolName: string;
      result: ToolResult;
      elapsed: number;
    },
    toolUses: ToolUseBlock[],
    events: AgentEvent[],
  ): Promise<void> {
    // Snapshot exactly what text ReadFile returned so recovery stays aligned with what the model saw.
    if (!r.result.isError && r.toolName === "ReadFile" && !r.result.contentBlocks?.length) {
      const tu = toolUses.find((t) => t.toolUseId === r.toolId);
      const p = strArg(tu?.arguments ?? {}, "file_path");
      if (p) {
        this.recoveryState.recordFileRead(p, r.result.output);
      }
    }

    events.push({
      type: "tool_result",
      toolName: r.toolName,
      toolId: r.toolId,
      output: r.result.output,
      ...(r.result.contentBlocks?.length ? { contentBlocks: r.result.contentBlocks } : {}),
      isError: r.result.isError,
      elapsed: r.elapsed,
    });

    // Fire post-tool hooks; queue any output as a notification.
    if (this.hookEngine) {
      const args = toolUses.find((tu) => tu.toolUseId === r.toolId)?.arguments;
      const hookResults = await this.hookEngine.fire(
        "post_tool_use",
        {
          event: "post_tool_use",
          toolName: r.toolName,
          args,
          filePath: strArg(args ?? {}, "file_path", strArg(args ?? {}, "path", "")),
          message: r.result.output,
        },
        { workDir: this.workDir, abortSignal: this.abortSignal },
      );
      for (const hr of hookResults) {
        if (hr.output) {
          this.hookEngine.recordNotification(hr.output);
        }
      }
    }
  }

  /**
   * Persist the most recently appended conversation message to the session log.
   *
   * Persistence lives in the main loop rather than in individual frontends: both
   * the UI and Web share the same recording path, ensuring intermediate assistant
   * text and complete tool-call chains are captured for session restoration.
   * Skipped when sessionId is empty (one-shot invocations, sub-agents).
   */
  private persistLastMessage(): void {
    if (!this.workDir || !this.sessionId) {
      return;
    }
    const msgs = this.conversation.getMessages();
    if (msgs.length === 0) {
      return;
    }
    const last = msgs[msgs.length - 1];
    saveMessage(this.workDir, this.sessionId, {
      role: last.role,
      content: last.content,
      timestamp: Math.floor(Date.now() / 1000),
      ...(last.toolUses?.length ? { tool_uses: toolUsesToRecords(last.toolUses) } : {}),
      ...(last.toolResults?.length ? { tool_results: toolResultsToRecords(last.toolResults) } : {}),
    });
  }
}

// Accept delta-seconds and HTTP dates, bounding timers to avoid overflow.
function parseRetryAfter(header?: string): number {
  if (!header?.trim()) {
    return 5000;
  }
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return Math.min(Number(value) * 1000, MAX_RETRY_DELAY_MS);
  }
  const date = /^[A-Za-z]{3},/.test(value) ? Date.parse(value) : NaN;
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
  }
  return 5000;
}
