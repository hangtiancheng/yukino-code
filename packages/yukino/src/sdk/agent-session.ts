import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import type { AgentEvent } from "@/agent/events.js";
import { parse as parseCommand } from "@/commands/commands.js";
import { forceCompact } from "@/compact/compact.js";
import { loadConfig } from "@/config/index.js";
import {
  PreferencesPatchSchema,
  mergePreferences,
  persistPreferences,
  type PreferencesPatch,
} from "@/config/preferences.js";
import { getSupportedThinkingLevels } from "@/config/provider-config.js";
import type {
  ProviderConfig,
  ThinkingLevel,
} from "@/config/provider-config.js";
import type { Message, UserBashResult } from "@/conversation/index.js";
import { userBashContext } from "@/conversation/prompts.js";
import { executeUserBash } from "@/conversation/user-bash.js";
import { withExecutionContext } from "@/cost/context.js";
import type { ExecutionLedger } from "@/cost/ledger.js";
import type { CostEntry, EntryFilter, RunRelation } from "@/cost/types.js";
import { handleGoalCommand } from "@/goal/index.js";
import { recordInput, type InputEntry } from "@/history/index.js";
import type { LLMClient } from "@/llm/client.js";
import {
  MCPServerConfigSchema,
  type MCPExposure,
  type MCPServerConfig,
} from "@/mcp/config.js";
import { MCPManagement } from "@/mcp/management.js";
import type { MCPLoginOptions } from "@/mcp/oauth.js";
import { discoverProject } from "@/project/discovery.js";
import { resolveProjectConfig } from "@/project/index.js";
import type { AuthorizedProject } from "@/project/types.js";
import { authorizeRuntimeTool } from "@/runtime/authorization.js";
import { applyRuntimePreferences } from "@/runtime/preferences.js";
import { reloadRuntimeResources } from "@/runtime/resources.js";
import {
  captureSessionRuntimeState,
  providerEndpointFingerprint,
  resolveSessionProvider,
} from "@/runtime/session-state.js";
import type { AgentRuntime } from "@/runtime/types.js";
import {
  EMPTY_USAGE,
  SDK_EMPTY_PROMPT_ERROR,
  SDK_MODEL_TARGET_ERROR,
  SDK_MAX_QUEUE_ENTRIES,
  SDK_MAX_QUEUE_BYTES,
} from "@/sdk/constants.js";
import { SessionBusyError, SessionDisposedError } from "@/sdk/errors.js";
import {
  buildSessionEnvironment,
  sdkConfig,
  type SessionEnvironment,
} from "@/sdk/factory.js";
import type {
  AbortScope,
  CreateAgentSessionOptions,
  PromptInput,
  PromptOptions,
  PromptResult,
  QueueEntry,
  QueueMode,
  QueueReceipt,
  ResumeSessionOptions,
  SessionRestorationOptions,
  SessionImportOptions,
  SessionEvent,
  SessionEventPayloads,
  SessionListener,
} from "@/sdk/types.js";
import {
  generateBranchSummary,
  prepareBranchSummary,
} from "@/session/branch-summary.js";
import {
  MAX_SESSION_STRING_BYTES,
  SESSION_TRANSPORT_CHUNK_BYTES,
} from "@/session/constants.js";
import {
  saveCompactBoundary,
  listAllSessions,
  listSessions,
} from "@/session/index.js";
import { SessionManager } from "@/session/manager.js";
import { buildBranchSummaryReminder } from "@/session/prompts.js";
import type {
  BranchSummaryPayload,
  SessionRuntimeState,
} from "@/session/records.js";
import {
  assertBoundedJson,
  SessionConflictError,
  type SessionMetadata,
} from "@/session/records.js";
import {
  prepareSessionRestoration,
  type PreparedSessionRestoration,
} from "@/session/restoration.js";
import {
  sessionImportFileBytes,
  writeSessionExportFile,
} from "@/session/stream.js";
import type {
  LocalDiagnosticsOptions,
  SessionExportOptions,
} from "@/session/transfer.js";
import { sessionPath } from "@/storage/index.js";
import { MAX_TASK_WAIT_TIMEOUT_MS } from "@/subagent/constants.js";
import { formatAgentTaskNotification } from "@/subagent/prompts.js";
import { INBOXES_DIR_NAME } from "@/teams/constants.js";
import { teamDir } from "@/teams/team-file.js";
import { BashTool } from "@/tools/bash.js";
import { hasAnyForegroundTasks } from "@/tools/shell-background.js";
import {
  normalizeToolResultContentBlock,
  type PermissionRequestHandler,
  type ToolContext,
} from "@/tools/types.js";
import { cancelOnSignal } from "@/utils/cancel.js";
import { plainTerminalText } from "@/utils/index.js";
import type { WorkflowInput } from "@/workflow/schema.js";
import { getWorkflowService } from "@/workflow/wiring.js";

interface PendingInput extends QueueEntry {
  input: PromptInput;
  history: InputEntry;
  resolve: (result: PromptResult) => void;
  completion: Promise<PromptResult>;
  signal?: AbortSignal;
  cancel?: () => void;
}

function normalizeInput(input: string | PromptInput): PromptInput {
  assertBoundedJson(input);
  const value =
    typeof input === "string" ? { text: input } : structuredClone(input);
  if (
    typeof value.text !== "string" ||
    Object.keys(value).some((key) => key !== "text" && key !== "attachments") ||
    Buffer.byteLength(JSON.stringify(value)) > SDK_MAX_QUEUE_BYTES
  ) {
    throw new Error("Invalid or oversized prompt input");
  }
  if (value.attachments) {
    if (!Array.isArray(value.attachments)) {
      throw new Error("Invalid prompt attachments");
    }
    value.attachments = value.attachments.map((attachment) => {
      const block = normalizeToolResultContentBlock(attachment);
      if (
        !block ||
        (block.type !== "text" &&
          block.type !== "image" &&
          block.type !== "document")
      ) {
        throw new Error("Invalid prompt attachment");
      }
      return { ...block };
    });
  }
  if (!value.text.trim() && !value.attachments?.length) {
    throw new Error(SDK_EMPTY_PROMPT_ERROR);
  }
  return value;
}
function content(input: PromptInput): string | Record<string, unknown>[] {
  return input.attachments?.length
    ? [{ type: "text", text: input.text }, ...input.attachments]
    : input.text;
}

async function disposeEnvironment(
  environment: SessionEnvironment,
): Promise<void> {
  let failure: { error: unknown } | undefined;
  for (const dispose of [
    () => environment.project.dispose(),
    () => environment.runtime.dispose(),
  ]) {
    try {
      await dispose();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) {
    throw failure.error;
  }
}

const MAX_CLIENT_BINDINGS = 16;

function clientBindingKey(provider: SessionRuntimeState["provider"]): string {
  return JSON.stringify([
    provider.name,
    provider.protocol,
    provider.endpointFingerprint,
    provider.model,
  ]);
}

function providerBindingKey(provider: ProviderConfig): string {
  return clientBindingKey({
    ...provider,
    endpointFingerprint: providerEndpointFingerprint(provider),
  });
}

function hasPendingToolResults(messages: readonly Message[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolUses ?? []) {
      pending.add(tool.toolUseId);
    }
    for (const result of message.toolResults ?? []) {
      pending.delete(result.toolUseId);
    }
  }
  return pending.size > 0;
}

export class AgentSession {
  private environment!: SessionEnvironment;
  private authorizedProject?: AuthorizedProject;
  private revokedProjectCwds = new Set<string>();
  private manager: SessionManager;
  private listeners = new Set<SessionListener>();
  private sequence = 0;
  private pending: PendingInput[] = [];
  private submitted = new Map<string, PendingInput>();
  private pump?: Promise<void>;
  private operation?: Promise<unknown>;
  private operationController?: AbortController;
  private transition?: Promise<void>;
  private transitionController?: AbortController;
  private disposal?: Promise<void>;
  private currentRunId: string | null = null;
  private foregroundController?: AbortController;
  private foregroundAborted = false;
  private retryState: SessionEventPayloads["retry"] | null = null;
  private completed: { result: PromptResult; inputs: PendingInput[] }[] = [];
  private activeInputs: PendingInput[] = [];
  private taskUnsubscribe?: () => void;
  private lifetimeAbort?: () => void;
  private memoryCursor = 0;
  private steeringMode: QueueMode;
  private followUpMode: QueueMode;
  private codeModeCalls = new Set<string>();
  private memoryArtifactOwners = new Set<string>();
  private ledgers = new Map<string, ExecutionLedger>();
  private inheritedCosts = new Map<
    string,
    { entries: CostEntry[]; runs: RunRelation[] }
  >();
  private mcpManagement!: MCPManagement;
  private clientBindings = new Map<
    string,
    { provider: ProviderConfig; client?: LLMClient }
  >();
  private readonly loadGlobalConfig: boolean;
  private exportControllers = new Set<AbortController>();

