import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import type { AgentEvent } from "@/agent/events.js";
import { Agent, type SteeringMessage } from "@/agent/index.js";
import { RuntimeCacheController } from "@/cache/controller.js";
import { isTrackedRequestClient } from "@/cache/requests.js";
import { parse as parseCommand } from "@/commands/commands.js";
import { RecoveryState } from "@/compact/recovery.js";
import { RuntimePreferencesSchema } from "@/config/preferences.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  ProviderConfigSchema,
  type ThinkingLevel,
} from "@/config/provider-config.js";
import {
  bindExecutionContext,
  getExecutionContext,
  withExecutionContext,
} from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import { FileHistory } from "@/file-history/index.js";
import { GoalManager, handleGoalCommand } from "@/goal/index.js";
import * as historyMod from "@/history/index.js";
import { measureClient } from "@/llm/client.js";
import { createChildLogger } from "@/logger/index.js";
import { syncMcpInstructions } from "@/mcp/instructions.js";
import { BackgroundMemoryTasks } from "@/memory/background.js";
import { loadInstructions } from "@/memory/instructions.js";
import { PermissionChecker } from "@/permissions/index.js";
import {
  RUNTIME_BUSY_ERROR,
  RUNTIME_DISPOSED_ERROR,
  RUNTIME_PROVIDER_CLIENT_ERROR,
  RUNTIME_PROVIDER_PROTOCOL_ERROR,
} from "@/runtime/constants.js";
import { getRuntimeStatus } from "@/runtime/status.js";
import type {
  AgentRuntime,
  CreateRuntimeOptions,
  RunCallbacks,
} from "@/runtime/types.js";
import {
  getSessionFilePath,
  newSessionId,
  saveUserMessage,
} from "@/session/index.js";
import {
  acquireSessionRunLease,
  inspectSessionStoragePath,
  withSessionStorageLock,
  type SessionRunLeaseHandle,
} from "@/session/lease.js";
import {
  ensureSessionHeaderUnderLock,
  getEntryPath,
  readSessionDocument,
} from "@/session/records.js";
import { buildSkillSection } from "@/skills/prompts.js";
import { sessionPath } from "@/storage/index.js";
import { formatAgentTaskNotification } from "@/subagent/prompts.js";
import {
  registerSessionStorageTarget,
  resolveSessionStorageTarget,
} from "@/subagent/task-manager.js";
import {
  coordinatorActive,
  coordinatorToolFilter,
} from "@/teams/coordinator.js";
import { tryAcquireFileSyncLock } from "@/teams/file-lock.js";
import { TaskStore } from "@/todo/store.js";
import { BashTool } from "@/tools/bash.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { contentToText } from "@/utils/index.js";

const log = createChildLogger({ module: "runtime" });

export type RuntimeState = Omit<
  AgentRuntime,
  | "cache"
  | "preferences"
  | "abortRetry"
  | "setThinking"
  | "updateProvider"
  | "getStatus"
  | "goalManager"
  | "ownSubagentSession"
  | "planFilePath"
  | "checker"
  | "permissionMode"
  | "mcpAnnounced"
  | "run"
  | "abort"
  | "abortForeground"
  | "steer"
  | "removeSteering"
  | "takeSteeringLeftovers"
  | "clearConversation"
  | "stopMemoryTasks"
  | "dispose"
>;

export function composeAgentToolFilter(
  enableCoordinatorMode: boolean,
  handleFilter: ((name: string) => boolean) | null,
): (name: string) => boolean {
  const coordinatorFilter = coordinatorToolFilter(enableCoordinatorMode);
  return (name) => coordinatorFilter(name) && (handleFilter?.(name) ?? true);
}

