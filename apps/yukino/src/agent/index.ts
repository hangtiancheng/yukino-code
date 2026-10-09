import { existsSync, rmSync } from "node:fs";

import type { AgentEvent } from "./events.js";
import { StreamingExecutor } from "./streaming-executor.js";

import { registerExitCleanup } from "@/bootstrap/exit-cleanup.js";
import {
  manageContext,
  forceCompact,
  AutoCompactTrackingState,
} from "@/compact/compact.js";
import { RecoveryState } from "@/compact/recovery.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import type { ToolUseBlock, ToolResultBlock } from "@/conversation/index.js";
import { REJECTED_TOOL_RESULT } from "@/conversation/pairing.js";
import type { FileHistory } from "@/file-history/index.js";
import { GoalManager } from "@/goal/index.js";
import type { HookEngine, EventName } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError, LLMError, RateLimitError } from "@/llm/errors.js";
import type { UsageInfo } from "@/llm/events.js";
import { llmRetryDelay } from "@/llm/retry.js";
import type { RecallResult } from "@/memory/manager.js";
import type { PermissionChecker } from "@/permissions/index.js";
import { requestToolPermission } from "@/permissions/request.js";
import { createPlanPath, getOrCreatePlanPath } from "@/plan-file/index.js";
import { coordinatorReminder } from "@/prompt/coordinator.js";
import { buildPlanModeReminder } from "@/prompt/plan-mode.js";
import {
  buildDeferredToolGuidance,
  buildToolGuidance,
  DEFERRED_GUIDANCE_MARKER,
  TOOL_GUIDANCE_MARKER,
} from "@/prompt/tools.js";
import {
  saveMessage,
  saveCompactBoundary,
  sessionLineCount,
  messageToKeptRecord,
} from "@/session/index.js";
import {
  getSessionArtifactsDir,
  getSessionFilePath,
  newSessionId,
} from "@/session/index.js";
import type { TaskManager } from "@/subagent/task-manager.js";
import {
  endAgentTelemetry,
  observeLlmStream,
  startAgentTelemetry,
  type AgentTelemetry,
  type AgentOutcome,
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

type ToolResultEvent = Extract<AgentEvent, { type: "tool_result" }>;

// When the model stops on max_tokens, escalate its output ceiling once toward
// this value (capped at the context window), then attempt a bounded number of
// multi-turn recoveries.
const MAX_TOKENS_CEILING = 64000;
const MAX_TOKENS_RECOVERIES = 3;
// Per-result spill threshold before entering conversation history: once a
// tool result's character count exceeds this value the full content is written
// to disk (rather than truncated outright, to avoid losing critical
// information) and only a preview plus the file path is retained in history.
// Set to 50000 (rather than a smaller value) so the model can see enough
// content in one pass without needing an extra ReadFile round-trip to view the
// full result.
const MAX_OUTPUT_CHARS = 50000;

const anonymousArtifactSessions = new WeakMap<ConversationManager, string>();

export interface AgentConfig {
  agentName?: string;
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  cwd: string;
  sessionId?: string;
  goalManager?: GoalManager;
  shouldContinueGoal?: () => boolean;
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
  // Checked each turn so the dispatch guidance keeps appearing while the tool
  // set is narrowed. Like the tool filter it is config-driven and stays in
  // effect for the whole session — it does not end when a team is torn down.
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
   * Receives the memory paths surfaced this turn. Since a new Agent is created
   * for every run, the caller maintains the injected set across runs.
   */
  onMemoriesSurfaced?: (paths: string[]) => void;
  onPermissionRequest?: PermissionRequestHandler;
}

export class Agent {
  // Deferred tool names announced to the model last time, in lexicographic order.
  // Compared against the current pool to skip re-injection when nothing changed.
  private client: LLMClient;
  private registry: ToolRegistry;
  private checker: PermissionChecker;
  private conversation: ConversationManager;
  private cwd: string;
  private sessionId: string;
  private sessionFilePath: string;
  private goalManager?: GoalManager;
  private shouldContinueGoal?: () => boolean;
  private hookEngine?: HookEngine;
  private fileHistory?: FileHistory;
  private fileStateCache?: FileStateCache;
  private abortSignal?: AbortSignal;
  private contextWindow: number;
  private maxOutput: number;
  private configuredMaxOutput?: number;
  private recoveryState: RecoveryState;
  private maxIterations: number;
  private notificationFn?: () => string[];
  private taskManager?: TaskManager | null;
  private onLoopComplete?: (conversation: ConversationManager) => void;
  private compactTracking = new AutoCompactTrackingState();

  private onPermissionRequest?: AgentConfig["onPermissionRequest"];
  private agentName: string;
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
    this.agentName = config.agentName ?? "main";
    this.client = config.client;
    this.registry = config.registry;
    this.checker = config.checker;
    this.conversation = config.conversation;
    this.cwd = config.cwd;
    this.sessionId = config.sessionId ?? "";
    this.goalManager =
      config.goalManager ??
      (config.sessionId
        ? new GoalManager(config.cwd, config.sessionId)
        : undefined);
    this.shouldContinueGoal = config.shouldContinueGoal;
    this.sessionFilePath = config.sessionId
      ? getSessionFilePath(config.cwd, config.sessionId)
      : "";
    this.hookEngine = config.hookEngine;
    this.fileHistory = config.fileHistory;
    this.fileStateCache = config.fileStateCache;
    this.abortSignal = config.abortSignal;
    this.contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.maxOutput = config.maxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.configuredMaxOutput = config.maxOutput;
    this.recoveryState = config.recoveryState ?? new RecoveryState();
    this.maxIterations = config.maxIterations ?? 0;
    this.notificationFn = config.notificationFn;
    this.taskManager = config.taskManager;
    this.onLoopComplete = config.onLoopComplete;
    this.onPermissionRequest = config.onPermissionRequest;
    this.activeSkills = config.activeSkills ?? new Map<string, string>();
    this.toolFilter = config.toolFilter;
    this.steeringQueue = [];
    this.coordinatorActiveFn = config.coordinatorActiveFn;
    this.instructions = config.instructions ?? "";
    this.memoryContent = config.memoryContent ?? "";
    this.skillSection = config.skillSection ?? "";
    this.skillDeltaFn = config.skillDeltaFn;
    this.memoryRecallPromise = config.memoryRecallPromise;
    this.onMemoriesSurfaced = config.onMemoriesSurfaced;
    // Stash the prefetch result and set the flag as soon as it settles (resolves or rejects), so the main loop can poll without awaiting
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

  private toolResultSessionId(): string {
    if (this.sessionId) {
      return this.sessionId;
    }
    let sessionId = anonymousArtifactSessions.get(this.conversation);
    if (!sessionId) {
      sessionId = newSessionId();
      anonymousArtifactSessions.set(this.conversation, sessionId);
      const artifactsDir = getSessionArtifactsDir(sessionId);
      // Keep anonymous outputs available to later worker turns and the parent until exit.
      registerExitCleanup(() => {
        rmSync(artifactsDir, { recursive: true, force: true });
      });
    }
    return sessionId;
  }

  /**
   * Queue a user message for pi-style steering: it is injected into the
   * conversation at the next turn boundary — after the current assistant
   * turn's tool results (or right after the turn when there were none),
   * before the next LLM call — instead of waiting for the whole run to
   * finish.
   */
  steer(text: string): void {
    const trimmed = text.trim();
    if (trimmed) {
      this.steeringQueue.push(trimmed);
    }
  }

  /** Take all queued steering messages (called at turn boundaries and on teardown). */
  drainSteering(): string[] {
    const drained = this.steeringQueue;
    this.steeringQueue = [];
    return drained;
  }

  /** Remove a queued steering message before delivery (e.g. recalled into the editor). */
  removeSteering(text: string): boolean {
    const index = this.steeringQueue.indexOf(text);
    if (index === -1) {
      return false;
    }
    this.steeringQueue.splice(index, 1);
    return true;
  }

  /** Inject queued steering messages as user messages, emitting one event each. */
  private *deliverSteering(): Generator<AgentEvent, string[], unknown> {
    const texts: string[] = [];
    while (!this.abortSignal?.aborted) {
      const text = this.steeringQueue.shift();
      if (text === undefined) {
        break;
      }
      this.conversation.addUserMessage(text);
      this.persistLastMessage();
      texts.push(text);
      yield { type: "steering_delivered", text };
    }
    return texts;
  }

  private steeringQueue: string[] = [];
  private restoreContext(): void {
    const skills = [
      this.skillSection,
      ...[...this.activeSkills].map(
        ([name, body]) => `## Active skill: ${name}\n${body}`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    this.conversation.injectLongTermMemory(
      this.instructions,
      this.memoryContent,
      skills,
    );
  }

  async *run(): AsyncGenerator<AgentEvent> {
    const telemetry = startAgentTelemetry(this.sessionId, this.client);
    let outcome: AgentOutcome = "interrupted";
    let maxTokensEscalated = false;
    const initialMaxOutput = this.maxOutput;
    let outputRecoveries = 0;
    let transientRetries = 0;
    let iteration = 0;

    try {
      this.restoreContext();
      if (this.fileHistory) {
        const latest = this.conversation
          .getMessages()
          .findLast((message) => message.role === "user");
        this.fileHistory.makeSnapshot(
          this.conversation.len(),
          typeof latest?.content === "string"
            ? latest.content
            : "Before agent run",
          sessionLineCount(this.sessionFilePath),
        );
      }
      this.goalManager?.beginTurn();
      await this.fireLifecycle("session_start");
      let looping = true;
      while (looping) {
        if (this.abortSignal?.aborted) {
          yield { type: "loop_complete", stopReason: "interrupted" };
          return;
        }
        if (this.goalManager?.get()?.status === "budget_limited") {
          yield {
            type: "stream_text",
            text: `\n${this.goalManager.format()}\n`,
          };
          yield { type: "loop_complete", stopReason: "budget_limited" };
          outcome = "completed";
          return;
        }
        iteration++;
        if (this.maxIterations > 0 && iteration > this.maxIterations) {
          outcome = "error";
          yield {
            type: "error",
            error: new Error(
              `Agent reached maximum iterations (${String(this.maxIterations)})`,
            ),
          };
          return;
        }

        let fullText = "";
        let receivedThinking = false;
        let receivedEnd = false;
        const thinkingBlocks: { thinking: string; signature: string }[] = [];
        const toolUses: ToolUseBlock[] = [];
        let stopReason = "end_turn";

        let lastUsage: UsageInfo | null = null;
        const toolSchemas = this.registry.getAllSchemas(
          this.client.protocol ?? "anthropic",
          this.toolFilter,
        );
        const toolSchemaNames = this.registry.listVisibleToolNames(
          this.client.protocol ?? "anthropic",
          this.toolFilter,
        );
        const toolGuidance = buildToolGuidance(toolSchemaNames);
        const guidance =
          toolGuidance ||
          (this.conversation.hasReminderContaining(TOOL_GUIDANCE_MARKER)
            ? `${TOOL_GUIDANCE_MARKER}\nNo tools are currently callable. Return findings or blockers without issuing tool calls.`
            : "");
        if (guidance) {
          this.conversation.addSystemReminderIfChanged(
            TOOL_GUIDANCE_MARKER,
            guidance,
          );
        }

        const coordinating = this.coordinatorActiveFn?.() ?? false;
        const goalReminder =
          this.goalManager?.reminder() ||
          (this.conversation.hasReminderContaining("<persistent-goal>")
            ? "<persistent-goal>\nNo persistent goal is set. Follow the current user request.\n</persistent-goal>"
            : "");
        if (goalReminder) {
          this.conversation.addSystemReminderIfChanged(
            "<persistent-goal>",
            goalReminder,
          );
        }
        // Plan mode: sync the plan path onto the checker (so the Layer-0 plan-file
        // write exception works however plan mode was entered) and inject a
        // per-turn reminder keeping the model read-only.
        if (this.checker.mode === "plan") {
          const planPath = this.checker.teammate
            ? this.checker.planFilePath || createPlanPath()
            : getOrCreatePlanPath(this.checker);
          this.checker.planFilePath = planPath;
          this.conversation.addSystemReminder(
            buildPlanModeReminder(planPath, existsSync(planPath), iteration, {
              canAskUser: toolSchemaNames.includes("AskUserQuestion"),
              canExitPlanMode: toolSchemaNames.includes("ExitPlanMode"),
              canSendMessage: toolSchemaNames.includes("SendMessage"),
              canWriteFile: toolSchemaNames.includes("WriteFile"),
              canEditFile: toolSchemaNames.includes("EditFile"),
              canDelegate: toolSchemaNames.includes("Agent"),
              isCoordinator: coordinating,
            }),
          );
        }

        // Coordinator mode: inject dispatch guidance while the tool set is narrowed.
        // Delivered via system-reminder rather than the system prompt: in long
        // sessions the initial constraint gets buried, so a per-turn reminder is
        // needed to pull the model back. Also, the system prompt is a cached
        // prefix — mutating it would invalidate the entire cache and re-incur cost.
        if (coordinating) {
          this.conversation.addSystemReminder(coordinatorReminder(iteration));
        }

        const deferredNames = this.registry
          .getDeferredToolNames()
          .filter((name) => !this.toolFilter || this.toolFilter(name));
        const deferredGuidance = buildDeferredToolGuidance(
          deferredNames,
          toolSchemaNames,
          this.registry.mcpLoadingMode === "dispatch",
        );
        const deferredReminder =
          deferredGuidance ||
          (this.conversation.hasReminderContaining(DEFERRED_GUIDANCE_MARKER)
            ? `${DEFERRED_GUIDANCE_MARKER}\nNo deferred tools can currently be discovered and invoked. Do not use earlier deferred-tool lists.`
            : "");
        if (deferredReminder) {
          this.conversation.addSystemReminderIfChanged(
            DEFERRED_GUIDANCE_MARKER,
            deferredReminder,
          );
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
            this.conversation.addSystemReminder(
              "The following skills became available:\n" + delta,
            );
          }
        }

        await this.fireLifecycle("turn_start");
        try {
          await this.fireLifecycle("pre_send");
          // Pre-send and turn-start prompts must reach the request they prepare.
          for (const note of this.hookEngine?.drainNotifications() ?? []) {
            this.conversation.addSystemReminder(note);
          }

          // Auto-compact when the window fills up.
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
            if (mc.boundary && this.sessionId) {
              saveCompactBoundary(this.cwd, this.sessionId, mc.boundary);
            }
            yield {
              type: "compact",
              message: mc.message,
              boundary: mc.boundary,
            };
          }
          if (mc.compacted) {
            this.restoreContext();
            if (guidance) {
              this.conversation.addSystemReminderIfChanged(
                TOOL_GUIDANCE_MARKER,
                guidance,
              );
            }
            if (deferredReminder) {
              this.conversation.addSystemReminderIfChanged(
                DEFERRED_GUIDANCE_MARKER,
                deferredReminder,
              );
            }
          }
          if (this.abortSignal?.aborted) {
            yield { type: "loop_complete", stopReason: "interrupted" };
            return;
          }

          try {
            // Initiate API call directly with the conversation — no need to rebuild
            const stream = observeLlmStream(
              this.client,
              this.client.stream(
                this.conversation,
                toolSchemas,
                this.abortSignal,
                {
                  maxOutputTokens: maxTokensEscalated
                    ? this.maxOutput
                    : this.configuredMaxOutput,
                },
              ),
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
                  receivedThinking = true;
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
                    ...(event.parseError
                      ? { parseError: event.parseError }
                      : {}),
                    ...(event.providerItemId
                      ? { providerItemId: event.providerItemId }
                      : {}),
                  });
                  yield {
                    type: "tool_use",
                    toolName: event.toolName,
                    toolId: event.toolId,
                    args: event.arguments,
                  };
                  break;

                case "stream_end":
                  receivedEnd = true;
                  stopReason = event.stopReason;
                  lastUsage = event.usage;
                  this.goalManager?.addTokens(
                    event.usage.inputTokens +
                      event.usage.outputTokens +
                      event.usage.cacheReadInputTokens +
                      event.usage.cacheCreationInputTokens,
                  );
                  yield { type: "usage", usage: event.usage };
                  break;
              }
            }
            if (!this.abortSignal?.aborted && !receivedEnd) {
              throw new LLMError(
                "Provider stream ended without a completion event",
              );
            }
          } catch (err) {
            if (this.abortSignal?.aborted) {
              if (fullText || thinkingBlocks.length > 0) {
                this.conversation.addAssistantFull(
                  fullText,
                  thinkingBlocks,
                  [],
                );
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
                  outcome = "error";
                  yield { type: "error", error: err };
                  return;
                }
                this.conversation.clearUsageAnchor();
                this.restoreContext();
                if (result.boundary && this.sessionId) {
                  saveCompactBoundary(
                    this.cwd,
                    this.sessionId,
                    result.boundary,
                  );
                }
                yield {
                  type: "compact",
                  message:
                    "Auto-compacted due to context length: " + result.message,
                  boundary: result.boundary,
                };
                continue;
              } catch {
                if (this.abortSignal?.aborted) {
                  yield { type: "loop_complete", stopReason: "interrupted" };
                  return;
                }
                outcome = "error";
                yield { type: "error", error: err };
                return;
              }
            }

            const waitMs = llmRetryDelay(err, transientRetries);
            // Some transports cannot retract streamed chunks. Replay only before visible output.
            if (
              waitMs !== undefined &&
              !fullText &&
              !receivedThinking &&
              thinkingBlocks.length === 0 &&
              toolUses.length === 0
            ) {
              transientRetries++;
              yield {
                type: "retry",
                reason:
                  err instanceof RateLimitError
                    ? "rate limited"
                    : "temporary provider failure",
                delay: waitMs,
              };
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
            outcome = "error";
            yield {
              type: "error",
              error: err instanceof Error ? err : new Error(asErrorString(err)),
            };
            return;
          }

          transientRetries = 0;
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
          if (stopReason === "max_tokens" && toolUses.length === 0) {
            const ceiling = Math.min(MAX_TOKENS_CEILING, this.contextWindow);
            if (!maxTokensEscalated && this.maxOutput < ceiling) {
              this.maxOutput = ceiling;
              maxTokensEscalated = true;
              if (fullText || thinkingBlocks.length > 0) {
                this.conversation.addAssistantFull(
                  fullText,
                  thinkingBlocks,
                  [],
                );
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
                this.persistLastMessage();
              }
              // Nothing produced at all: replay as-is — a thinking-only turn
              // is persisted above, and with truly zero output there is
              // nothing to resume from (an extra user prompt would also break
              // role alternation).
              yield {
                type: "retry",
                reason: "max_tokens escalation",
                delay: 0,
              };
              continue;
            } else if (outputRecoveries < MAX_TOKENS_RECOVERIES) {
              outputRecoveries++;
              if (fullText || thinkingBlocks.length > 0) {
                this.conversation.addAssistantFull(
                  fullText,
                  thinkingBlocks,
                  [],
                );
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
                this.persistLastMessage();
              }
              // Zero output: persisting an empty assistant turn (or stacking a
              // second user message) would corrupt the history; replay as-is
              // and let the recovery counter bound the retries.
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

          if (stopReason === "max_tokens") {
            for (const call of toolUses) {
              call.parseError =
                "The response hit the output token limit, so tool arguments may be truncated. Re-issue the call with complete arguments";
            }
          }
          if (this.goalManager?.get()?.status === "budget_limited") {
            for (const call of toolUses) {
              call.parseError =
                "Goal token budget reached; no further tools will be executed. Report existing progress.";
            }
          }

          // Some providers can end a turn without emitting any content. Do not
          // create or persist an empty assistant message: it adds no information
          // and can leave resumed histories with invalid role alternation.
          if (fullText || thinkingBlocks.length > 0 || toolUses.length > 0) {
            this.conversation.addAssistantFull(
              fullText,
              thinkingBlocks,
              toolUses,
            );
            this.persistLastMessage();
          }

          if (lastUsage) {
            this.conversation.recordUsageAnchor(
              lastUsage.inputTokens,
              lastUsage.outputTokens,
              lastUsage.cacheReadInputTokens,
              lastUsage.cacheCreationInputTokens,
            );
          }

          if (
            toolUses.length === 0 &&
            this.goalManager?.get()?.status === "budget_limited"
          ) {
            yield {
              type: "stream_text",
              text: `\n${this.goalManager.format()}\n`,
            };
            yield { type: "loop_complete", stopReason: "budget_limited" };
            outcome = "completed";
            return;
          }

          if (toolUses.length > 0) {
            const toolResultSessionId = this.toolResultSessionId();
            const results = new Map<string, ToolResultEvent>();
            for await (const result of this.executeTools(toolUses, telemetry)) {
              results.set(result.toolId, result);
              yield result;
            }

            // Readback results from spill files are exempt from spilling: if we
            // re-spill content the model just read back into a preview, it will
            // never see the full text and will loop between "read back" and "spill".
            const exemptIds = new Set<string>();
            for (const tu of toolUses) {
              if (
                isSpillReadback(
                  tu.toolName,
                  tu.arguments,
                  this.cwd,
                  toolResultSessionId,
                )
              ) {
                exemptIds.add(tu.toolUseId);
              }
            }

            const toolResults: ToolResultBlock[] = [];
            for (const tu of toolUses) {
              const r = results.get(tu.toolUseId);
              if (r) {
                const toolResult: ToolResultBlock = {
                  toolUseId: r.toolId,
                  content: r.output,
                  ...(r.contentBlocks?.length
                    ? { contentBlocks: r.contentBlocks }
                    : {}),
                  isError: r.isError,
                };
                if (
                  toolResult.content.length > MAX_OUTPUT_CHARS &&
                  !exemptIds.has(r.toolId)
                ) {
                  // Single result exceeds the limit: write to disk and replace its
                  // text fallback and rich text blocks with the same preview.
                  const replacement = persistLargeResult(
                    toolResultSessionId,
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
            applyBudget(toolResults, toolResultSessionId, exemptIds);
            // Only end the loop when ExitPlanMode actually succeeded: an errored
            // call (e.g. invoked outside plan mode) must flow back to the model as
            // a normal tool_result so it can self-correct instead of the turn
            // ending on a dangling error.
            const exitPlanSucceeded = toolUses.some((tu) => {
              if (tu.toolName !== "ExitPlanMode") {
                return false;
              }
              const result = results.get(tu.toolUseId);
              return result !== undefined && !result.isError;
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
            if (this.goalManager?.get()?.status === "budget_limited") {
              yield { type: "turn_complete" };
              yield {
                type: "stream_text",
                text: `\n${this.goalManager.format()}\n`,
              };
              yield { type: "loop_complete", stopReason: "budget_limited" };
              outcome = "completed";
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
              outcome = "completed";
              yield { type: "turn_complete" };
              yield { type: "loop_complete", stopReason: "end_turn" };
              return;
            }

            yield { type: "turn_complete" };

            // pi-style steering: messages queued mid-run are injected at the
            // turn boundary, after tool results and before the next LLM call.
            yield* this.deliverSteering();
          } else {
            // The model produced no tool calls, so the run would normally end.
            // Steering queued up to this point keeps it alive instead (pi-style).
            if (this.steeringQueue.length > 0) {
              yield { type: "turn_complete" };
              const steered = yield* this.deliverSteering();
              if (steered.length > 0 || this.abortSignal?.aborted) {
                continue;
              }
            }
            if (stopReason === "end_turn" || stopReason === "stop") {
              const prompt =
                this.checker.mode !== "plan" &&
                (this.shouldContinueGoal?.() ?? true)
                  ? this.goalManager?.continuation()
                  : null;
              if (prompt) {
                if (this.fileHistory) {
                  this.fileHistory.makeSnapshot(
                    this.conversation.len(),
                    fullText.slice(0, 60),
                    sessionLineCount(this.sessionFilePath),
                  );
                }
                yield { type: "turn_complete" };
                this.conversation.addUserMessage(prompt);
                this.persistLastMessage();
                this.goalManager?.beginTurn();
                continue;
              }
            }
            looping = false;
            outcome = "completed";
            if (this.fileHistory) {
              const summary =
                fullText.length > 60 ? fullText.slice(0, 60) + "..." : fullText;
              this.fileHistory.makeSnapshot(
                this.conversation.len(),
                summary,
                sessionLineCount(this.sessionFilePath),
              );
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
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      this.goalManager?.endRun();
      try {
        await this.fireLifecycle("session_end").catch((error: unknown) => {
          outcome = "error";
          throw error;
        });
      } finally {
        if (maxTokensEscalated) {
          this.maxOutput = initialMaxOutput;
        }
        endAgentTelemetry(
          telemetry,
          this.abortSignal?.aborted ? "interrupted" : outcome,
        );
      }
    }
  }

  // Fire a lifecycle hook event and queue any non-empty hook output as a
  // notification to be surfaced on the next turn. No-op without a HookEngine.
  private async fireLifecycle(
    event: EventName,
    message?: string,
  ): Promise<void> {
    if (!this.hookEngine) {
      return;
    }
    const results = await this.hookEngine.fire(
      event,
      { event, message },
      { cwd: this.cwd, abortSignal: this.abortSignal },
    );
    for (const r of results) {
      if (r.output) {
        this.hookEngine.recordNotification(r.output);
      }
    }
  }

  // Sleep for ms, resolving early with `true` if the abort signal fires during
  // the wait. Resolves `false` on timeout.
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

  private async *executeTools(
    toolUses: ToolUseBlock[],
    telemetry: AgentTelemetry,
  ): AsyncGenerator<ToolResultEvent> {
    const batches = this.partitionToolCalls(toolUses);
    for (const batch of batches) {
      yield* this.executeBatch(
        batch.blocks,
        batch.concurrent && batch.blocks.length > 1,
        telemetry,
      );
    }
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
        ? (tool.isConcurrencySafe?.(tu.arguments ?? {}) ??
          tool.category === "read")
        : false;

      if (
        safe &&
        batches.length > 0 &&
        batches[batches.length - 1].concurrent
      ) {
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
  private async *executeBatch(
    toolUses: ToolUseBlock[],
    parallel: boolean,
    telemetry: AgentTelemetry,
  ): AsyncGenerator<ToolResultEvent> {
    const callsById = new Map<string, ToolUseBlock>();
    const routedCalls = new Map<
      string,
      { name: string; args: Record<string, unknown> }
    >();
    const executor = new StreamingExecutor(
      this.registry,
      {
        cwd: this.cwd,
        sessionId: this.sessionId,
        goalManager: this.goalManager,
        taskManager: this.taskManager,
        abortSignal: this.abortSignal,
        fileHistory: this.fileHistory,
        fileStateCache: this.fileStateCache,
        permissionChecker: this.checker,
        onPermissionRequest: this.onPermissionRequest,
      },
      telemetry,
    );

    for (const block of toolUses) {
      const tu = { ...block };
      callsById.set(tu.toolUseId, tu);
      if (tu.parseError) {
        executor.submit(tu.toolUseId, tu.toolName, tu.arguments, tu.parseError);
        if (!parallel) {
          for await (const result of executor.runPending()) {
            yield await this.processToolResult(
              result,
              callsById.get(result.toolId),
            );
          }
        }
        continue;
      }

      // Once the user interrupts, don't launch the remaining calls; report
      // them as interrupted so every tool_use keeps a paired tool_result.
      if (this.abortSignal?.aborted) {
        yield {
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: "Error: command interrupted",
          isError: true,
          elapsed: 0,
        };
        continue;
      }

      if (this.toolFilter && !this.toolFilter(tu.toolName)) {
        yield {
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: `Tool '${tu.toolName}' is not available to this agent.`,
          isError: true,
          elapsed: 0,
        };
        continue;
      }

      const tool = this.registry.get(tu.toolName);
      if (tool instanceof McpCallTool) {
        tu.arguments = tool.prepareArguments(tu.arguments);
      }
      const target =
        tool instanceof McpCallTool
          ? tool.resolveTarget(tu.arguments)
          : undefined;
      if (target && this.toolFilter && !this.toolFilter(target.name)) {
        yield {
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: `Tool '${target.name}' is not available to this agent.`,
          isError: true,
          elapsed: 0,
        };
        continue;
      }
      const permissionCalls = [
        {
          name: tu.toolName,
          category: tool?.category ?? "command",
          args: tu.arguments,
        },
        ...(target
          ? [
              {
                name: target.name,
                category: target.category,
                args: asRecord(tu.arguments.arguments ?? {}),
              },
            ]
          : []),
      ];

      let rejected = false;
      if (this.hookEngine) {
        for (const call of permissionCalls) {
          const hookResult = await this.hookEngine.firePreToolHooks(
            call.name,
            call.args,
            { cwd: this.cwd, abortSignal: this.abortSignal },
          );
          if (hookResult.rejected) {
            yield {
              type: "tool_result",
              toolName: tu.toolName,
              toolId: tu.toolUseId,
              output: `Rejected by hook: ${hookResult.reason}`,
              isError: true,
              elapsed: 0,
            };
            rejected = true;
            break;
          }
        }
      }
      if (rejected) {
        continue;
      }
      const decisions = permissionCalls.map((call) =>
        this.checker.check(call.name, call.category, call.args),
      );
      const decision =
        decisions.find((d) => d.effect === "deny") ??
        decisions.find((d) => d.effect === "ask") ??
        decisions[0];

      if (decision.effect === "deny") {
        yield {
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: `Permission denied: ${decision.reason}. This operation has been blocked by the security policy. Inform the user that the command was denied; do not describe what the command would do.`,
          isError: true,
          elapsed: 0,
        };
        continue;
      }

      if (decision.effect === "ask" && !this.onPermissionRequest) {
        yield {
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output:
            "Permission required, but this agent has no approval handler. The tool was not executed.",
          isError: true,
          elapsed: 0,
        };
        continue;
      }
      if (decision.effect === "ask" && this.onPermissionRequest) {
        let response: "allow" | "deny" | "allowAlways";
        try {
          response = await requestToolPermission(
            this.onPermissionRequest,
            tu.toolName,
            tu.arguments,
            decision,
            tu.toolUseId,
            this.abortSignal,
            { agentName: this.agentName, cwd: this.cwd },
          );
          if (response === "allowAlways" && !this.abortSignal?.aborted) {
            for (const [index, call] of permissionCalls.entries()) {
              if (decisions[index].effect === "ask") {
                this.checker.allowAlways(call.name, call.args);
              }
            }
          }
        } catch (err) {
          yield {
            type: "tool_result",
            toolName: tu.toolName,
            toolId: tu.toolUseId,
            output: `Permission request failed: ${asErrorString(err)}. The tool was not executed.`,
            isError: true,
            elapsed: 0,
          };
          continue;
        }
        if (response === "deny") {
          yield {
            type: "tool_result",
            toolName: tu.toolName,
            toolId: tu.toolUseId,
            output: REJECTED_TOOL_RESULT,
            isError: true,
            elapsed: 0,
          };
          continue;
        }
      }

      if (
        target &&
        typeof tu.arguments.arguments === "object" &&
        tu.arguments.arguments !== null &&
        !Array.isArray(tu.arguments.arguments)
      ) {
        routedCalls.set(tu.toolUseId, {
          name: target.name,
          args: asRecord(tu.arguments.arguments ?? {}),
        });
      }
      executor.submit(tu.toolUseId, tu.toolName, tu.arguments);

      if (!parallel) {
        for await (const result of executor.runPending()) {
          yield await this.processToolResult(
            result,
            callsById.get(result.toolId),
            routedCalls.get(result.toolId),
          );
        }
      }
    }

    if (parallel) {
      for await (const result of executor.runPending()) {
        yield await this.processToolResult(
          result,
          callsById.get(result.toolId),
          routedCalls.get(result.toolId),
        );
      }
    }
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
    toolUse: ToolUseBlock | undefined,
    routedCall?: { name: string; args: Record<string, unknown> },
  ): Promise<ToolResultEvent> {
    // Snapshot exactly what text ReadFile returned so recovery stays aligned with what the model saw.
    if (
      !r.result.isError &&
      r.toolName === "ReadFile" &&
      !r.result.contentBlocks?.length
    ) {
      const p = strArg(toolUse?.arguments ?? {}, "file_path");
      if (p) {
        this.recoveryState.recordFileRead(p, r.result.output);
      }
    }

    const event: ToolResultEvent = {
      type: "tool_result",
      toolName: r.toolName,
      toolId: r.toolId,
      output: r.result.output,
      ...(r.result.contentBlocks?.length
        ? { contentBlocks: r.result.contentBlocks }
        : {}),
      isError: r.result.isError,
      elapsed: r.elapsed,
    };

    // Fire post-tool hooks; queue any output as a notification.
    if (this.hookEngine) {
      if (routedCall) {
        await this.firePostToolHooks(
          routedCall.name,
          routedCall.args,
          r.result.output,
        );
      }
      await this.firePostToolHooks(
        r.toolName,
        toolUse?.arguments,
        r.result.output,
      );
    }
    return event;
  }

  private async firePostToolHooks(
    toolName: string,
    args: Record<string, unknown> | undefined,
    output: string,
  ): Promise<void> {
    if (this.hookEngine) {
      const hookResults = await this.hookEngine.fire(
        "post_tool_use",
        {
          event: "post_tool_use",
          toolName,
          args,
          filePath: strArg(
            args ?? {},
            "file_path",
            strArg(args ?? {}, "path", ""),
          ),
          message: output,
        },
        { cwd: this.cwd, abortSignal: this.abortSignal },
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
    if (!this.cwd || !this.sessionId) {
      return;
    }
    const msgs = this.conversation.getMessages();
    if (msgs.length === 0) {
      return;
    }
    const last = msgs[msgs.length - 1];
    saveMessage(this.cwd, this.sessionId, {
      ...messageToKeptRecord(last),
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
}