  private constructor(
    private options: CreateAgentSessionOptions,
    manager: SessionManager,
  ) {
    this.manager = manager;
    this.options = {
      ...options,
      overrides: mergePreferences(options.overrides ?? {}, {
        ...(options.steeringMode === undefined
          ? {}
          : { steering_mode: options.steeringMode }),
        ...(options.followUpMode === undefined
          ? {}
          : { follow_up_mode: options.followUpMode }),
      }),
    };
    this.loadGlobalConfig =
      options.config?.providers === undefined &&
      options.provider === undefined &&
      options.client === undefined;
    this.steeringMode = options.steeringMode ?? "all";
    this.followUpMode = options.followUpMode ?? "one-at-a-time";
  }
  static async create(
    options: CreateAgentSessionOptions,
    manager: SessionManager,
  ): Promise<AgentSession> {
    const session = new AgentSession(options, manager);
    await session.initialize({
      restoreState:
        options.provider === undefined &&
        options.model === undefined &&
        options.thinking === undefined &&
        options.client === undefined,
    });
    if (options.signal) {
      session.lifetimeAbort = () => {
        void session.abort("all");
      };
      options.signal.addEventListener("abort", session.lifetimeAbort, {
        once: true,
      });
    }
    return session;
  }
  private async initialize(
    options: {
      restoreState?: boolean;
      declarations?: SessionRuntimeState;
      signal?: AbortSignal;
      persistState?: boolean;
      authorizedProject?: AuthorizedProject;
      rejectTrustRequest?: boolean;
    } = {},
  ): Promise<void> {
    this.manager.refresh();
    const revision = this.manager.revision;
    const environment = await buildSessionEnvironment(
      {
        ...this.options,
        ...(options.rejectTrustRequest
          ? {
              onTrustRequest: () =>
                Promise.reject(
                  new Error(
                    "Session import project changed after trust validation",
                  ),
                ),
            }
          : {}),
        trust: this.revokedProjectCwds.has(this.manager.cwd)
          ? "deny"
          : this.options.trust,
        ledger: this.ledgers.get(this.sessionId) ?? this.options.ledger,
      },
      this.manager,
      (event) => {
        this.publish("subagent", event, "subagent");
      },
      {
        authorizedProject: options.authorizedProject ?? this.authorizedProject,
        restoreState: options.restoreState ?? true,
        loadGlobalConfig: this.loadGlobalConfig,
        declarations: options.declarations,
        signal: options.signal,
        providerForState: (state) =>
          this.clientBindings.get(clientBindingKey(state.provider))?.provider,
        clientForProvider: (provider) =>
          this.clientBindings.get(providerBindingKey(provider))?.client,
      },
    );
    try {
      options.signal?.throwIfAborted();
      this.options.signal?.throwIfAborted();
      this.manager.refresh();
      if (this.manager.revision !== revision) {
        throw new SessionConflictError(revision, this.manager.revision);
      }
      if (
        options.persistState !== false &&
        !hasPendingToolResults(environment.runtime.conv.getMessages()) &&
        !isDeepStrictEqual(this.manager.getRuntimeState(), environment.state)
      ) {
        this.manager.appendRuntimeState(environment.state);
      }
    } catch (error) {
      await disposeEnvironment(environment).catch(() => undefined);
      throw error;
    }
    this.environment = environment;
    this.steeringMode = environment.runtime.preferences.steering_mode;
    this.followUpMode = environment.runtime.preferences.follow_up_mode;
    const key = providerBindingKey(environment.runtime.provider);
    this.clientBindings.delete(key);
    this.clientBindings.set(key, {
      provider: structuredClone(environment.runtime.provider),
      client: environment.client,
    });
    if (this.clientBindings.size > MAX_CLIENT_BINDINGS) {
      const oldest = this.clientBindings.keys().next().value;
      if (oldest !== undefined) {
        this.clientBindings.delete(oldest);
      }
    }
    if (this.environment.project.trusted) {
      this.authorizedProject = {
        identity: this.environment.project.identity,
        fingerprint: this.environment.project.fingerprint,
      };
    }
    this.options = {
      ...this.options,
      trust: this.options.trust === "deny" ? "deny" : undefined,
      provider: structuredClone(environment.runtime.provider),
      model: undefined,
      thinking: environment.state.thinking,
      client: environment.client,
    };
    this.mcpManagement = new MCPManagement(
      this.environment.runtime,
      this.manager,
      this.permissionHandler,
    );
    const inherited = this.inheritedCosts.get(this.sessionId);
    this.environment.ledger.replay(
      inherited?.entries ?? [],
      inherited?.runs ?? [],
    );
    this.inheritedCosts.delete(this.sessionId);
    this.ledgers.set(this.sessionId, this.environment.ledger);
    this.memoryCursor = this.environment.runtime.conv.len();
    if (!this.manager.persistent) {
      this.memoryArtifactOwners.add(this.sessionId);
    }
    this.taskUnsubscribe =
      this.environment.runtime.backgroundTaskManager.subscribe((tasks) => {
        this.publish(
          "task_changed",
          {
            tasks: tasks.map(({ id, name, kind, status, output }) => ({
              id,
              name,
              kind,
              status,
              output,
            })),
          },
          "task",
        );
      });
  }
  get sessionId(): string {
    return this.manager.id;
  }
  get cwd(): string {
    return this.manager.cwd;
  }
  get sessionManager(): SessionManager {
    return this.manager;
  }
  /** Native hosts can integrate workspaces without creating a second runtime. */
  get runtime() {
    this.assertOpen();
    return this.environment.runtime;
  }
  get isBusy(): boolean {
    return Boolean(
      this.pump || this.operation || this.transition || this.pending.length,
    );
  }
  get isDisposed(): boolean {
    return Boolean(this.disposal);
  }
  subscribe(listener: SessionListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish<K extends keyof SessionEventPayloads>(
    type: K,
    payload: SessionEventPayloads[K],
    source: SessionEvent["source"] = "session",
    runId = this.currentRunId,
  ): void {
    // The generic type/payload pair is correlated at every call site.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const event = {
      sequence: ++this.sequence,
      sessionId: this.sessionId,
      runId,
      source,
      type,
      payload,
    } as SessionEvent;
    for (const listener of [...this.listeners]) {
      try {
        void Promise.resolve(listener(structuredClone(event))).catch(
          () => undefined,
        );
      } catch {
        /* Observation must never approve, abort, or fail an execution. */
      }
    }
  }
  private assertOpen(): void {
    if (this.disposal) {
      throw new SessionDisposedError();
    }
  }
  private assertIdle(): void {
    this.assertOpen();
    if (this.isBusy) {
      throw new SessionBusyError();
    }
  }

