import { existsSync, rmSync } from "node:fs";

import {
  MAX_OUTPUT_CHARS,
  MAX_TOKENS_CEILING,
  MAX_TOKENS_RECOVERIES,
  PERSISTENT_GOAL_MARKER,
  WORKING_DIRECTORY_MARKER,
} from "./constants.js";
import type { AgentEvent } from "./events.js";
import {
  GOAL_BUDGET_LIMITED_NOTICE,
  MAX_TOKENS_RECOVERY_PROMPT,
  MAX_TOKENS_RESUME_PROMPT,
  MAX_TOKENS_TRUNCATED_ARGS_NOTICE,
  NEW_SKILLS_REMINDER_PREFIX,
  NO_CALLABLE_TOOLS_REMINDER,
  NO_DEFERRED_TOOLS_REMINDER,
  NO_PERSISTENT_GOAL_REMINDER,
  buildPermissionDeniedOutput,
  buildWorkingDirectoryReminder,
} from "./prompts.js";
import { StreamingExecutor } from "./streaming-executor.js";
import { registerExitCleanup } from "@yukino.js/bootstrap/exit-cleanup.js";
import {
  manageContext,
  forceCompact,
  AutoCompactTrackingState,
} from "@yukino.js/compact/compact.js";
import { RecoveryState } from "@yukino.js/compact/recovery.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "@yukino.js/config/constants.js";
import { REJECTED_TOOL_RESULT } from "@yukino.js/conversation/constants.js";
import type { ConversationManager } from "@yukino.js/conversation";
import type {
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
} from "@yukino.js/conversation";
import type { FileHistory } from "@yukino.js/file-history";
import { GoalManager } from "@yukino.js/goal";
import { recordInput, type InputEntry } from "@yukino.js/history";
import type { HookEngine, EventName } from "@yukino.js/hooks";
import type { LLMClient } from "@yukino.js/llm/client.js";
import {
  ContextTooLongError,
  LLMError,
  RateLimitError,
} from "@yukino.js/llm/errors.js";
import type { UsageInfo } from "@yukino.js/llm/events.js";
import { llmRetryDelay } from "@yukino.js/llm/retry.js";
import { loadInstructions } from "@yukino.js/memory/instructions.js";
import type { RecallResult } from "@yukino.js/memory/manager.js";
import type { PermissionChecker } from "@yukino.js/permissions";
import { requestToolPermission } from "@yukino.js/permissions/request.js";
import { createPlanPath, getOrCreatePlanPath } from "@yukino.js/plan-file";
import {
  DEFERRED_GUIDANCE_MARKER,
  TOOL_GUIDANCE_MARKER,
} from "@yukino.js/prompt/constants.js";
import { coordinatorReminder } from "@yukino.js/prompt/coordinator.js";
import { buildPlanModeReminder } from "@yukino.js/prompt/plan-mode.js";
import {
  buildDeferredToolGuidance,
  buildToolGuidance,
} from "@yukino.js/prompt/tools.js";
import {
  saveTranscriptMessage,
  saveMessage,
  saveTranscriptCompactBoundary,
  sessionLineCount,
  messageToKeptRecord,
} from "@yukino.js/session";
import {
  getSessionArtifactsDir,
  getSessionFilePath,
  newSessionId,
} from "@yukino.js/session";
import type { TaskManager } from "@yukino.js/subagent/task-manager.js";
import {
  endAgentTelemetry,
  observeLlmStream,
  startAgentTelemetry,
  type AgentTelemetry,
  type AgentOutcome,
} from "@yukino.js/telemetry/instrumentation.js";
import {
  applyBudget,
  isSpillReadback,
  persistLargeResult,
  replaceToolResultContent,
} from "@yukino.js/tool-result";
import { COMMAND_INTERRUPTED_ERROR } from "@yukino.js/tools/constants.js";
import type { FileStateCache } from "@yukino.js/tools/file-state-cache.js";
import { McpCallTool } from "@yukino.js/tools/mcp-call.js";
import type { ToolRegistry } from "@yukino.js/tools/registry.js";
import type {
  PermissionRequestHandler,
  ToolResult,
} from "@yukino.js/tools/types.js";
import { asErrorString, asRecord, strArg } from "@yukino.js/utils";