export class AgentRuntimeImpl implements AgentRuntime {
  preferences: AgentRuntime["preferences"];
  abortRetry(): boolean {
    return this.currentAgent?.abortRetry() ?? false;
  }
  client: AgentRuntime["client"];
  cache: RuntimeCacheController;
  private providerClient: AgentRuntime["client"];
  private providerUpdateTail: Promise<void> = Promise.resolve();
  private providerUpdates = 0;
  private conversationReset?: Promise<void>;
  systemPrompt: AgentRuntime["systemPrompt"];
  conv: AgentRuntime["conv"];
  registry: AgentRuntime["registry"];
  sessionId: string;
  executionContext: AgentRuntime["executionContext"];
  private standaloneExecutionContext: AgentRuntime["executionContext"];
  private subagentSessions = new Set<string>();
  ownSubagentSession(sessionId: string): void {
    this.subagentSessions.add(sessionId);
  }
  private async cleanupSubagentSessions(): Promise<void> {
    await Promise.all(
      [...this.subagentSessions].map((id) =>
        rm(sessionPath(id), { recursive: true, force: true }),
      ),
    );
    this.subagentSessions.clear();
  }
  fileHistory: AgentRuntime["fileHistory"];
  fileStateCache: AgentRuntime["fileStateCache"];
  cmdRegistry: AgentRuntime["cmdRegistry"];
  skillCatalog: AgentRuntime["skillCatalog"];
  activeSkills: AgentRuntime["activeSkills"];
  toolFilter: AgentRuntime["toolFilter"];
  mcpManager: AgentRuntime["mcpManager"];
  mcpSource: AgentRuntime["mcpSource"];
  refreshMcpTools: AgentRuntime["refreshMcpTools"];
  hookEngine: AgentRuntime["hookEngine"];
  recoveryState: AgentRuntime["recoveryState"];
  teamManager: AgentRuntime["teamManager"];
  backgroundTaskManager: AgentRuntime["backgroundTaskManager"];
  enableCoordinatorMode: boolean;
  memoryManager: AgentRuntime["memoryManager"];
  memoryEnabled: boolean;
  contextWindow: number;
  provider: AgentRuntime["provider"];
  cwd: string;
  checker: PermissionChecker;
  taskList: AgentRuntime["taskList"];
  mcpAnnounced = new Set<string>();
  private sessionGoal?: GoalManager;
  private memoryTasks: BackgroundMemoryTasks | null = null;
  private memoryCleanup: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private abortController: AbortController | null = null;
  private currentAgent: Agent | null = null;
  private steeringLeftovers: SteeringMessage[] = [];
  private runClosed: Promise<void> = Promise.resolve();

  constructor(
    state: RuntimeState,
    private options: CreateRuntimeOptions,
  ) {
    this.preferences = RuntimePreferencesSchema.parse(
      options.preferences ?? { code_mode: options.codeMode },
    );
    this.client = state.client;
    this.providerClient = state.client;
    this.systemPrompt = state.systemPrompt;
    this.conv = state.conv;
    this.registry = state.registry;
    this.sessionId = state.sessionId;
    this.executionContext = state.executionContext;
    this.standaloneExecutionContext = state.executionContext;
    this.fileHistory = state.fileHistory;
    this.fileStateCache = state.fileStateCache;
    this.cmdRegistry = state.cmdRegistry;
    this.skillCatalog = state.skillCatalog;
    this.activeSkills = state.activeSkills;
    this.toolFilter = state.toolFilter;
    this.mcpManager = state.mcpManager;
    this.mcpSource = state.mcpSource;
    this.refreshMcpTools = state.refreshMcpTools;
    this.hookEngine = state.hookEngine;
    this.recoveryState = state.recoveryState;
    this.teamManager = state.teamManager;
    this.backgroundTaskManager = state.backgroundTaskManager;
    this.enableCoordinatorMode = state.enableCoordinatorMode;
    this.memoryManager = state.memoryManager;
    this.memoryEnabled = state.memoryEnabled;
    this.contextWindow = state.contextWindow;
    this.provider = ProviderConfigSchema.parse(state.provider);
    this.cwd = state.cwd;
    this.taskList = state.taskList;
    this.checker = options.checker ?? new PermissionChecker(this.cwd);
    this.checker.sandboxEnabled =
      this.registry.getInstanceOf("Bash", BashTool)?.sandboxRequired ?? false;
    this.checker.sandboxAutoAllow = options.sandboxConfig?.auto_allow ?? false;
    this.teamManager.setPermissionChecker(this.checker);
    this.ensureSessionStorage();
    this.cache = this.createCache(this.provider, this.providerClient);
    this.client = this.cache.client;
  }