  prompt(
    input: string | PromptInput,
    options: PromptOptions = {},
  ): Promise<PromptResult> {
    try {
      this.assertOpen();
      if (this.transition) {
        throw new SessionBusyError();
      }
      const normalized = normalizeInput(input);
      if (this.isBusy && (!options.delivery || options.delivery === "reject")) {
        throw new SessionBusyError();
      }
      return this.enqueue(
        normalized,
        options.delivery === "steer" ? "steer" : "followUp",
        options.signal,
      ).completion;
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  steer(
    input: string | PromptInput,
    options: { signal?: AbortSignal } = {},
  ): QueueReceipt {
    this.assertOpen();
    if (this.transition) {
      throw new SessionBusyError();
    }
    return this.enqueue(normalizeInput(input), "steer", options.signal);
  }
  followUp(
    input: string | PromptInput,
    options: { signal?: AbortSignal } = {},
  ): QueueReceipt {
    this.assertOpen();
    if (this.transition) {
      throw new SessionBusyError();
    }
    return this.enqueue(normalizeInput(input), "followUp", options.signal);
  }
  private enqueue(
    input: PromptInput,
    kind: QueueEntry["kind"],
    signal?: AbortSignal,
  ): QueueReceipt {
    signal?.throwIfAborted();
    const outstanding = new Map(
      [...this.pending, ...this.submitted.values(), ...this.activeInputs].map(
        (entry) => [entry.id, entry],
      ),
    );
    const bytes = [...outstanding.values()].reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.input)),
      Buffer.byteLength(JSON.stringify(input)),
    );
    if (
      outstanding.size >= SDK_MAX_QUEUE_ENTRIES ||
      bytes > SDK_MAX_QUEUE_BYTES
    ) {
      throw new SessionBusyError();
    }
    let resolve = (_result: PromptResult): void => undefined;
    const completion = new Promise<PromptResult>((done) => {
      resolve = done;
    });
    const history: InputEntry = this.manager.persistent
      ? recordInput({
          cwd: this.cwd,
          sessionId: this.sessionId,
          source: this.options.inputSource ?? "sdk",
          text: input.text || "[attachments]",
        })
      : {
          type: "input",
          id: randomUUID(),
          timestamp: Date.now(),
          cwd: this.cwd,
          sessionId: this.sessionId,
          source: this.options.inputSource ?? "sdk",
          text: input.text || "[attachments]",
          commandName: null,
        };
    const id = history.id;
    const entry: PendingInput = {
      id,
      kind,
      text: input.text,
      attachments: input.attachments,
      input,
      state: "queued",
      completion,
      resolve,
      signal,
      history,
    };
    if (signal) {
      entry.cancel = () => {
        if (this.activeInputs.includes(entry)) {
          void this.abort("foreground");
        } else {
          this.cancelEntry(entry);
        }
      };
      signal.addEventListener("abort", entry.cancel, { once: true });
    }
    this.pending.push(entry);
    this.queueChanged();
    this.dispatchSteering();
    this.startPump();
    return { id, completion };
  }
  getQueue(): QueueEntry[] {
    return [...this.submitted.values(), ...this.pending].map(
      ({ id, kind, text, attachments, state }) => ({
        id,
        kind,
        text,
        attachments: attachments ? structuredClone(attachments) : undefined,
        state,
      }),
    );
  }
  getQueueModes(): { steering: QueueMode; followUp: QueueMode } {
    return { steering: this.steeringMode, followUp: this.followUpMode };
  }
  getRetryState(): SessionEventPayloads["retry"] | null {
    return this.retryState ? { ...this.retryState } : null;
  }
  setQueueMode(kind: QueueEntry["kind"], mode: QueueMode): void {
    this.assertOpen();
    this.environment.runtime.preferences[
      kind === "steer" ? "steering_mode" : "follow_up_mode"
    ] = mode;
    this.options.overrides = {
      ...this.options.overrides,
      [kind === "steer" ? "steering_mode" : "follow_up_mode"]: mode,
    };
    if (kind === "steer") {
      this.steeringMode = mode;
      this.dispatchSteering();
    } else {
      this.followUpMode = mode;
    }
  }
  private queueChanged(): void {
    this.publish("queue_changed", { entries: this.getQueue() });
  }
  clearQueue(kind?: QueueEntry["kind"]): QueueEntry[] {
    const entries = this.getQueue().filter(
      (entry) => !kind || entry.kind === kind,
    );
    for (const entry of [...this.pending, ...this.submitted.values()]) {
      if (!kind || entry.kind === kind) {
        this.cancelEntry(entry);
      }
    }
    return entries;
  }
  private cancelEntry(entry: PendingInput): void {
    this.pending = this.pending.filter((queued) => queued !== entry);
    this.submitted.delete(entry.id);
    this.environment.runtime.removeSteering(entry.id);
    this.finishInput(entry, this.cancelledResult());
    this.queueChanged();
  }
  private cancelledResult(): PromptResult {
    return {
      status: "aborted",
      stopReason: "cancelled",
      text: "",
      messages: this.getMessages(),
      usage: { ...EMPTY_USAGE },
      runId: "",
      sessionId: this.sessionId,
    };
  }
  private finishInput(entry: PendingInput, result: PromptResult): void {
    if (entry.cancel) {
      entry.signal?.removeEventListener("abort", entry.cancel);
    }
    entry.resolve(structuredClone(result));
  }
  private dispatchSteering(): void {
    if (
      !this.currentRunId ||
      (this.operation && !this.foregroundController) ||
      this.transition ||
      this.disposal
    ) {
      return;
    }
    if (this.steeringMode === "one-at-a-time" && this.submitted.size) {
      return;
    }
    const entries = this.pending.filter((entry) => entry.kind === "steer");
    for (const entry of this.steeringMode === "all"
      ? entries
      : entries.slice(0, 1)) {
      if (
        !this.environment.runtime.steer(
          entry.text,
          entry.history,
          entry.input.attachments?.length ? content(entry.input) : undefined,
        )
      ) {
        return;
      }
      this.pending = this.pending.filter((queued) => queued !== entry);
      entry.state = "submitted";
      this.submitted.set(entry.id, entry);
    }
    if (entries.length) {
      this.queueChanged();
    }
  }
  private startPump(): void {
    if (
      this.pump ||
      this.operation ||
      this.transition ||
      this.disposal ||
      !this.pending.length
    ) {
      return;
    }
    this.pump = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.pump = undefined;
        for (const { result, inputs } of this.completed.splice(0)) {
          this.publish("run_settled", result, "session", result.runId);
          for (const entry of inputs) {
            this.finishInput(entry, result);
          }
        }
        this.startPump();
      });
  }
  private async drain(): Promise<void> {
    try {
      while (this.pending.length && !this.disposal && !this.transition) {
        const first = this.pending.shift();
        if (!first) {
          break;
        }
        const batch = [first];
        if (first.kind === "followUp" && this.followUpMode === "all") {
          while (this.pending[0]?.kind === "followUp") {
            const next = this.pending.shift();
            if (next) {
              batch.push(next);
            }
          }
        }
        this.activeInputs = batch;
        this.queueChanged();
        await this.runBatch(batch);
        this.activeInputs = [];
      }
    } finally {
      this.currentRunId = null;
    }
  }
  private async runBatch(batch: PendingInput[]): Promise<PromptResult> {
    const runId = randomUUID();
    this.currentRunId = runId;
    const controller = new AbortController();
    this.foregroundController = controller;
    this.foregroundAborted = false;
    this.retryState = null;
    this.publish("run_started", { input: batch[0]?.input ?? { text: "" } });
    let text = "";
    let stopReason = "end_turn";
    let failed = false;
    const usage = { ...EMPTY_USAGE };
    const h = this.environment.runtime;
    const context = {
      sessionId: this.sessionId,
      runId,
      agentId: "main",
      purpose: "main" as const,
      ledger: this.environment.ledger,
    };
    await withExecutionContext(context, async () => {
      try {
        if (controller.signal.aborted) {
          return;
        }
        let first = true;
        do {
          if (controller.signal.aborted) {
            break;
          }
          let initialContent =
            first && batch[0] ? content(batch[0].input) : null;
          const command =
            typeof initialContent === "string"
              ? parseCommand(initialContent)
              : null;
          if (command?.name === "goal") {
            if (!h.goalManager) {
              throw new Error("Goals require a session goal manager");
            }
            const goal = handleGoalCommand(h.goalManager, command.args);
            text = `${goal.message}\n`;
            this.publish("stream_text", { text }, "agent");
            if (goal.isError) {
              failed = true;
              stopReason = "error";
              this.publish(
                "error",
                { error: new Error(goal.message) },
                "agent",
              );
            }
            if (!goal.prompt) {
              break;
            }
            initialContent = goal.prompt;
            this.publish("turn_complete", {}, "agent");
          }
          if (controller.signal.aborted) {
            break;
          }
          this.captureRuntimeState();
          const iterator = h.run(initialContent, {
            input: first ? batch[0]?.history : undefined,
            onPermissionRequest: this.permissionHandler,
            queuedInputs: first
              ? batch.slice(1).map((entry) => ({
                  content: content(entry.input),
                  input: entry.history,
                }))
              : undefined,
          });
          if (controller.signal.aborted) {
            break;
          }
          first = false;
          for await (const event of iterator) {
            this.syncMessages(event);
            if (event.type === "retry") {
              this.retryState = { reason: event.reason, delay: event.delay };
            } else if (
              event.type === "stream_text" ||
              event.type === "tool_use" ||
              event.type === "usage" ||
              event.type === "loop_complete"
            ) {
              this.retryState = null;
            }
            if (event.type === "stream_text") {
              text += event.text;
            } else if (event.type === "loop_complete") {
              stopReason = event.stopReason;
            } else if (event.type === "error") {
              failed = true;
            } else if (event.type === "usage") {
              usage.inputTokens += event.usage.inputTokens;
              usage.outputTokens += event.usage.outputTokens;
              usage.cacheReadInputTokens += event.usage.cacheReadInputTokens;
              usage.cacheCreationInputTokens +=
                event.usage.cacheCreationInputTokens;
            } else if (event.type === "steering_delivered") {
              const entry = this.submitted.get(event.inputId);
              if (entry) {
                this.activeInputs.push(entry);
                this.submitted.delete(entry.id);
                this.queueChanged();
              }
            } else if (
              event.type === "tool_use" &&
              event.toolName === "CodeMode"
            ) {
              this.codeModeCalls.add(event.toolId);
            } else if (event.type === "tool_result") {
              this.codeModeCalls.delete(event.toolId);
            }
            if (
              event.type === "turn_complete" ||
              event.type === "loop_complete"
            ) {
              this.captureRuntimeState();
            }
            const { type, ...payload } = event;
            this.publish(type, payload, "agent");
            if (event.type === "turn_complete") {
              this.dispatchSteering();
            }
          }
        } while (
          !controller.signal.aborted &&
          !this.pending.length &&
          h.backgroundTaskManager.hasNotifications()
        );
      } catch (error) {
        failed = true;
        stopReason =
          this.foregroundAborted || batch.some((entry) => entry.signal?.aborted)
            ? "interrupted"
            : "error";
        this.publish(
          "error",
          { error: error instanceof Error ? error : new Error(String(error)) },
          "agent",
        );
      } finally {
        this.codeModeCalls.clear();
        this.syncMessages();
        const leftovers = h.takeSteeringLeftovers();
        for (const { input } of leftovers.reverse()) {
          const entry = this.submitted.get(input.id);
          if (entry) {
            entry.state = "queued";
            this.submitted.delete(input.id);
            this.pending.unshift(entry);
          }
        }
        this.queueChanged();
        this.foregroundController = undefined;
        this.retryState = null;
      }
    });
    if (controller.signal.aborted || this.foregroundAborted) {
      stopReason = "interrupted";
    }
    const firstInputIndex = h.conv
      .getMessages()
      .findIndex(
        (message) => batch[0] && message.userInput?.id === batch[0].id,
      );
    const finalMessage = h.conv
      .getMessages()
      .slice(firstInputIndex < 0 ? h.conv.len() : firstInputIndex)
      .findLast(
        (message) => message.role === "assistant" && !message.toolUses?.length,
      );
    if (typeof finalMessage?.content === "string") {
      text = finalMessage.content;
    }
    const result: PromptResult = {
      status:
        stopReason === "interrupted" || stopReason === "retry_aborted"
          ? "aborted"
          : failed
            ? "failed"
            : "completed",
      stopReason,
      text,
      messages: this.getMessages(),
      usage,
      cost: this.environment.ledger.summary({
        runId,
        includeDescendants: true,
      }),
      runId,
      sessionId: this.sessionId,
    };
    if (batch.length) {
      this.completed.push({ result, inputs: [...this.activeInputs] });
    }
    return result;
  }
  continueRun(): Promise<PromptResult> {
    return this.exclusive(async () => {
      try {
        const result = await this.runBatch([]);
        this.publish("run_settled", result, "session", result.runId);
        for (const entry of this.activeInputs) {
          this.finishInput(entry, result);
        }
        return result;
      } finally {
        this.activeInputs = [];
        this.currentRunId = null;
      }
    });
  }

  runHostOperation<T>(
    work: (runtime: AgentRuntime, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.exclusive((signal) =>
      withExecutionContext(
        {
          sessionId: this.sessionId,
          runId: randomUUID(),
          agentId: "main",
          purpose: "main",
          ledger: this.environment.ledger,
        },
        async () => {
          try {
            return await work(this.environment.runtime, signal);
          } finally {
            this.syncMessages();
            this.captureRuntimeState();
          }
        },
      ),
    );
  }

  private captureRuntimeState(): void {
    const { runtime, project } = this.environment;
    if (hasPendingToolResults(runtime.conv.getMessages())) {
      return;
    }
    const state = captureSessionRuntimeState(runtime, project);
    this.manager.refresh();
    if (!isDeepStrictEqual(this.manager.getRuntimeState(), state)) {
      this.manager.appendRuntimeState(state);
    }
    this.environment.state = state;
  }
  private syncMessages(event?: AgentEvent): void {
    if (this.manager.persistent) {
      this.manager.refresh();
      return;
    }
    const messages = this.environment.runtime.conv.getMessages();
    if (event?.type === "compact" && event.boundary) {
      this.manager.append({
        role: "system",
        type: "compact_boundary",
        content: JSON.stringify(event.boundary),
        timestamp: Date.now() / 1000,
      });
      this.memoryCursor = messages.length;
    } else {
      for (const message of messages.slice(this.memoryCursor)) {
        this.manager.append(message);
      }
      this.memoryCursor = messages.length;
    }
  }
  private permissionHandler: PermissionRequestHandler = async (...args) => {
    const handler = this.options.onPermissionRequest;
    return handler ? cancelOnSignal(() => handler(...args), args[4]) : "deny";
  };

  async waitForIdle(options: { signal?: AbortSignal } = {}): Promise<void> {
    while (
      this.pump ||
      this.operation ||
      this.transition ||
      this.pending.length
    ) {
      this.startPump();
      const work = this.transition ?? this.operation ?? this.pump;
      if (work) {
        await cancelOnSignal(() => work, options.signal);
      } else {
        break;
      }
    }
  }
  async waitForBackground(options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }) {
    this.assertIdle();
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 0 ||
      options.timeoutMs > MAX_TASK_WAIT_TIMEOUT_MS
    ) {
      throw new Error(
        `Background wait timeout must be between 0 and ${MAX_TASK_WAIT_TIMEOUT_MS}ms`,
      );
    }
    return this.exclusive((signal) =>
      this.waitForOwnedBackground({
        ...options,
        signal: options.signal
          ? AbortSignal.any([signal, options.signal])
          : signal,
      }),
    );
  }
  private async waitForOwnedBackground(options: {
    timeoutMs: number;
    signal: AbortSignal;
  }) {
    const h = this.environment.runtime;
    const deadline = Date.now() + options.timeoutMs;
    const waited = new Set<string>();
    let timedOut = false;
    try {
      options.signal?.throwIfAborted();
      while (true) {
        const tasks = h.backgroundTaskManager
          .list()
          .filter((task) => task.kind !== "shell" && !waited.has(task.id));
        if (!tasks.length) {
          break;
        }
        const outcomes = await Promise.all(
          tasks.map((task) =>
            h.backgroundTaskManager.wait(task.id, {
              timeoutMs: Math.max(0, deadline - Date.now()),
              abortSignal: options.signal,
            }),
          ),
        );
        timedOut = outcomes.some((outcome) => outcome?.timedOut);
        if (timedOut) {
          await this.abort("background");
          break;
        }
        for (const task of tasks) {
          waited.add(task.id);
        }
      }
      if (!timedOut) {
        timedOut = await new Promise<boolean>((resolve, reject) => {
          const watchers = new Map<string, ReturnType<typeof watch>>();
          const members = new Set<Promise<void>>();
          let unsubscribe = (): void => undefined;
          let settled = false;
          const finish = (expired: boolean, error?: unknown): void => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", aborted);
            unsubscribe();
            for (const watcher of watchers.values()) {
              watcher.close();
            }
            if (error !== undefined) {
              reject(
                error instanceof Error
                  ? error
                  : new Error("Background wait failed", { cause: error }),
              );
            } else {
              resolve(expired);
            }
          };
          const aborted = (): void => {
            finish(
              false,
              options.signal?.reason ?? new Error("Background wait aborted"),
            );
          };
          const changed = (): void => {
            if (settled) {
              return;
            }
            try {
              const activeTeams = h.teamManager
                .list()
                .filter((team) =>
                  team
                    .listMembers()
                    .some(
                      (member) =>
                        member.done && member.uiState?.status === "running",
                    ),
                );
              if (!activeTeams.length) {
                finish(false);
                return;
              }
              for (const team of activeTeams) {
                if (!watchers.has(team.name)) {
                  // Round completion writes the leader mailbox; TeamManager only emits membership changes.
                  const watcher = watch(
                    join(teamDir(this.cwd, team.name), INBOXES_DIR_NAME),
                    changed,
                  );
                  watcher.on("error", (error) => {
                    finish(false, error);
                  });
                  watchers.set(team.name, watcher);
                }
                for (const member of team.listMembers()) {
                  if (member.done && !members.has(member.done)) {
                    members.add(member.done);
                    void member.done.then(changed, changed);
                  }
                }
              }
            } catch (error) {
              finish(false, error);
            }
          };
          const timer = setTimeout(
            () => {
              finish(true);
            },
            Math.max(0, deadline - Date.now()),
          );
          options.signal?.addEventListener("abort", aborted, { once: true });
          unsubscribe = h.teamManager.subscribe(changed);
          if (options.signal?.aborted) {
            aborted();
          } else {
            changed();
          }
        });
        if (timedOut) {
          await this.abort("background");
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        await this.abort("background");
      }
      throw error;
    } finally {
      const notifications = [
        ...h.teamManager.drainLeaderMailbox(),
        ...h.backgroundTaskManager
          .drainNotifications()
          .map(formatAgentTaskNotification),
      ];
      for (const notification of notifications) {
        h.conv.addSystemReminder(notification);
        const message = h.conv.getMessages().at(-1);
        if (message) {
          this.manager.append(message);
        }
      }
      this.memoryCursor = h.conv.len();
      this.syncMessages();
    }
    return {
      timedOut,
      tasks: this.getTasks(),
      teammates: structuredClone(h.teamManager.getAllTeammateStates()),
    };
  }
  async abort(scope: AbortScope = "foreground"): Promise<void> {
    if (scope === "queue" || scope === "all") {
      this.clearQueue();
    }
    if (scope === "foreground" || scope === "all") {
      for (const controller of this.exportControllers) {
        controller.abort();
      }
      this.transitionController?.abort();
      this.foregroundAborted = true;
      this.foregroundController?.abort();
      this.operationController?.abort();
      this.environment.runtime.abortForeground();
      await this.environment.runtime.cache.invalidate("aborted");
      await Promise.all(
        this.environment.runtime.backgroundTaskManager
          .list()
          .filter((task) => task.kind !== "shell" && task.status === "running")
          .map((task) =>
            this.environment.runtime.backgroundTaskManager.stopAndWait(task.id),
          ),
      );
    }
    if (scope === "background" || scope === "all") {
      await Promise.all([
        this.environment.runtime.backgroundTaskManager.stopAll(),
        this.environment.runtime.teamManager.stopAll(),
      ]);
    }
  }
  getMessages(): Message[] {
    return structuredClone(this.environment.runtime.conv.getMessages());
  }
  getEntries() {
    this.manager.refresh();
    return this.manager.getEntries();
  }
  getTree() {
    this.manager.refresh();
    return this.manager.getTree();
  }
  getMetadata(): SessionMetadata {
    this.manager.refresh();
    return this.manager.getMetadata();
  }
  setMetadata(metadata: SessionMetadata): void {
    this.assertOpen();
    this.manager.refresh();
    this.manager.setMetadata(metadata);
  }
  setName(name: string): void {
    this.assertOpen();
    this.manager.refresh();
    this.manager.setName(name);
  }
  setLabel(entryId: string, label: string | null): void {
    this.assertOpen();
    this.manager.refresh();
    this.manager.setLabel(entryId, label);
  }
  listSessions(options: { allProjects?: boolean } = {}) {
    return options.allProjects ? listAllSessions() : listSessions(this.cwd);
  }
  export(options: SessionExportOptions): string {
    this.assertOpen();
    this.manager.refresh();
    return this.manager.export(options);
  }
  exportStream(options: SessionExportOptions): AsyncGenerator<Uint8Array> {
    this.assertOpen();
    this.options.signal?.throwIfAborted();
    this.manager.refresh();
    const manager = this.manager;
    const revision = manager.revision;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    const source = manager.exportStream({ ...options, signal });
    const exportControllers = this.exportControllers;
    const check = (): void => {
      signal.throwIfAborted();
      this.assertOpen();
      if (this.manager !== manager || manager.revision !== revision) {
        throw new SessionConflictError(revision, this.manager.revision);
      }
    };
    return (async function* () {
      check();
      exportControllers.add(controller);
      try {
        for await (const chunk of source) {
          check();
          yield chunk;
        }
        check();
      } finally {
        exportControllers.delete(controller);
        await source.return(undefined);
      }
    })();
  }
  async exportFile(path: string, options: SessionExportOptions): Promise<void> {
    this.assertOpen();
    const manager = this.manager;
    await writeSessionExportFile(
      path,
      this.exportStream(options),
      options,
      () => {
        this.assertOpen();
        this.options.signal?.throwIfAborted();
        if (this.manager !== manager) {
          throw new Error("Session changed during export");
        }
      },
    );
  }
  diagnostics(options: LocalDiagnosticsOptions = {}): string {
    this.manager.refresh();
    return this.manager.diagnostics(options);
  }

  private replace(
    resolve: (signal: AbortSignal) => SessionManager | Promise<SessionManager>,
    options: {
      signal?: AbortSignal;
      onReady?: () => void;
      restoreState?: boolean;
      preflight?: (signal: AbortSignal) => Promise<void>;
      authorizedProject?: () => AuthorizedProject | undefined;
      rejectTrustRequest?: boolean;
      beforeCommit?: (signal: AbortSignal) => Promise<void>;
    } = {},
  ): Promise<void> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    if (this.transition) {
      return Promise.reject(new SessionBusyError());
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    const previousSessionId = this.sessionId;
    const previousManager = this.manager;
    const previousOptions = { ...this.options };
    const previousAuthorizedProject = this.authorizedProject;
    const previousEnvironment = this.environment;
    const previouslyRevoked = this.revokedProjectCwds.has(
      previousEnvironment.project.cwd,
    );
    this.transitionController = controller;
    this.transition = Promise.resolve()
      .then(async () => {
        let previousLeaf = this.manager.leafId;
        let resolvedManager: SessionManager | undefined;
        let replaced = false;
        let previousDisposed = false;
        try {
          signal.throwIfAborted();
          this.assertOpen();
          await options.preflight?.(signal);
          signal.throwIfAborted();
          this.assertOpen();
          this.clearQueue();
          // Internal cancellation must not cancel the restoration preflight itself.
          this.transitionController = undefined;
          const stopped = this.abort("all");
          this.transitionController = controller;
          await stopped;
          await previousEnvironment.runtime.cache.invalidate("branch_change");
          await Promise.allSettled([this.pump, this.operation]);
          this.manager.refresh();
          previousLeaf = this.manager.leafId;
          signal.throwIfAborted();
          this.assertOpen();
          const manager = await resolve(signal);
          resolvedManager = manager;
          signal.throwIfAborted();
          const cwd = await realpath(manager.cwd);
          if (cwd !== manager.cwd || !(await stat(cwd)).isDirectory()) {
            throw new Error(
              "Session cwd must remain its exact canonical directory",
            );
          }
          await options.beforeCommit?.(signal);
          signal.throwIfAborted();
          this.assertOpen();
          this.taskUnsubscribe?.();
          replaced = true;
          await disposeEnvironment(previousEnvironment);
          previousDisposed = true;
          signal.throwIfAborted();
          this.assertOpen();
          this.manager = manager;
          await this.initialize({
            restoreState: options.restoreState ?? true,
            signal,
            authorizedProject: options.authorizedProject?.(),
            rejectTrustRequest: options.rejectTrustRequest,
          });
          await options.beforeCommit?.(signal);
          signal.throwIfAborted();
          this.assertOpen();
          options.onReady?.();
          this.publish("session_changed", {
            previousSessionId,
            cwd: this.cwd,
            input: manager.initialInput,
          });
        } catch (error) {
          if (
            !previouslyRevoked &&
            this.revokedProjectCwds.has(previousEnvironment.project.cwd)
          ) {
            replaced = true;
          }
          if (replaced) {
            this.taskUnsubscribe?.();
            if (!previousDisposed) {
              await disposeEnvironment(previousEnvironment).catch(
                () => undefined,
              );
            }
            if (this.environment !== previousEnvironment) {
              await disposeEnvironment(this.environment).catch(() => undefined);
            }
          }
          this.options = previousOptions;
          this.authorizedProject = this.revokedProjectCwds.has(
            previousManager.cwd,
          )
            ? undefined
            : previousAuthorizedProject;
          this.manager = previousManager;
          if (
            resolvedManager === previousManager &&
            this.manager.leafId !== previousLeaf
          ) {
            this.manager.selectActiveLeaf(previousLeaf);
          }
          if (replaced && !this.isDisposed) {
            try {
              await this.initialize({
                restoreState: false,
                declarations: previousEnvironment.state,
                persistState: false,
              });
            } catch {
              await disposeEnvironment(this.environment).catch(() => undefined);
            }
          }
          throw error;
        }
      })
      .finally(() => {
        this.transition = undefined;
        this.transitionController = undefined;
        this.dispatchSteering();
        this.startPump();
      });
    return this.transition;
  }
  newSession(options: { cwd?: string; persist?: boolean } = {}): Promise<void> {
    return this.replace(
      () =>
        SessionManager.create(options.cwd ?? this.cwd, {
          persist: options.persist ?? this.manager.persistent,
        }),
      { restoreState: false },
    );
  }
  private async preflightRestoration(
    source: SessionManager,
    destination: string,
    signal: AbortSignal,
  ): Promise<AuthorizedProject | undefined> {
    const trust = this.revokedProjectCwds.has(destination)
      ? "deny"
      : this.options.trust;
    const global = sdkConfig(
      this.loadGlobalConfig
        ? { ...this.options, provider: undefined, client: undefined }
        : this.options,
    );
    const { onTrustRequest } = this.options;
    const { config, project } = await resolveProjectConfig(
      destination,
      global,
      {
        trust,
        authorizedProject: this.authorizedProject,
        onTrustRequest: onTrustRequest
          ? (request) => cancelOnSignal(() => onTrustRequest(request), signal)
          : undefined,
        overrides: this.options.overrides,
        disabled: this.options.disabled,
      },
    );
    try {
      signal.throwIfAborted();
      if (
        project.manifest.length &&
        !project.trusted &&
        trust !== "deny" &&
        !this.options.disabled &&
        (destination !== this.cwd || this.environment.project.trusted)
      ) {
        throw new Error(
          "Session restoration destination project trust was not approved",
        );
      }
      const saved = source.getRuntimeState();
      const fallback =
        saved &&
        !config.providers.some(
          (candidate) => candidate.name === saved.provider.name,
        )
          ? this.clientBindings.get(clientBindingKey(saved.provider))?.provider
          : undefined;
      const provider = saved
        ? resolveSessionProvider(saved, config, fallback)
        : (this.options.provider ?? config.providers[config.default_provider]);
      if (
        !provider ||
        (!provider.base_url &&
          !this.clientBindings.get(providerBindingKey(provider))?.client)
      ) {
        throw new Error(SDK_MODEL_TARGET_ERROR);
      }
      const client = this.clientBindings.get(
        providerBindingKey(provider),
      )?.client;
      if (client?.protocol && client.protocol !== provider.protocol) {
        throw new Error(
          "Session restoration provider and client protocols do not match",
        );
      }
      return project.trusted
        ? { identity: project.identity, fingerprint: project.fingerprint }
        : undefined;
    } finally {
      await project.dispose();
    }
  }
  private restore(
    source: () => SessionManager,
    options: SessionRestorationOptions,
  ): Promise<void> {
    let manager: SessionManager;
    let prepared: PreparedSessionRestoration;
    let authorizedProject: AuthorizedProject | undefined;
    return this.replace(
      async (signal) => {
        await prepared.assertCurrent(signal);
        return prepared.copy
          ? SessionManager.importStream(
              prepared.destination,
              manager.exportStream({ scope: "tree", format: "jsonl", signal }),
              { signal },
            )
          : manager;
      },
      {
        signal: options.signal,
        preflight: async (signal) => {
          manager = source();
          prepared = await prepareSessionRestoration(manager, this.cwd, {
            ...options,
            signal,
          });
          authorizedProject = await this.preflightRestoration(
            manager,
            prepared.destination,
            signal,
          );
          await prepared.assertCurrent(signal);
        },
        authorizedProject: () => authorizedProject,
      },
    );
  }
  switchSession(
    manager: SessionManager,
    options: SessionRestorationOptions = {},
  ): Promise<void> {
    return this.restore(() => manager, options);
  }
  resume(id: string, options: ResumeSessionOptions = {}): Promise<void> {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => !["cwd", "destination", "copy", "signal"].includes(key),
      ) ||
      (options.cwd !== undefined && typeof options.cwd !== "string")
    ) {
      return Promise.reject(new Error("Invalid session resume options"));
    }
    const { cwd = this.cwd, ...restoration } = options;
    return this.restore(() => SessionManager.open(cwd, id), restoration);
  }
  async navigate(
    entryId: string | null,
    options: { summary?: boolean | string; signal?: AbortSignal } = {},
  ): Promise<{ input?: string }> {
    let result: { input?: string } = {};
    let summary: BranchSummaryPayload | undefined;
    await this.replace(
      async (signal) => {
        const revision = this.manager.revision;
        const plan =
          options.summary === true || typeof options.summary === "string"
            ? prepareBranchSummary(this.manager, entryId)
            : undefined;
        const navigation =
          plan?.navigation ?? this.manager.resolveNavigation(entryId);
        if (plan) {
          summary = await generateBranchSummary(
            plan,
            this.environment.runtime.client,
            {
              ledger: this.environment.ledger,
              signal,
              description:
                typeof options.summary === "string"
                  ? options.summary
                  : undefined,
            },
          );
        }
        signal.throwIfAborted();
        if (this.manager.revision !== revision) {
          throw new SessionConflictError(revision, this.manager.revision);
        }
        this.manager.selectActiveLeaf(navigation.leafId);
        result =
          navigation.input === undefined ? {} : { input: navigation.input };
        return this.manager;
      },
      {
        signal: options.signal,
        onReady: () => {
          if (!summary) {
            return;
          }
          this.manager.appendBranchSummary(summary.targetLeafId, summary);
          this.environment.runtime.conv.appendMessages([
            {
              role: "user",
              content: buildBranchSummaryReminder(summary),
              fileOperations: summary.details,
            },
          ]);
          this.memoryCursor = this.environment.runtime.conv.len();
        },
      },
    );
    return result;
  }
  fork(userEntryId: string): Promise<void> {
    return this.replace(() => {
      const manager = this.manager.fork(userEntryId);
      this.inheritedCosts.set(manager.id, {
        entries: this.environment.ledger.getEntries(),
        runs: this.environment.ledger.getRuns(),
      });
      return manager;
    });
  }
  clone(): Promise<void> {
    return this.replace(() => {
      const manager = this.manager.clone();
      this.inheritedCosts.set(manager.id, {
        entries: this.environment.ledger.getEntries(),
        runs: this.environment.ledger.getRuns(),
      });
      return manager;
    });
  }
  import(serialized: string, cwd = this.cwd): Promise<void> {
    if (Buffer.byteLength(serialized) > MAX_SESSION_STRING_BYTES) {
      return Promise.reject(
        new Error(
          "Session string byte limit exceeded; use stream/file transport",
        ),
      );
    }
    return this.importStream(
      Readable.from(
        (function* () {
          const bytes = Buffer.from(serialized);
          for (
            let offset = 0;
            offset < bytes.length;
            offset += SESSION_TRANSPORT_CHUNK_BYTES
          ) {
            yield bytes.subarray(
              offset,
              offset + SESSION_TRANSPORT_CHUNK_BYTES,
            );
          }
        })(),
      ),
      { cwd },
    );
  }
  importFile(path: string, options: SessionImportOptions = {}): Promise<void> {
    return this.importStream(sessionImportFileBytes(path, options), options);
  }
  importStream(
    source: AsyncIterable<Uint8Array>,
    options: SessionImportOptions = {},
  ): Promise<void> {
    this.assertOpen();
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !["cwd", "signal"].includes(key)) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    ) {
      return Promise.reject(new Error("Invalid session import options"));
    }
    const requested = options.cwd ?? this.cwd;
    if (typeof requested !== "string" || !isAbsolute(requested)) {
      return Promise.reject(
        new Error(
          "Session import destination must be an absolute existing directory",
        ),
      );
    }
    const previous = this.manager;
    previous.refresh();
    const revision = previous.revision;
    let staged:
      Awaited<ReturnType<typeof SessionManager.stageImportStream>> | undefined;
    let imported: SessionManager | undefined;
    let authorizedProject: AuthorizedProject | undefined;
    let projectIdentity: Awaited<ReturnType<typeof discoverProject>>;
    let destination: string;
    let directory: Awaited<ReturnType<typeof stat>>;
    const assertBinding = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      this.assertOpen();
      previous.refresh();
      if (this.manager !== previous || previous.revision !== revision) {
        throw new SessionConflictError(revision, previous.revision);
      }
    };
    const assertDestination = async (signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if ((await realpath(requested)) !== destination) {
        throw new Error("Session import destination changed");
      }
      const current = await stat(destination);
      if (
        !current.isDirectory() ||
        current.dev !== directory.dev ||
        current.ino !== directory.ino
      ) {
        throw new Error("Session import destination changed");
      }
      const project = await discoverProject(destination);
      if (
        project.identity !== projectIdentity.identity ||
        project.fingerprint !== projectIdentity.fingerprint
      ) {
        throw new Error(
          "Session import project trust changed before publication",
        );
      }
      signal.throwIfAborted();
    };
    return this.replace(
      async (signal) => {
        await assertDestination(signal);
        if (!staged) {
          throw new Error("Missing validated session import");
        }
        imported = staged.publish();
        return imported;
      },
      {
        signal: options.signal,
        preflight: async (signal) => {
          assertBinding(signal);
          destination = await realpath(requested);
          directory = await stat(destination);
          if (!directory.isDirectory()) {
            throw new Error(
              "Session import destination must be an existing directory",
            );
          }
          staged = await SessionManager.stageImportStream(destination, source, {
            signal,
          });
          assertBinding(signal);
          projectIdentity = await discoverProject(destination);
          authorizedProject = await this.preflightRestoration(
            staged.manager,
            destination,
            signal,
          );
          assertBinding(signal);
          await assertDestination(signal);
        },
        authorizedProject: () => authorizedProject,
        rejectTrustRequest: true,
        beforeCommit: assertDestination,
      },
    ).finally(() => {
      if (this.manager !== imported) {
        staged?.discard();
      }
    });
  }

  private exclusive<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertIdle();
    const controller = new AbortController();
    this.operationController = controller;
    const operation = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => {
        this.operation = undefined;
        this.operationController = undefined;
        this.startPump();
      });
    this.operation = operation;
    return operation;
  }
  compact(description = "") {
    return this.exclusive((signal) =>
      withExecutionContext(
        {
          sessionId: this.sessionId,
          runId: randomUUID(),
          agentId: "main",
          purpose: "compaction",
          ledger: this.environment.ledger,
        },
        async () => {
          await this.environment.runtime.cache.invalidate("compaction");
          const h = this.environment.runtime;
          const filter = h.toolFilter ?? undefined;
          const result = await forceCompact(
            h.conv,
            h.client,
            h.recoveryState,
            h.registry.listVisibleToolNames(h.client.protocol, filter),
            h.registry.getAllSchemas(
              h.client.protocol ?? h.provider.protocol,
              filter,
            ),
            "",
            signal,
            description,
          );
          if (result.boundary) {
            if (this.manager.persistent) {
              saveCompactBoundary(this.cwd, this.sessionId, result.boundary);
            }
            this.syncMessages({
              type: "compact",
              message: result.message,
              boundary: result.boundary,
            });
          }
          this.publish("compact", {
            message: result.message,
            boundary: result.boundary,
          });
          return result;
        },
      ),
    );
  }
  getModel(): ProviderConfig {
    const provider = structuredClone(this.environment.runtime.provider);
    delete provider.api_key;
    return provider;
  }
  getAvailableModels() {
    return this.environment.config.providers.map((provider) => ({
      name: provider.name,
      protocol: provider.protocol,
      base_url: provider.base_url,
      model: provider.model,
      thinking: provider.thinking,
      reasoning: provider.reasoning,
      context_window: provider.context_window,
      max_output_tokens: provider.max_output_tokens,
    }));
  }
  cycleModel(direction: 1 | -1 = 1): Promise<void> {
    this.assertIdle();
    const providers = this.environment.config.providers;
    if (!providers.length) {
      return Promise.resolve();
    }
    const current = this.environment.runtime.provider;
    const index = providers.findIndex(
      (provider) =>
        provider.name === current.name &&
        provider.model === current.model &&
        provider.base_url === current.base_url,
    );
    return this.setModel(
      providers[
        index < 0
          ? direction === 1
            ? 0
            : providers.length - 1
          : (index + direction + providers.length) % providers.length
      ],
    );
  }
  cycleThinkingLevel(direction: 1 | -1 = 1): ThinkingLevel {
    const levels =
      this.environment.runtime.client.getSupportedThinkingLevels?.() ??
      getSupportedThinkingLevels(this.environment.runtime.provider);
    if (!levels.length) {
      return this.getThinking();
    }
    const index = levels.indexOf(this.getThinking());
    return this.setThinking(
      levels[
        index < 0
          ? direction === 1
            ? 0
            : levels.length - 1
          : (index + direction + levels.length) % levels.length
      ],
    );
  }
  getSettings() {
    return {
      values: structuredClone(this.environment.runtime.preferences),
      sources: this.environment.project
        .getSources()
        .filter(
          (source) => source.field in this.environment.runtime.preferences,
        )
        .map((source) =>
          Object.hasOwn(this.options.overrides ?? {}, source.field)
            ? { ...source, scope: "override" as const }
            : source,
        ),
    };
  }
  setSettings(
    input: PreferencesPatch,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    const patch = PreferencesPatchSchema.parse(input);
    return this.exclusive(async () => {
      if (options.persist) {
        persistPreferences(patch, this.options.configPath);
      }
      applyRuntimePreferences(this.environment.runtime, patch);
      this.options.overrides = mergePreferences(
        this.options.overrides ?? {},
        patch,
      );
      this.steeringMode = this.environment.runtime.preferences.steering_mode;
      this.followUpMode = this.environment.runtime.preferences.follow_up_mode;
      await this.environment.runtime.cache.invalidate("branch_change");
    });
  }
  setAutoCompaction(enabled: boolean): void {
    this.assertOpen();
    applyRuntimePreferences(
      this.environment.runtime,
      PreferencesPatchSchema.parse({ auto_compaction: enabled }),
    );
    this.options.overrides = {
      ...this.options.overrides,
      auto_compaction: enabled,
    };
  }
  setAutoRetry(enabled: boolean): void {
    this.assertOpen();
    applyRuntimePreferences(
      this.environment.runtime,
      PreferencesPatchSchema.parse({ auto_retry: enabled }),
    );
    this.options.overrides = { ...this.options.overrides, auto_retry: enabled };
  }
  abortRetry(): boolean {
    this.assertOpen();
    return this.environment.runtime.abortRetry();
  }
  reloadResources() {
    return this.exclusive(async (signal) => {
      const global = this.options.configPath
        ? loadConfig(this.options.configPath)
        : this.loadGlobalConfig
          ? loadConfig()
          : sdkConfig(this.options);
      const result = await reloadRuntimeResources(this.environment, global, {
        overrides: this.options.overrides,
        disabled: this.options.disabled,
        trust: this.revokedProjectCwds.has(this.cwd)
          ? "deny"
          : this.options.trust,
        onTrustRequest: this.options.onTrustRequest,
        signal,
      });
      this.steeringMode = this.environment.runtime.preferences.steering_mode;
      this.followUpMode = this.environment.runtime.preferences.follow_up_mode;
      this.authorizedProject = this.environment.project.trusted
        ? {
            identity: this.environment.project.identity,
            fingerprint: this.environment.project.fingerprint,
          }
        : undefined;
      this.syncMessages();
      this.captureRuntimeState();
      this.options.config = global;
      return result;
    });
  }
  setModel(model: string | ProviderConfig, client?: LLMClient): Promise<void> {
    const current = this.environment.runtime.provider;
    const provider =
      typeof model !== "string"
        ? structuredClone(model)
        : model === current.model
          ? { ...current }
          : {
              name: current.name,
              protocol: current.protocol,
              base_url: current.base_url,
              api_key: current.api_key,
              model,
            };
    const replacement =
      client ?? this.clientBindings.get(providerBindingKey(provider))?.client;
    if (!provider.base_url && !replacement) {
      return Promise.reject(new Error(SDK_MODEL_TARGET_ERROR));
    }
    return this.replace(
      () => {
        this.options = {
          ...this.options,
          provider: structuredClone(provider),
          thinking: provider.thinking ?? this.options.thinking,
          client: replacement,
        };
        return this.manager;
      },
      { restoreState: false },
    );
  }
  getThinking(): ThinkingLevel {
    return (
      this.environment.runtime.client.getThinkingLevel?.() ??
      this.environment.runtime.provider.thinking ??
      "off"
    );
  }
  setThinking(level: ThinkingLevel): ThinkingLevel {
    this.assertIdle();
    const effective = this.environment.runtime.setThinking(level);
    this.options.thinking = effective;
    this.options.provider = structuredClone(this.environment.runtime.provider);
    this.captureRuntimeState();
    return effective;
  }
  getWarmingState() {
    return this.environment.runtime.cache.getStatus().warming;
  }
  stopWarming(): Promise<void> {
    return this.environment.runtime.cache.pause("user_stopped");
  }
  resumeWarming(): void {
    this.assertOpen();
    this.environment.runtime.cache.resume();
  }
  getStatus() {
    return this.environment.runtime.getStatus();
  }
  getStats(filter: EntryFilter = {}) {
    return this.environment.ledger.summary(filter);
  }
  getCostEntries(filter: EntryFilter = {}) {
    return this.environment.ledger.getEntries(filter);
  }
  getProjectSources() {
    return this.environment.project.getSources();
  }
  revokeProjectTrust(): Promise<void> {
    return this.replace(
      async () => {
        const project = this.environment.project;
        this.revokedProjectCwds.add(project.cwd);
        if (this.authorizedProject?.identity === project.identity) {
          this.authorizedProject = undefined;
        }
        await project.revoke();
        return this.manager;
      },
      { restoreState: false },
    );
  }
  getTasks() {
    return this.environment.runtime.backgroundTaskManager
      .list()
      .map(({ cancel: _cancel, done: _done, ...task }) =>
        structuredClone(task),
      );
  }
  stopTask(id: string): Promise<boolean> {
    this.assertOpen();
    return this.environment.runtime.backgroundTaskManager.stopAndWait(id);
  }
  waitTask(id: string, options: { timeoutMs: number; signal?: AbortSignal }) {
    return this.environment.runtime.backgroundTaskManager.wait(id, {
      timeoutMs: options.timeoutMs,
      abortSignal: options.signal,
    });
  }
  getWorkflowState() {
    return (
      getWorkflowService(
        this.environment.runtime.registry,
      )?.store.getSnapshot() ?? []
    );
  }
  stopWorkflow(runId: string): boolean {
    this.assertOpen();
    return (
      getWorkflowService(this.environment.runtime.registry)?.kill(runId) ??
      false
    );
  }
  runWorkflow(input: WorkflowInput) {
    return this.exclusive(async (signal) => {
      const service = getWorkflowService(this.environment.runtime.registry);
      if (!service) {
        throw new Error("Workflow is excluded from this session");
      }
      const ctx = await this.authorizedContext(
        "Workflow",
        { ...input },
        signal,
      );
      return withExecutionContext(
        {
          sessionId: this.sessionId,
          runId: randomUUID(),
          agentId: "main",
          purpose: "workflow",
          ledger: this.environment.ledger,
        },
        () => service.launch(input, ctx),
      );
    });
  }
  getCodeModeState(): {
    activeToolCallIds: string[];
    foregroundToolsRunning: boolean;
  } {
    return {
      activeToolCallIds: [...this.codeModeCalls],
      foregroundToolsRunning: hasAnyForegroundTasks(
        this.environment.runtime.registry,
      ),
    };
  }
  stopCodeMode(): Promise<void> {
    return this.abort("foreground");
  }
  getMCPState() {
    const manager = this.environment.runtime.mcpManager;
    return {
      connectedServers: manager?.connectedServers() ?? [],
      servers: manager?.states() ?? [],
    };
  }
  registerMCPServer(config: MCPServerConfig) {
    assertBoundedJson(config);
    const snapshot = MCPServerConfigSchema.parse(structuredClone(config));
    return this.exclusive((signal) =>
      this.mcpManagement.register(snapshot, signal),
    );
  }
  connectMCPServer(name: string) {
    return this.exclusive((signal) => this.mcpManagement.connect(name, signal));
  }
  disconnectMCPServer(name: string): Promise<void> {
    return this.exclusive((signal) =>
      this.mcpManagement.disconnect(name, signal),
    );
  }
  reloadMCPServer(name: string, config?: MCPServerConfig) {
    if (config) {
      assertBoundedJson(config);
    }
    const snapshot =
      config && MCPServerConfigSchema.parse(structuredClone(config));
    return this.exclusive((signal) =>
      this.mcpManagement.reload(name, snapshot, signal),
    );
  }
  unregisterMCPServer(name: string): Promise<void> {
    return this.exclusive((signal) =>
      this.mcpManagement.unregister(name, signal),
    );
  }
  setMCPExposure(
    server: string,
    exposure: MCPExposure,
    rules?: MCPServerConfig["tool_exposure"],
  ): Promise<void> {
    if (rules) {
      assertBoundedJson(rules);
    }
    const snapshot = MCPServerConfigSchema.parse({
      name: server,
      enabled: false,
      exposure,
      tool_exposure: rules && structuredClone(rules),
    });
    return this.exclusive((signal) =>
      this.mcpManagement.setExposure(
        server,
        exposure,
        snapshot.tool_exposure,
        signal,
      ),
    );
  }
  loginMCP(server: string, options: MCPLoginOptions): Promise<void> {
    const snapshot = { ...options };
    assertBoundedJson({
      ...snapshot,
      signal: undefined,
      onAuthorization: undefined,
    });
    if (
      typeof snapshot.onAuthorization !== "function" ||
      (snapshot.signal !== undefined &&
        !(snapshot.signal instanceof AbortSignal))
    ) {
      throw new Error("Invalid MCP login options");
    }
    return this.exclusive((signal) =>
      this.mcpManagement.login(server, snapshot, signal),
    );
  }
  logoutMCP(server: string): Promise<void> {
    return this.exclusive((signal) =>
      this.mcpManagement.logout(server, signal),
    );
  }
  listMCPResources(
    server: string,
    options: {
      templates?: boolean;
      cursor?: string;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    const { signal: resourceSignal, ...page } = options;
    assertBoundedJson(page);
    const snapshot = { ...structuredClone(page), signal: resourceSignal };
    if (
      resourceSignal !== undefined &&
      !(resourceSignal instanceof AbortSignal)
    ) {
      throw new Error("Invalid MCP resource signal");
    }
    return this.exclusive((signal) =>
      this.mcpManagement.listResources(server, snapshot, signal),
    );
  }
  readMCPResource(
    server: string,
    uri: string,
    options: { signal?: AbortSignal } = {},
  ) {
    const snapshot = { ...options };
    assertBoundedJson({ ...snapshot, signal: undefined });
    if (
      snapshot.signal !== undefined &&
      !(snapshot.signal instanceof AbortSignal)
    ) {
      throw new Error("Invalid MCP resource signal");
    }
    return this.exclusive((signal) =>
      this.mcpManagement.readResource(server, uri, snapshot, signal),
    );
  }
  private authorizedContext(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolContext> {
    return authorizeRuntimeTool(
      this.environment.runtime,
      name,
      args,
      signal,
      this.permissionHandler,
      "host",
    );
  }
  userBash(
    command: string,
    options: { excludeFromContext?: boolean } = {},
  ): Promise<UserBashResult> {
    return this.exclusive(async (signal) => {
      const h = this.environment.runtime;
      const ctx = await this.authorizedContext("Bash", { command }, signal);
      const tool = h.registry.getInstanceOf("Bash", BashTool);
      if (!tool) {
        throw new Error("Bash is excluded from this session");
      }
      const started = Date.now();
      const toolId = ctx.toolCallId ?? randomUUID();
      this.publish(
        "tool_use",
        { toolId, toolName: "Bash", args: { command } },
        "agent",
      );
      let previousOutput = "";
      const result = await executeUserBash(
        tool,
        {
          ...ctx,
          onOutput: (output) => {
            const current = plainTerminalText(output);
            const delta = current.startsWith(previousOutput)
              ? current.slice(previousOutput.length)
              : current;
            previousOutput = current;
            if (delta) {
              this.publish("tool_output", { toolId, output: delta });
            }
          },
        },
        command,
        options.excludeFromContext ?? false,
      );
      const bash: UserBashResult = {
        command,
        output: result.output,
        isError: result.isError,
        elapsed: (Date.now() - started) / 1000,
        status: signal.aborted
          ? "stopped"
          : result.isError
            ? "failed"
            : "completed",
        excludeFromContext: options.excludeFromContext ?? false,
      };
      if (this.manager.persistent) {
        recordInput({
          text: `${bash.excludeFromContext ? "!!" : "!"}${command}`,
          cwd: this.cwd,
          sessionId: this.sessionId,
          source: this.options.inputSource ?? "sdk",
        });
      }
      const message: Message = {
        role: "user",
        content: bash.excludeFromContext ? "" : userBashContext(bash),
        userBash: bash,
      };
      if (!bash.excludeFromContext) {
        h.conv.appendMessages([message]);
      }
      this.manager.append(message);
      this.memoryCursor = h.conv.len();
      this.publish(
        "tool_result",
        {
          toolId,
          toolName: "Bash",
          output: bash.output,
          isError: bash.isError,
          elapsed: bash.elapsed,
        },
        "agent",
      );
      return bash;
    });
  }
  dispose(): Promise<void> {
    this.disposal ??= Promise.resolve().then(async () => {
      this.clearQueue();
      const cancellations = await Promise.allSettled([
        Promise.resolve().then(() => this.abort("all")),
      ]);
      await Promise.allSettled([this.pump, this.operation, this.transition]);
      this.taskUnsubscribe?.();
      if (this.lifetimeAbort) {
        this.options.signal?.removeEventListener("abort", this.lifetimeAbort);
      }
      const results = await Promise.allSettled([
        this.environment.project.dispose(),
        this.environment.runtime.dispose(),
      ]);
      await Promise.all(
        [...this.memoryArtifactOwners].map((id) =>
          rm(sessionPath(id), { recursive: true, force: true }),
        ),
      );
      this.clientBindings.clear();
      this.publish("disposed", {});
      this.listeners.clear();
      const errors = [...cancellations, ...results]
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result): unknown => result.reason);
      if (errors.length) {
        throw new AggregateError(errors, "Session cleanup failed");
      }
    });
    return this.disposal;
  }
}