export * from "./constants.js";
// Submodule namespaces for library consumers (Agent.<Sub>.*).
export * from "./events.js";
export * from "./prompts.js";
export * from "./streaming-executor.js";

type ToolResultEvent = Extract<AgentEvent, { type: "tool_result" }>;

const anonymousArtifactSessions = new WeakMap<ConversationManager, string>();

export interface AgentConfig {
  agentName?: string;
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  cwd: string;
  sessionId?: string;
  transcriptPath?: string;
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
  // Project instructions and memory content, need re-injection after compaction.
  // A function form re-reads the current content at each (re)injection, so a
  // long-lived host never injects a stale startup snapshot.
  instructions?: string | (() => string);
  memoryContent?: string | (() => string);
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
  private initialCwd: string;

  private get cwd(): string {
    return this.checker.worktreeSession?.path ?? this.initialCwd;
  }
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
  private instructions: string | (() => string);
  private memoryContent: string | (() => string);
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
    this.initialCwd = config.cwd;
    this.sessionId = config.sessionId ?? "";
    this.goalManager =
      config.goalManager ??
      (config.sessionId
        ? new GoalManager(config.cwd, config.sessionId)
        : undefined);
    this.shouldContinueGoal = config.shouldContinueGoal;
    this.sessionFilePath =
      config.transcriptPath ??
      (config.sessionId
        ? getSessionFilePath(config.cwd, config.sessionId)
        : "");
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
  steer(text: string, input?: InputEntry): InputEntry | undefined {
    const trimmed = text.trim();
    if (trimmed) {
      const entry =
        input ??
        recordInput({
          text: trimmed,
          cwd: this.initialCwd,
          sessionId: this.sessionId || null,
          source: "sdk",
        });
      this.steeringQueue.push({ text: trimmed, input: entry });
      return entry;
    }
  }

  /** Take all queued steering messages (called at turn boundaries and on teardown). */
  drainSteering(): SteeringMessage[] {
    const drained = this.steeringQueue;
    this.steeringQueue = [];
    return drained;
  }