  private ensureSessionStorage(): void {
    if (this.options.persist === false) {
      return;
    }
    withSessionStorageLock(
      { cwd: this.cwd, sessionId: this.sessionId },
      (identity) => {
        inspectSessionStoragePath(
          identity.storageRoot,
          identity.transcriptPath,
        );
        ensureSessionHeaderUnderLock(identity.transcriptPath);
      },
    );
  }

  private createCache(
    provider: AgentRuntime["provider"],
    client: AgentRuntime["client"],
  ): RuntimeCacheController {
    const context = this.executionContext ?? {
      sessionId: this.sessionId,
      runId: randomUUID(),
      agentId: "main",
      purpose: "main" as const,
      ledger: createCostLedger({
        sessionId: this.sessionId,
        cwd: this.cwd,
        persist: this.options.persist !== false,
      }),
    };
    this.executionContext = context;
    registerSessionStorageTarget(
      context.ledger,
      this.options.persist === false
        ? null
        : { cwd: this.cwd, sessionId: this.sessionId },
    );
    registerSessionStorageTarget(
      context.ledger,
      this.options.persist === false
        ? null
        : (resolveSessionStorageTarget(
            { cwd: this.cwd, sessionId: this.sessionId },
            context,
          ) ?? { cwd: this.cwd, sessionId: this.sessionId }),
      this.sessionId,
    );
    return new RuntimeCacheController({
      provider,
      client,
      context,
      conversation: this.conv,
      systemPrompt: this.systemPrompt ?? "",
      cwd: this.cwd,
      storageTarget:
        this.options.persist === false
          ? null
          : (resolveSessionStorageTarget(
              { cwd: this.cwd, sessionId: this.sessionId },
              context,
            ) ?? null),
      registry: this.registry,
      toolFilter: () =>
        composeAgentToolFilter(this.enableCoordinatorMode, this.toolFilter),
      goalStatus: () => this.goalManager?.get()?.status,
      cacheGuard: this.cache?.getGuard() ?? this.options.cacheGuard,
      branch: (requestBranch) => {
        if (this.disposal || this.abortController?.signal.aborted) {
          return false;
        }
        if (this.options.persist === false) {
          return requestBranch === this.sessionId;
        }
        const path = getSessionFilePath(this.cwd, this.sessionId);
        const release = tryAcquireFileSyncLock(path);
        if (!release) {
          return false;
        }
        try {
          const document = readSessionDocument(path);
          return (
            document !== null &&
            getEntryPath(document).some(
              (entry) => entry.entryId === requestBranch,
            )
          );
        } finally {
          release();
        }
      },
    });
  }

  getStatus(): ReturnType<typeof getRuntimeStatus> {
    return getRuntimeStatus(this);
  }

  setThinking(level: ThinkingLevel): ThinkingLevel {
    if (this.disposal) {
      throw new Error(RUNTIME_DISPOSED_ERROR);
    }
    if (
      this.abortController ||
      this.providerUpdates ||
      this.conversationReset
    ) {
      throw new Error(RUNTIME_BUSY_ERROR);
    }
    if (!this.client.setThinkingLevel) {
      throw new Error("Client does not support thinking control");
    }
    const effective = this.client.setThinkingLevel(level);
    this.provider = { ...this.provider, thinking: effective };
    void this.cache.invalidate("thinking_change");
    return effective;
  }

  async updateProvider(
    provider: AgentRuntime["provider"],
    client: AgentRuntime["client"],
  ): Promise<AgentRuntime["client"]> {
    const next = ProviderConfigSchema.parse(provider);
    if (client.protocol !== undefined && client.protocol !== next.protocol) {
      throw new Error(RUNTIME_PROVIDER_PROTOCOL_ERROR);
    }
    if (this.disposal) {
      throw new Error(RUNTIME_DISPOSED_ERROR);
    }
    if (this.abortController || this.conversationReset) {
      throw new Error(RUNTIME_BUSY_ERROR);
    }
    this.providerUpdates++;
    const update = this.providerUpdateTail.then(async () => {
      if (this.disposal) {
        throw new Error(RUNTIME_DISPOSED_ERROR);
      }
      if (client === this.client) {
        if (isDeepStrictEqual(next, this.provider)) {
          return this.client;
        }
        throw new Error(RUNTIME_PROVIDER_CLIENT_ERROR);
      }
      if (isTrackedRequestClient(client)) {
        throw new Error(RUNTIME_PROVIDER_CLIENT_ERROR);
      }
      const measured = measureClient(client, next);
      if (this.systemPrompt !== undefined) {
        measured.setSystemPrompt(this.systemPrompt);
      }
      measured.setMaxOutputTokens?.(getMaxOutputTokens(next));
      if (next.thinking !== undefined) {
        measured.setThinkingLevel?.(next.thinking);
      }
      const cache = this.createCache(next, measured);
      try {
        await this.cache.dispose();
        await this.stopMemoryTasks();
        if (this.disposal) {
          throw new Error(RUNTIME_DISPOSED_ERROR);
        }
        this.provider = next;
        this.contextWindow = getContextWindow(next);
        this.providerClient = measured;
        this.cache = cache;
        this.client = cache.client;
        return this.client;
      } catch (error) {
        await cache.dispose();
        throw error;
      }
    });
    this.providerUpdateTail = update.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await update;
    } finally {
      this.providerUpdates--;
    }
  }

  get goalManager(): GoalManager | undefined {
    if (this.sessionGoal?.sessionId !== this.sessionId) {
      this.sessionGoal = new GoalManager(this.cwd, this.sessionId, {
        persist: this.options.persist !== false,
      });
    }
    return this.sessionGoal;
  }
  set goalManager(manager: GoalManager | undefined) {
    this.sessionGoal = manager;
  }
  get planFilePath(): string {
    return this.checker.planFilePath;
  }
  set planFilePath(path: string) {
    this.checker.planFilePath = path;
  }
  get permissionMode(): AgentRuntime["permissionMode"] {
    return this.checker.mode;
  }
  set permissionMode(mode: AgentRuntime["permissionMode"]) {
    this.checker.mode = mode;
  }

  private createInput(text: string): historyMod.InputEntry {
    const options: historyMod.InputOptions = {
      text,
      cwd: this.cwd,
      sessionId: this.sessionId,
      source: "sdk",
      commandName: parseCommand(text)?.name === "goal" ? "goal" : null,
    };
    return this.options.persist === false
      ? {
          ...options,
          type: "input",
          id: randomUUID(),
          timestamp: Date.now(),
          commandName: options.commandName ?? null,
        }
      : historyMod.recordInput(options);
  }

  run(
    text: string | Record<string, unknown>[] | null,
    callbacks: RunCallbacks,
  ): AsyncGenerator<AgentEvent> {
    const inherited = getExecutionContext();
    const ledger =
      this.executionContext?.ledger ??
      inherited?.ledger ??
      createCostLedger({
        sessionId: this.sessionId,
        cwd: this.cwd,
        persist: this.options.persist !== false,
      });
    const standalone =
      this.standaloneExecutionContext?.ledger === ledger
        ? this.standaloneExecutionContext
        : this.executionContext;
    const context =
      inherited?.ledger === ledger && inherited.sessionId === ledger.sessionId
        ? inherited
        : {
            sessionId: ledger.sessionId,
            runId: randomUUID(),
            parentRunId: standalone?.parentRunId,
            agentId: standalone?.agentId ?? "main",
            purpose: standalone?.purpose ?? "main",
            ledger,
          };
    const iterator = this.runLoop(text, callbacks, context);
    return withExecutionContext(context, () =>
      bindExecutionContext(iterator, context),
    );
  }

  private async *runLoop(
    text: string | Record<string, unknown>[] | null,
    callbacks: RunCallbacks,
    context: NonNullable<AgentRuntime["executionContext"]>,
  ): AsyncGenerator<AgentEvent> {
    if (this.disposal) {
      throw new Error(RUNTIME_DISPOSED_ERROR);
    }
    if (
      this.abortController ||
      this.providerUpdates ||
      this.conversationReset
    ) {
      throw new Error(RUNTIME_BUSY_ERROR);
    }
    this.executionContext = context;
    const controller = new AbortController();
    this.abortController = controller;
    const cache = this.cache;
    let successful = false;
    let close = (): void => undefined;
    this.runClosed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const leases: SessionRunLeaseHandle[] = [];
    try {
      if (this.options.persist !== false) {
        const target = { cwd: this.cwd, sessionId: this.sessionId };
        leases.push(acquireSessionRunLease(target, "foreground"));
        const root = resolveSessionStorageTarget(target, context);
        if (
          root &&
          (root.cwd !== target.cwd || root.sessionId !== target.sessionId)
        ) {
          leases.push(acquireSessionRunLease(root, "foreground"));
        }
      }
      await cache.beginRun(context);
      controller.signal.throwIfAborted();
      const input =
        text === null
          ? undefined
          : (callbacks.input ??
            this.createInput(
              typeof text === "string"
                ? text
                : contentToText(text) || "[attachments]",
            ));
      if (typeof text === "string") {
        const command = parseCommand(text);
        if (command?.name === "goal") {
          const goal = this.goalManager;
          if (!goal) {
            throw new Error("Goals require a persistent session");
          }
          const result = handleGoalCommand(goal, command.args);
          await cache.handleAgentEvent({ type: "turn_complete" });
          yield { type: "stream_text", text: result.message + "\n" };
          if (!result.prompt) {
            yield { type: "loop_complete", stopReason: "end_turn" };
            return;
          }
          yield { type: "turn_complete" };
          text = result.prompt;
        }
      }
      if (text !== null && input) {
        if (this.options.persist !== false) {
          saveUserMessage(this.cwd, this.sessionId, input, {
            content: callbacks.userContent ?? text,
          });
        }
        this.conv.addUserMessage(text, input);
      }
      for (const queued of callbacks.queuedInputs ?? []) {
        if (this.options.persist !== false) {
          saveUserMessage(this.cwd, this.sessionId, queued.input, {
            content: queued.content,
          });
        }
        this.conv.addUserMessage(queued.content, queued.input);
      }
      if (this.mcpManager) {
        syncMcpInstructions(this.conv, this.mcpAnnounced, this.mcpManager);
      }
      const coordinatorFilter = coordinatorToolFilter(
        this.enableCoordinatorMode,
      );
      const agent = new Agent({
        steeringMode: () => this.preferences.steering_mode,
        autoCompaction: () => this.preferences.auto_compaction,
        autoRetry: () => this.preferences.auto_retry,
        client: this.client,
        registry: this.registry,
        checker: this.checker,
        conversation: this.conv,
        cwd: this.cwd,
        sessionId: this.sessionId,
        ...(this.options.persist === false ? { transcriptPath: "" } : {}),
        goalManager: this.goalManager,
        hookEngine: this.hookEngine ?? undefined,
        fileHistory:
          this.options.persist === false ||
          this.options.trackFileChanges === false
            ? undefined
            : this.fileHistory,
        fileStateCache: this.fileStateCache,
        abortSignal: this.abortController.signal,
        contextWindow: this.contextWindow,
        maxOutput: getMaxOutputTokens(this.provider),
        recoveryState: this.recoveryState,
        taskManager: this.backgroundTaskManager,
        activeSkills: this.activeSkills,
        toolFilter: (name) =>
          coordinatorFilter(name) && (this.toolFilter?.(name) ?? true),
        coordinatorActiveFn: () =>
          coordinatorActive(this.enableCoordinatorMode),
        instructions: () => loadInstructions(this.cwd),
        memoryContent: () =>
          this.memoryEnabled ? this.memoryManager.buildSystemReminder() : "",
        skillSection: this.skillCatalog
          ? buildSkillSection(this.skillCatalog)
          : "",
        skillDeltaFn: () => {
          const section = this.skillCatalog
            ? buildSkillSection(this.skillCatalog)
            : "";
          return section && !this.conv.hasReminderContaining(section)
            ? section
            : "";
        },
        notificationFn: () => [
          ...this.teamManager.drainLeaderMailbox(),
          ...this.backgroundTaskManager
            .drainNotifications()
            .map(formatAgentTaskNotification),
        ],
        onPermissionRequest: callbacks.onPermissionRequest,
        onLoopComplete: (conv) => {
          if (!this.memoryEnabled || this.disposal) {
            return;
          }
          this.memoryTasks ??= new BackgroundMemoryTasks(
            this.client,
            this.cwd,
            {
              appendSystem: (message) => {
                this.conv.addSystemReminder(message);
              },
            },
          );
          this.memoryTasks.run(conv);
        },
      });
      this.currentAgent = agent;
      if (callbacks.recoveryOnly) {
        for (const event of await agent.recoverCodeMode()) {
          controller.signal.throwIfAborted();
          await cache.handleAgentEvent(event);
          yield event;
        }
      } else {
        let completed = false;
        let failed = false;
        for await (const event of agent.run()) {
          await cache.handleAgentEvent(event);
          if (event.type === "error") {
            failed = true;
          }
          if (event.type === "loop_complete") {
            completed =
              event.stopReason !== "interrupted" &&
              event.stopReason !== "retry_aborted" &&
              event.stopReason !== "budget_limited";
          }
          yield event;
        }
        successful = completed && !failed && !controller.signal.aborted;
      }
    } finally {
      this.steeringLeftovers.push(
        ...(this.currentAgent?.drainSteering() ?? []),
      );
      try {
        await cache.endRun(successful && !controller.signal.aborted);
      } finally {
        try {
          for (const lease of leases.reverse()) {
            lease.release();
          }
        } finally {
          this.abortController = null;
          this.currentAgent = null;
          close();
        }
      }
    }
  }

  abortForeground(): void {
    this.abortController?.abort();
    void this.cache.invalidate("interrupted");
  }
  abort(): void {
    this.abortForeground();
    void Promise.resolve()
      .then(() => this.backgroundTaskManager.stopAll())
      .catch((error: unknown) => {
        log.error({ err: error }, "background task cancellation failed");
      });
    void Promise.resolve()
      .then(() => this.teamManager.stopAll())
      .catch((error: unknown) => {
        log.error({ err: error }, "team cancellation failed");
      });
  }
  steer(
    text: string,
    input?: historyMod.InputEntry,
    content?: string | Record<string, unknown>[],
  ): boolean {
    if (!this.abortController || !this.currentAgent) {
      return false;
    }
    this.currentAgent.steer(text, input ?? this.createInput(text), content);
    return true;
  }
  removeSteering(inputId: string): boolean {
    return this.currentAgent?.removeSteering(inputId) ?? false;
  }
  takeSteeringLeftovers(): SteeringMessage[] {
    return this.steeringLeftovers.splice(0);
  }
  async stopMemoryTasks(): Promise<void> {
    const tasks = this.memoryTasks;
    this.memoryTasks = null;
    this.memoryCleanup = Promise.all([
      this.memoryCleanup,
      tasks?.dispose(),
    ]).then(() => undefined);
    await this.memoryCleanup;
  }
  dispose(): Promise<void> {
    this.disposal ??= Promise.resolve().then(async () => {
      this.abortForeground();
      await this.providerUpdateTail;
      await this.conversationReset?.catch(() => undefined);
      await this.cache.dispose();
      await this.runClosed;
      const stops = await Promise.allSettled([
        Promise.resolve().then(() => this.stopMemoryTasks()),
        Promise.resolve().then(() => this.backgroundTaskManager.stopAll()),
        Promise.resolve().then(() => this.teamManager.dispose()),
      ]);
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() =>
          this.options.mcpManager
            ? this.mcpSource
              ? this.mcpManager?.unregisterOwner(this.mcpSource)
              : undefined
            : this.mcpManager?.disconnectAll(),
        ),
        Promise.resolve().then(() => this.registry.dispose()),
        ...(stops.every((result) => result.status === "fulfilled")
          ? [
              this.cleanupSubagentSessions(),
              ...(this.options.persist === false &&
              this.options.cleanupArtifacts !== false
                ? [
                    rm(sessionPath(this.sessionId), {
                      recursive: true,
                      force: true,
                    }),
                  ]
                : []),
            ]
          : []),
      ]);
      const errors = [...stops, ...cleanup]
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result): unknown => result.reason);
      if (errors.length) {
        throw new AggregateError(
          errors,
          "Runtime cleanup failed; interrupted artifacts were preserved",
        );
      }
    });
    return this.disposal;
  }
  clearConversation(): Promise<void> {
    if (this.disposal) {
      return Promise.reject(new Error(RUNTIME_DISPOSED_ERROR));
    }
    this.conversationReset ??= Promise.resolve()
      .then(() => this.resetConversation())
      .finally(() => {
        this.conversationReset = undefined;
      });
    return this.conversationReset;
  }
  private async resetConversation(): Promise<void> {
    if (this.disposal) {
      throw new Error(RUNTIME_DISPOSED_ERROR);
    }
    this.abort();
    await this.providerUpdateTail;
    await this.cache.dispose();
    await this.runClosed;
    const previousLedger = this.executionContext?.ledger;
    await Promise.all([
      this.stopMemoryTasks(),
      this.backgroundTaskManager.stopAll(),
      this.teamManager.stopAll(),
    ]);
    await this.cleanupSubagentSessions();
    if (this.disposal) {
      throw new Error(RUNTIME_DISPOSED_ERROR);
    }
    const sessionId = newSessionId();
    const ledger = createCostLedger({
      sessionId,
      cwd: this.cwd,
      persist: this.options.persist !== false,
    });
    if (previousLedger) {
      ledger.replay(previousLedger.getEntries(), previousLedger.getRuns());
    }
    this.executionContext = {
      sessionId,
      runId: randomUUID(),
      agentId: "main",
      purpose: "main",
      ledger,
    };
    this.standaloneExecutionContext = this.executionContext;
    if (this.options.persist !== false) {
      this.backgroundTaskManager.useSession(sessionId);
    }
    this.conv.reset();
    this.activeSkills.clear();
    this.sessionId = sessionId;
    this.planFilePath = "";
    this.fileHistory = new FileHistory(
      sessionId,
      this.options.persist !== false,
    );
    this.fileStateCache = new FileStateCache();
    this.taskList.useStore(
      this.options.persist === false ? undefined : new TaskStore(sessionId),
    );
    this.recoveryState = new RecoveryState();
    this.mcpAnnounced.clear();
    this.ensureSessionStorage();
    this.cache = this.createCache(this.provider, this.providerClient);
    this.client = this.cache.client;
  }
}