  /** Remove a queued steering message before delivery (e.g. recalled into the editor). */
  removeSteering(inputId: string): boolean {
    const index = this.steeringQueue.findIndex(
      (message) => message.input.id === inputId,
    );
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
      const message = this.steeringQueue.shift();
      if (message === undefined) {
        break;
      }
      const { text, input } = message;
      this.conversation.addUserMessage(text, input);
      this.persistLastMessage();
      texts.push(text);
      yield { type: "steering_delivered", text, inputId: input.id };
    }
    return texts;
  }

  private steeringQueue: SteeringMessage[] = [];
  private restoreContext(): void {
    const skills = [
      this.skillSection,
      ...[...this.activeSkills].map(
        ([name, body]) => `## Active skill: ${name}\n${body}`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    const instructions =
      typeof this.instructions === "function"
        ? this.instructions()
        : this.instructions;
    const memoryContent =
      typeof this.memoryContent === "function"
        ? this.memoryContent()
        : this.memoryContent;
    this.conversation.injectLongTermMemory(instructions, memoryContent, skills);
  }

  async *run(): AsyncGenerator<AgentEvent> {
    const telemetry = startAgentTelemetry(this.sessionId, this.client);
    let outcome: AgentOutcome = "interrupted";
    let maxTokensEscalated = false;
    const initialMaxOutput = this.maxOutput;
    let outputRecoveries = 0;
    let transientRetries = 0;
    let iteration = 0;
    let summarizingGoal = false;

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
        if (
          this.goalManager &&
          (summarizingGoal ||
            this.goalManager.get()?.status === "budget_limited")
        ) {
          const canSummarize =
            !summarizingGoal &&
            this.checker.mode !== "plan" &&
            (this.shouldContinueGoal?.() ?? true) &&
            this.steeringQueue.length === 0 &&
            this.goalManager.get()?.budgetSummaryPending;
          if (!canSummarize) {
            yield {
              type: "stream_text",
              text: `\n${this.goalManager.format()}\n`,
            };
            yield { type: "loop_complete", stopReason: "budget_limited" };
            outcome = "completed";
            return;
          }
          summarizingGoal = true;
        }
        iteration++;
        if (
          !summarizingGoal &&
          this.maxIterations > 0 &&
          iteration > this.maxIterations
        ) {
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
        const thinkingBlocks: ThinkingBlock[] = [];
        const toolUses: ToolUseBlock[] = [];
        let stopReason = "end_turn";

        let lastUsage: UsageInfo | null = null;
        const toolFilter = summarizingGoal ? () => false : this.toolFilter;
        const toolSchemas = this.registry.getAllSchemas(
          this.client.protocol ?? "anthropic",
          toolFilter,
        );
        const toolSchemaNames = this.registry.listVisibleToolNames(
          this.client.protocol ?? "anthropic",
          toolFilter,
        );
        const coordinating = this.coordinatorActiveFn?.() ?? false;
        const toolGuidance = buildToolGuidance(toolSchemaNames, coordinating);
        const guidance =
          toolGuidance ||
          (this.conversation.hasReminderContaining(TOOL_GUIDANCE_MARKER)
            ? `${TOOL_GUIDANCE_MARKER}\n${NO_CALLABLE_TOOLS_REMINDER}`
            : "");
        if (guidance) {
          this.conversation.addSystemReminderIfChanged(
            TOOL_GUIDANCE_MARKER,
            guidance,
          );
        }

        const worktree = this.checker.worktreeSession;
        if (
          worktree ||
          this.conversation.hasReminderContaining(WORKING_DIRECTORY_MARKER)
        ) {
          this.conversation.addSystemReminderIfChanged(
            WORKING_DIRECTORY_MARKER,
            buildWorkingDirectoryReminder(
              this.cwd,
              worktree?.branch,
              loadInstructions(this.cwd),
            ),
          );
        }

        const goalReminder =
          this.goalManager?.reminder() ||
          (this.conversation.hasReminderContaining(PERSISTENT_GOAL_MARKER)
            ? NO_PERSISTENT_GOAL_REMINDER
            : "");
        if (goalReminder) {
          this.conversation.addSystemReminderIfChanged(
            PERSISTENT_GOAL_MARKER,
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
              isSubagent: this.checker.isSubagent,
              isTeammate: this.checker.teammate,
              requiresLeaderPlanApproval:
                this.checker.requiresLeaderPlanApproval,
              readOnly: this.checker.readOnly,
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

        const deferredNames = summarizingGoal
          ? []
          : this.registry
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
            ? `${DEFERRED_GUIDANCE_MARKER}\n${NO_DEFERRED_TOOLS_REMINDER}`
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
            this.persistLastMessage();
          }
        }
        if (this.notificationFn) {
          for (const note of this.notificationFn()) {
            this.conversation.addSystemReminder(note);
            this.persistLastMessage();
          }
        }
        // Skills added mid-conversation: only send the delta, not the full listing,
        // and never touch the system prompt to avoid invalidating the cache prefix.
        if (this.skillDeltaFn) {
          const delta = this.skillDeltaFn();
          if (delta) {
            this.conversation.addSystemReminder(
              NEW_SKILLS_REMINDER_PREFIX + delta,
            );
          }
        }

        await this.fireLifecycle("turn_start");
        try {
          await this.fireLifecycle("pre_send");
          // Pre-send and turn-start prompts must reach the request they prepare.
          // Persist these once-notifications too (like the earlier drain) so a
          // resume does not silently drop output that was already sent to the
          // model; each drained note is written exactly once.
          for (const note of this.hookEngine?.drainNotifications() ?? []) {
            this.conversation.addSystemReminder(note);
            this.persistLastMessage();
          }

          // Auto-compact when the window fills up.
          // Tool results are already budget-processed at the time they enter
          // history, so message sizes in the transcript are final — estimate
          // tokens directly from them.
          const mc = summarizingGoal
            ? undefined
            : await manageContext(
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
          if (mc?.message) {
            if (mc.boundary && this.sessionFilePath) {
              saveTranscriptCompactBoundary(this.sessionFilePath, mc.boundary);
            }
            yield {
              type: "compact",
              message: mc.message,
              boundary: mc.boundary,
            };
          }
          if (mc?.compacted) {
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
            if (summarizingGoal) {
              const prompt =
                this.checker.mode !== "plan" &&
                (this.shouldContinueGoal?.() ?? true) &&
                this.steeringQueue.length === 0
                  ? this.goalManager?.takeBudgetSummary()
                  : null;
              if (!prompt) {
                yield { type: "loop_complete", stopReason: "budget_limited" };
                outcome = "completed";
                return;
              }
              this.conversation.addUserMessage(prompt);
              this.persistLastMessage();
            }
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
                  ...(summarizingGoal ? { maxRetries: 0 } : {}),
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
                    type: "thinking",
                    thinking: event.thinking,
                    signature: event.signature,
                  });
                  yield {
                    type: "thinking_complete",
                    thinking: event.thinking,
                    signature: event.signature,
                  };
                  break;

                case "redacted_thinking_complete":
                  // Preserve the opaque encrypted block for verbatim replay on
                  // the next request; never surface its data to the UI or logs.
                  thinkingBlocks.push({
                    type: "redacted_thinking",
                    data: event.data,
                  });
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
            if (!summarizingGoal && err instanceof ContextTooLongError) {
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
                if (result.boundary && this.sessionFilePath) {
                  saveTranscriptCompactBoundary(
                    this.sessionFilePath,
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
              !summarizingGoal &&
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
          if (
            !summarizingGoal &&
            stopReason === "max_tokens" &&
            toolUses.length === 0 &&
            this.goalManager?.get()?.status !== "budget_limited"
          ) {
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
                this.conversation.addUserMessage(MAX_TOKENS_RESUME_PROMPT);
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
                this.conversation.addUserMessage(MAX_TOKENS_RECOVERY_PROMPT);
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
              call.parseError = MAX_TOKENS_TRUNCATED_ARGS_NOTICE;
            }
          }
          if (
            summarizingGoal ||
            this.goalManager?.get()?.status === "budget_limited"
          ) {
            for (const call of toolUses) {
              call.parseError = GOAL_BUDGET_LIMITED_NOTICE;
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
            (summarizingGoal ||
              this.goalManager?.get()?.status === "budget_limited")
          ) {
            yield { type: "turn_complete" };
            continue;
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
            // Successful planning pauses execution for user approval.
            const exitPlanSucceeded = toolUses.some((tu) => {
              if (
                tu.toolName !== "ExitPlanMode" &&
                tu.toolName !== "EnterPlanMode"
              ) {
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
            if (
              summarizingGoal ||
              this.goalManager?.get()?.status === "budget_limited"
            ) {
              yield { type: "turn_complete" };
              continue;
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
            yield { type: "turn_complete" };
            if (this.abortSignal?.aborted) {
              yield { type: "loop_complete", stopReason: "interrupted" };
              return;
            }
            // The model produced no tool calls, so the run would normally end.
            // Steering queued up to this point keeps it alive instead (pi-style).
            if (this.steeringQueue.length > 0) {
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
          output: COMMAND_INTERRUPTED_ERROR,
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
      if (
        target &&
        decisions[0].effect === "allow" &&
        decisions[0].reason === "Permission rule: allow" &&
        decisions[1].effect === "ask" &&
        decisions[1].reason.startsWith("Mode:")
      ) {
        decisions[1] = decisions[0];
      }
      const decision =
        decisions.find((d) => d.effect === "deny") ??
        decisions.find((d) => d.effect === "ask") ??
        decisions[0];

      if (decision.effect === "deny") {
        yield {
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: buildPermissionDeniedOutput(decision.reason),
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
          const patterns = this.checker.rememberPatterns(
            tu.toolName,
            tu.arguments,
          );
          decision.rememberPatterns = [...patterns];
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
            // Persist exactly the displayed scopes; path aliases may change while approval is pending.
            this.checker.allowAlways(tu.toolName, tu.arguments, patterns);
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
      ...(r.result.mcpApp ? { mcpApp: r.result.mcpApp } : {}),
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
   * Subagents use their own transcript path, separate from the leader's history.
   */
  private persistLastMessage(): void {
    if (!this.sessionFilePath) {
      return;
    }
    const msgs = this.conversation.getMessages();
    if (msgs.length === 0) {
      return;
    }
    const last = msgs[msgs.length - 1];
    const record = {
      ...messageToKeptRecord(last),
      timestamp: Math.floor(Date.now() / 1000),
    };
    if (
      this.sessionId &&
      this.sessionFilePath ===
        getSessionFilePath(this.initialCwd, this.sessionId)
    ) {
      saveMessage(this.initialCwd, this.sessionId, record);
    } else {
      saveTranscriptMessage(this.sessionFilePath, record);
    }
  }
}

export interface SteeringMessage {
  text: string;
  input: InputEntry;
}
