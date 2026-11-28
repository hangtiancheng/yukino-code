// Native workspace and IPC host for a single Yukino SDK session.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  controlAgent,
  projectQueue,
  snapshotAgent,
} from "@main/agent-controls";
import { applyRuntimeAction } from "@main/agent-runtime";
import { redactLogText, withIpcLogging } from "@main/logger";
import { ProjectError, resolveProject } from "@main/project";
import { Workspace } from "@main/workspace";
import type { AgentControl } from "@shared/agent-types";
import type {
  AskRequestPayload,
  BridgeEvent,
  CommandSummary,
  HistoryMessage,
  InitState,
  ModelListResult,
  MessageDelivery,
  McpAppOperation,
  PermissionRequestPayload,
  PermissionResponse,
  ProviderInput,
  ResumeResult,
  SessionSummary,
  SettingsSnapshot,
  UsagePayload,
} from "@shared/ipc-types";
import type {
  RuntimeAction,
  RuntimeSnapshot,
  SubagentSnapshot,
} from "@shared/workspace-types";
import {
  type AgentSession,
  ConfigError,
  createAgentSession,
  RuntimePreferencesSchema,
  recordInput,
  PreferencesPatchSchema,
  persistPreferences,
  loadPlan,
  loadSession,
  buildPlanExecutionPrompt,
  BashTool,
  DEFAULT_THINKING_LEVEL,
  McpAppRequestSchema,
  MAX_CLIPBOARD_IMAGE_BYTES,
  RemoteMcpApps,
  THINKING_LEVELS,
  configureBashSandbox,
  discoverModels,
  expandAtRefsWithImages,
  getSupportedThinkingLevels,
  getWorkflowService,
  globalConfigPath,
  listAllSessions,
  listSessions,
  loadConfig,
  memoryEnabled,
  parseUserBashCommand,
  persistDefaultProvider,
  persistModel,
  persistThinkingLevel,
  projectKey,
  rebuildFromSession,
  requestProjectTrust,
  resolve,
  resolveDefaultProvider,
  runFork,
  runInline,
  runSubagentCommand,
  saveProvider,
  spawnSubagent,
  storeClipboardImage,
} from "@yukino.js/yukino";
import type {
  AgentEvent,
  AgentRuntime,
  AppConfig,
  Command,
  CommandContext,
  Decision,
  Message,
  PreferencesPatch,
  ProviderConfig,
  Question,
  RuntimeSubagentEvent,
  SkillForkHost,
  ThinkingLevel,
} from "@yukino.js/yukino";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  clipboard,
  nativeTheme,
  nativeImage,
  app,
  shell,
} from "electron";
import type { Logger } from "pino";

type AskUserQuestion = Question;

const DEFAULT_THINKING = DEFAULT_THINKING_LEVEL;

export const EVENT_CHANNEL = "yukino:event";
export const THEME_CHANNEL = "yukino:theme";

function emit(event: BridgeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(EVENT_CHANNEL, event);
    }
  }
}

/** Project the persisted message content to plain text for the renderer. */
function contentToText(content: string | Record<string, unknown>[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function projectHistory(messages: Message[]): HistoryMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: contentToText(message.content),
    timestamp: 0,
    ...(message.userBash ? { userBash: message.userBash } : {}),
    ...(message.toolUses?.length
      ? {
          toolUses: message.toolUses.map((use) => ({
            toolUseId: use.toolUseId,
            toolName: use.toolName,
            arguments: use.arguments,
          })),
        }
      : {}),
    ...(message.toolResults?.length
      ? {
          toolResults: message.toolResults.map((result) => ({
            toolUseId: result.toolUseId,
            content: result.content,
            contentBlocks: result.contentBlocks,
            isError: result.isError,
          })),
        }
      : {}),
    ...(message.thinkingBlocks?.length
      ? {
          thinking: message.thinkingBlocks
            .map((block) => (block.type === "thinking" ? block.thinking : ""))
            .filter(Boolean)
            .join("\n"),
        }
      : {}),
  }));
}

/** Persisted workspace location. */
interface PersistedState {
  cwd?: string;
}

class StateStore {
  constructor(private readonly log: Logger) {}

  private get path(): string {
    return join(app.getPath("userData"), "state.json");
  }

  read(): PersistedState {
    try {
      if (!existsSync(this.path)) {
        return {};
      }
      return JSON.parse(readFileSync(this.path, "utf-8")) as PersistedState;
    } catch (err) {
      this.log.warn({ err }, "Could not read application state");
      return {};
    }
  }

  write(patch: PersistedState): void {
    try {
      const dir = app.getPath("userData");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        this.path,
        JSON.stringify({ ...this.read(), ...patch }, null, 2),
      );
    } catch (err) {
      this.log.warn({ err }, "Could not save application state");
    }
  }
}

export class YukinoBridge {
  private session: AgentSession | null = null;
  private lifetimeController = new AbortController();
  private get handle(): AgentRuntime | null {
    return this.session && !this.session.isDisposed
      ? this.session.runtime
      : null;
  }
  private workspace: Workspace | null = null;
  private mcpApps = new RemoteMcpApps();
  private initPromise: Promise<InitState> | null = null;
  private streaming = false;
  private wakeupTimer: ReturnType<typeof setInterval> | null = null;
  private workflowObserver: {
    service: NonNullable<ReturnType<typeof getWorkflowService>>;
    ready: Promise<void>;
    off: () => void;
  } | null = null;
  private disposing = false;
  private interrupted = false;
  private pendingPlan: { id: string; content: string; path: string } | null =
    null;
  private cwd: string;
  private readonly state: StateStore;
  private readonly log: Logger;
  /** All configured providers; drives settings. */
  private providers: ProviderConfig[] = [];
  /** Last usage snapshot, for /status. */
  private lastUsage = { inputTokens: 0, outputTokens: 0 };
  /** Abort controller for command runs (subagents, compaction) outside handle.run. */
  private commandController: AbortController | null = null;
  private modelListController: AbortController | null = null;

  private readonly pendingPermissions = new Map<
    string,
    (response: PermissionResponse) => void
  >();
  private readonly pendingAsks = new Map<
    string,
    (answers: Record<string, string>) => void
  >();
  /** Messages sent while a run is busy but steering was unavailable. */

  private readonly subagents = new Map<string, SubagentSnapshot>();

  constructor(logger: Logger) {
    this.log = logger.child({ component: "agent" });
    this.state = new StateStore(logger.child({ component: "state" }));
    this.cwd = this.state.read().cwd || homedir();
  }

  // ---------- theme ----------

  getTheme(): "system" | "light" | "dark" {
    return nativeTheme.themeSource;
  }

  setTheme(mode: "system" | "light" | "dark"): void {
    nativeTheme.themeSource = mode;
    this.broadcastTheme();
  }

  applyTheme(): void {
    try {
      const theme = loadConfig(undefined, { allowEmptyProviders: true }).theme;
      nativeTheme.themeSource = theme === "auto" ? "system" : theme;
    } catch (err) {
      this.log.warn({ err }, "Could not load appearance settings");
      nativeTheme.themeSource = "system";
    }
    nativeTheme.on("updated", () => {
      this.broadcastTheme();
    });
  }

  private broadcastTheme(): void {
    const theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.setBackgroundColor(theme === "dark" ? "#1e1e2e" : "#eff1f5");
        window.webContents.send(THEME_CHANNEL, theme);
      }
    }
  }

  // ---------- init ----------

  /** Loads config + initializes the agent stack for the current cwd. */
  async init(): Promise<InitState> {
    if (this.handle) {
      const state = this.buildInitState(this.handle);
      emit({ type: "init_state", data: state });
      this.emitHistory();
      emit({ type: "run_state", data: { streaming: this.streaming } });
      if (this.pendingPlan) {
        emit({ type: "plan_approval", data: this.pendingPlan });
      }
      return state;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.initialize();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<InitState> {
    this.log.info("Initializing agent");
    try {
      this.cwd = await resolveProject(this.cwd);
      this.startWorkspace();
      const configPath = globalConfigPath();
      let config: AppConfig;
      try {
        config = loadConfig(undefined, { allowEmptyProviders: true });
      } catch (error) {
        this.log.error({ err: error }, "Could not load provider configuration");
        return this.initError(
          "Could not read the provider configuration. Check the config file.",
          {
            kind: "config",
            configPath,
            details: error instanceof Error ? error.message : String(error),
          },
        );
      }
      if (config.providers.length === 0) {
        return this.initError("Add a provider to start using the agent.", {
          kind: "config",
          configPath,
        });
      }

      this.providers = config.providers;
      const handle = await this.createHandle(config);
      this.startNotificationWakeup();
      this.broadcastPreferences();
      this.state.write({ cwd: this.cwd });

      const okState = this.buildInitState(handle);
      this.log.info(
        {
          sessionId: handle.sessionId,
          model: handle.provider.model,
          protocol: handle.provider.protocol,
        },
        "Agent initialized",
      );
      emit({ type: "init_state", data: okState });
      return okState;
    } catch (error) {
      this.log.error({ err: error }, "Agent initialization failed");
      this.workspace?.dispose();
      this.workspace = null;
      return this.initError(
        error instanceof ProjectError || error instanceof ConfigError
          ? error.message
          : "Agent initialization failed. Check the configuration and try again.",
        {
          kind:
            error instanceof ProjectError
              ? "project"
              : error instanceof ConfigError
                ? "config"
                : "runtime",
          details:
            error instanceof ProjectError
              ? error.path
              : error instanceof Error
                ? error.message
                : String(error),
        },
      );
    }
  }

  private startWorkspace(): void {
    if (this.workspace) {
      return;
    }
    this.workspace = new Workspace(
      this.cwd,
      (path) => {
        emit({ type: "workspace_changed", data: { cwd: this.cwd, path } });
      },
      (path) => {
        this.handle?.fileHistory.trackEdit(path);
        this.handle?.fileStateCache.delete(path);
      },
      (error) => {
        this.log.warn({ err: error }, "Workspace watcher failed");
      },
    );
    this.workspace.start();
  }

  private buildInitState(handle: AgentRuntime): InitState & { ok: true } {
    return {
      ok: true,
      cwd: handle.cwd,
      projectKey: projectKey(handle.cwd),
      providerName: handle.provider.name,
      model: handle.provider.model,
      sessionId: handle.sessionId,
      permissionMode: handle.permissionMode,
      contextWindow: handle.contextWindow,
      thinkingLevel: this.currentThinkingLevel(handle),
    };
  }

  private currentThinkingLevel(handle: AgentRuntime): ThinkingLevel {
    return (
      handle.client.getThinkingLevel?.() ??
      handle.provider.thinking ??
      DEFAULT_THINKING
    );
  }

  private supportedThinkingLevels(handle: AgentRuntime): ThinkingLevel[] {
    return [
      ...(handle.client.getSupportedThinkingLevels?.() ??
        getSupportedThinkingLevels(handle.provider)),
    ];
  }

  private initError(
    message: string,
    context: {
      kind?: "project" | "config" | "runtime";
      details?: string;
      configPath?: string;
    } = {},
  ): InitState {
    this.log.warn({ kind: context.kind }, message);
    const failure: InitState = { ok: false, error: message, ...context };
    emit({ type: "init_state", data: failure });
    return failure;
  }

  private async createHandle(config: AppConfig): Promise<AgentRuntime> {
    const askUser = this.createAsker();
    this.lifetimeController = new AbortController();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      signal: this.lifetimeController.signal,
      configPath: globalConfigPath(),
      config: { enable_memory: memoryEnabled(config) },
      permissions: config.permission_mode ?? "default",
      trackFileChanges: true,
      onBeforeFileEdit: (path) => this.workspace?.captureBeforeEdit(path),
      askUser,
      onPermissionRequest: this.createPermissionCallback(),
      onTrustRequest: (request) => requestProjectTrust(askUser, request),
      planApproval: (request) => this.requestPlan(request.plan, request.signal),
    });
    this.session = session;
    session.subscribe((event) => {
      if (event.type === "tool_output") {
        emit({ type: "tool_output", data: event.payload });
      } else if (event.type === "subagent") {
        this.reportSubagent(event.payload);
      } else if (event.type === "queue_changed") {
        // The SDK publishes before returning the receipt to the sender.
        queueMicrotask(() => {
          if (
            session === this.session &&
            event.sessionId === session.sessionId
          ) {
            this.syncQueue(session);
          }
        });
      } else if (event.type === "session_changed") {
        if (this.cwd !== session.cwd) {
          this.workspace?.dispose();
          this.workspace = null;
          this.cwd = session.cwd;
          this.state.write({ cwd: this.cwd });
          this.startWorkspace();
        }
        this.resetSessionUi();
        emit({
          type: "session_changed",
          data: { sessionId: session.sessionId, cwd: session.cwd },
        });
        this.broadcastUpdatedState(session.runtime);
        this.broadcastPreferences();
        this.emitHistory();
      } else if (event.type === "task_changed") {
        emit({ type: "runtime_changed" });
      } else if (event.type === "run_started") {
        this.setStreaming(true);
      } else if (event.type === "run_settled") {
        void session
          .waitForIdle()
          .then(() => {
            if (this.session === session && !session.isDisposed) {
              this.setStreaming(false);
              this.broadcastUpdatedState(session.runtime);
            }
          })
          .catch((error: unknown) => {
            this.log.error({ err: error }, "Run settlement failed");
          });
      } else if (event.source === "agent" || event.type === "compact") {
        this.emitAgentEvent({
          type: event.type,
          ...event.payload,
        } as AgentEvent);
      }
    });
    try {
      await this.observeWorkflows(session.runtime);
    } catch (error) {
      this.session = null;
      await session.dispose();
      throw error;
    }
    return session.runtime;
  }

  private emitHistory(): ResumeResult {
    const session = this.session!;
    const result = {
      sessionId: session.sessionId,
      cwd: session.cwd,
      messages: projectHistory(
        rebuildFromSession(loadSession(session.cwd, session.sessionId), {
          includeExcludedUserBash: true,
        }),
      ),
    };
    emit({ type: "history", data: result });
    return result;
  }

  private planResponse:
    ((choice: "approve" | { feedback: string } | "deny") => void) | null = null;

  private requestPlan(
    content: string,
    signal?: AbortSignal,
  ): Promise<"approve" | { feedback: string } | "deny"> {
    return new Promise((resolve) => {
      const finish = (
        choice: "approve" | { feedback: string } | "deny",
      ): void => {
        signal?.removeEventListener("abort", cancel);
        this.pendingPlan = null;
        this.planResponse = null;
        emit({ type: "plan_approval", data: null });
        resolve(choice);
      };
      const cancel = (): void => {
        finish("deny");
      };
      this.planResponse = finish;
      this.pendingPlan = {
        id: randomUUID(),
        content,
        path: this.handle?.planFilePath ?? "",
      };
      emit({ type: "plan_approval", data: this.pendingPlan });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
      }
    });
  }

  private reportSubagent(event: RuntimeSubagentEvent): void {
    const previous = this.subagents.get(event.toolCallId);
    const snapshot: SubagentSnapshot = previous ?? {
      id: event.toolCallId,
      role: event.role,
      background: event.background,
      status: "running",
      tools: 0,
      turns: 0,
      activity: "",
    };
    if (event.type === "finished") {
      snapshot.status = event.status;
      snapshot.activity = "";
    } else if (event.type === "tool_use") {
      snapshot.tools++;
      snapshot.activity = event.toolName;
    } else if (event.type === "turn_complete") {
      snapshot.turns++;
    }
    this.subagents.set(event.toolCallId, snapshot);
    emit({ type: "subagent", data: event });
  }

  private async ensureHandle(): Promise<AgentRuntime | null> {
    if (this.handle) {
      return this.handle;
    }
    const state = await this.init();
    if (!state.ok) {
      throw new Error(state.error);
    }
    return this.handle;
  }

  // ---------- ask & permission bridges ----------

  /** AskUserQuestion tool callback → renderer dialog → answers. */
  private createAsker(): (
    questions: AskUserQuestion[],
    signal?: AbortSignal,
  ) => Promise<Record<string, string>> {
    return (questions, signal) => {
      const id = `ask-${randomUUID()}`;
      const payload: AskRequestPayload = {
        id,
        questions: questions.map((question) => ({
          question: question.question,
          multiSelect: question.multiSelect,
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        })),
      };
      emit({ type: "ask_request", data: payload });
      return new Promise<Record<string, string>>((resolve) => {
        const cancel = (): void => {
          if (this.pendingAsks.delete(id)) {
            emit({ type: "ask_resolved", data: { id } });
            resolve({});
          }
        };
        this.pendingAsks.set(id, (answers) => {
          signal?.removeEventListener("abort", cancel);
          emit({ type: "ask_resolved", data: { id } });
          resolve(answers);
        });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
        }
      });
    };
  }

  /** PermissionRequestHandler → renderer card → decision. */
  private createPermissionCallback(): (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision,
    toolCallId: string,
    signal?: AbortSignal,
    source?: { agentName: string; cwd: string },
  ) => Promise<PermissionResponse> {
    return (toolName, args, decision, toolCallId, signal, source) => {
      const id = `perm-${randomUUID()}`;
      const payload: PermissionRequestPayload = {
        id,
        toolCallId,
        toolName,
        args,
        reason: decision.reason,
        ...(decision.rememberPatterns
          ? { rememberPatterns: decision.rememberPatterns }
          : {}),
        ...(source ? { source } : {}),
      };
      emit({ type: "permission_request", data: payload });
      return new Promise<PermissionResponse>((resolve) => {
        const cancel = (): void => {
          if (this.pendingPermissions.delete(id)) {
            emit({
              type: "permission_resolved",
              data: { id, response: "deny" },
            });
            resolve("deny");
          }
        };
        this.pendingPermissions.set(id, (response) => {
          signal?.removeEventListener("abort", cancel);
          emit({ type: "permission_resolved", data: { id, response } });
          resolve(response);
        });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
        }
      });
    };
  }

  respondPermission(id: string, response: PermissionResponse): void {
    const resolve = this.pendingPermissions.get(id);
    this.pendingPermissions.delete(id);
    resolve?.(response);
  }

  respondAsk(id: string, answers: Record<string, string>): void {
    const resolve = this.pendingAsks.get(id);
    this.pendingAsks.delete(id);
    resolve?.(answers);
  }

  // ---------- run loop ----------

  private setStreaming(value: boolean): void {
    if (this.streaming === value) {
      return;
    }
    if (value) {
      this.interrupted = false;
    }
    this.streaming = value;
    emit({ type: "run_state", data: { streaming: value } });
  }

  /** Sends a user message, or steers/queues it when a run is active. */
  async send(text: string, delivery: MessageDelivery = "steer"): Promise<void> {
    if (delivery !== "steer" && delivery !== "followUp") {
      throw new Error("Invalid input delivery");
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const handle = await this.ensureHandle();
    if (!handle) {
      throw new Error("The agent is not initialized");
    }
    const bash = parseUserBashCommand(trimmed);
    const parsed = resolve(trimmed, handle.cmdRegistry);
    const announce = (): void => {
      emit({ type: "user_input", data: { id: randomUUID(), text: trimmed } });
    };
    if (bash || parsed) {
      this.assertIdle();
      announce();
      if (bash) {
        await this.runUserBash(handle, bash.command, bash.excludeFromContext);
      } else if (parsed?.name === "goal") {
        await this.runLoop(handle, trimmed);
      } else if (parsed) {
        await this.runCommandInternal(handle, parsed.name, parsed.args);
      }
      return;
    }

    const session = this.session!;
    const sessionId = session.sessionId;
    const expanded = await this.preparePrompt(trimmed, session.cwd);
    if (session !== this.session || sessionId !== session.sessionId) {
      throw new Error(
        "The active session changed before the message could be sent",
      );
    }
    if (!this.streaming && !session.isBusy) {
      announce();
      await this.runPrompt(session, expanded);
      return;
    }
    const controller = new AbortController();
    const receipt =
      delivery === "steer"
        ? session.steer(expanded, { signal: controller.signal })
        : session.followUp(expanded, { signal: controller.signal });
    this.queuedMessages.set(receipt.id, {
      controller,
      text: trimmed,
      sessionId,
    });
    void receipt.completion.then(() => this.queuedMessages.delete(receipt.id));
  }

  private readonly queuedMessages = new Map<
    string,
    { controller: AbortController; text: string; sessionId: string }
  >();
  private readonly originalQueueText = (id: string): string | undefined =>
    this.queuedMessages.get(id)?.text;

  private syncQueue(session: AgentSession): void {
    const entries = session.getQueue();
    const remaining = new Set(entries.map((entry) => entry.id));
    for (const [id, { text, sessionId }] of this.queuedMessages) {
      if (sessionId === session.sessionId && !remaining.has(id)) {
        this.queuedMessages.delete(id);
        emit({ type: "user_input", data: { id, text } });
      }
    }
    emit({
      type: "queue_changed",
      data: projectQueue(entries, this.originalQueueText),
    });
  }

  private cancelQueuedMessage(id: string): string {
    const message = this.queuedMessages.get(id);
    if (
      !message ||
      !this.session?.getQueue().some((entry) => entry.id === id)
    ) {
      throw new Error("This message has already left the queue");
    }
    this.queuedMessages.delete(id);
    message.controller.abort();
    return message.text;
  }

  private async preparePrompt(text: string, cwd: string) {
    const expanded = await expandAtRefsWithImages(text, cwd);
    return typeof expanded === "string"
      ? expanded
      : {
          text: expanded
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
          attachments: expanded.filter((block) => block.type !== "text"),
        };
  }

  private async runLoop(
    handle: AgentRuntime,
    text: string | null,
  ): Promise<void> {
    if (text === null) {
      await this.session!.continueRun();
      return;
    }
    const session = this.session!;
    const sessionId = session.sessionId;
    const expanded = await this.preparePrompt(text, handle.cwd);
    if (session !== this.session || sessionId !== session.sessionId) {
      throw new Error(
        "The active session changed before the command could run",
      );
    }
    await this.runPrompt(session, expanded);
  }

  private async runPrompt(
    session: AgentSession,
    input: Parameters<AgentSession["prompt"]>[0],
  ): Promise<void> {
    this.setStreaming(true);
    try {
      const result = await session.prompt(input);
      if (result.status === "failed") {
        this.log.warn({ stopReason: result.stopReason }, "Agent run failed");
      }
    } finally {
      if (session === this.session) {
        this.setStreaming(session.isBusy);
      }
    }
  }

  private startNotificationWakeup(): void {
    if (this.disposing) {
      return;
    }
    if (this.wakeupTimer) {
      clearInterval(this.wakeupTimer);
    }
    this.wakeupTimer = setInterval(() => {
      const handle = this.handle;
      if (
        !handle ||
        this.streaming ||
        this.disposing ||
        this.pendingPlan ||
        this.interrupted
      ) {
        return;
      }
      if (
        handle.backgroundTaskManager.hasNotifications() ||
        handle.teamManager.hasLeaderNotifications()
      ) {
        void this.runLoop(handle, null).catch((error: unknown) => {
          this.log.warn({ err: error }, "Background wake-up failed");
        });
      }
    }, 500);
    this.wakeupTimer.unref();
  }

  private async runUserBash(
    handle: AgentRuntime,
    command: string,
    excludeFromContext: boolean,
  ): Promise<void> {
    if (!command) {
      throw new Error("Enter a command after !");
    }
    this.setStreaming(true);
    try {
      await this.session!.userBash(command, { excludeFromContext });
    } finally {
      this.completeRun(handle);
    }
  }

  private completeRun(_handle: AgentRuntime): void {
    this.setStreaming(false);
    if (this.handle) {
      this.broadcastUpdatedState(this.handle);
    }
  }

  abort(): void {
    this.interrupted = true;
    if (this.initPromise && !this.session) {
      this.lifetimeController.abort();
    }
    for (const id of this.pendingAsks.keys()) {
      this.respondAsk(id, {});
    }
    for (const id of this.pendingPermissions.keys()) {
      this.respondPermission(id, "deny");
    }
    this.planResponse?.("deny");
    this.commandController?.abort();
    void this.session?.abort("all").catch((error: unknown) => {
      this.log.error({ err: error }, "Could not stop agent");
    });
  }

  private emitAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "stream_text":
        emit({ type: "stream_text", data: { text: event.text } });
        break;
      case "thinking_text":
        emit({ type: "thinking_text", data: { text: event.text } });
        break;
      case "tool_use":
        emit({
          type: "tool_use",
          data: {
            toolId: event.toolId,
            toolName: event.toolName,
            args: event.args,
          },
        });
        break;
      case "tool_result":
        if (event.mcpApp && this.handle) {
          this.mcpApps.register(
            {
              toolId: event.toolId,
              toolName: event.toolName,
              output: event.output,
              isError: event.isError,
              elapsed: event.elapsed,
              mcpApp: event.mcpApp,
            },
            this.handle,
          );
        }
        emit({
          type: "tool_result",
          data: {
            toolId: event.toolId,
            toolName: event.toolName,
            output: event.output,
            mcpApp: event.mcpApp,
            contentBlocks: event.contentBlocks,
            isError: event.isError,
            elapsed: event.elapsed,
          },
        });
        break;
      case "turn_complete":
        emit({ type: "turn_complete" });
        break;
      case "loop_complete":
        emit({ type: "loop_complete", data: { stopReason: event.stopReason } });
        break;
      case "usage":
        this.lastUsage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        };
        emit({
          type: "usage",
          data: {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadInputTokens: event.usage.cacheReadInputTokens,
            cacheCreationInputTokens: event.usage.cacheCreationInputTokens,
          } satisfies UsagePayload,
        });
        break;
      case "error":
        this.log.error(
          { err: event.error, sessionId: this.handle?.sessionId },
          "Agent reported an error",
        );
        emit({ type: "error", data: { message: event.error.message } });
        break;
      case "compact":
        emit({ type: "compact", data: { message: event.message } });
        break;
      case "retry":
        this.log.warn(
          {
            reason: redactLogText(event.reason),
            delay: event.delay,
            sessionId: this.handle?.sessionId,
          },
          "Agent retrying",
        );
        emit({
          type: "retry",
          data: { reason: event.reason, delay: event.delay },
        });
        break;
      case "thinking_complete":
      case "steering_delivered":
      case "permission_request":
        // No renderer representation needed.
        break;
    }
  }

  // ---------- sessions & folder ----------

  async newSession(): Promise<{ sessionId: string }> {
    const handle = await this.ensureHandle();
    if (!handle) {
      return { sessionId: "" };
    }
    this.assertIdle();
    this.resetSessionUi();
    await this.session!.newSession();
    this.lastUsage = { inputTokens: 0, outputTokens: 0 };
    return { sessionId: this.session!.sessionId };
  }

  /** Sessions across every known project, ordered by last user message. */
  listSessions(): SessionSummary[] {
    try {
      return listAllSessions().map((session) => ({
        id: session.id,
        firstMessage: session.metadata.name || session.firstMessage,
        archived: session.metadata.archived ?? false,
        tags: session.metadata.tags ?? [],
        messageCount: session.messageCount,
        modTime: session.modTime.getTime(),
        cwd: session.cwd,
        projectKey: session.projectKey,
        lastUserMessageTime: session.lastUserMessageTime?.getTime() ?? null,
      }));
    } catch {
      return [];
    }
  }

  async resumeSession(sessionId: string, cwd?: string): Promise<ResumeResult> {
    this.assertIdle();
    const target = await resolveProject(cwd ?? this.cwd);
    const switchedCwd = projectKey(target) !== projectKey(this.cwd);
    await this.ensureHandle();
    if (!this.session) {
      throw new Error("The agent is not initialized");
    }
    await this.session.resume(sessionId, { cwd: target, destination: target });
    return { ...this.emitHistory(), switchedCwd };
  }

  async selectFolder(): Promise<{ cwd: string | null }> {
    this.assertIdle();
    const result = await dialog.showOpenDialog({
      title: "Select Project Folder",
      defaultPath: this.cwd,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { cwd: null };
    }
    const cwd = result.filePaths[0];
    await this.reinit(cwd);
    return { cwd };
  }

  private async reinit(cwd: string): Promise<void> {
    cwd = await resolveProject(cwd);
    if (this.initPromise) {
      await this.initPromise;
    }
    if (this.wakeupTimer) {
      clearInterval(this.wakeupTimer);
    }
    this.wakeupTimer = null;
    if (this.streaming) {
      this.abort();
    }
    const session = this.session;
    this.session = null;
    await session?.dispose();
    this.resetSessionUi();
    this.workspace?.dispose();
    this.workspace = null;
    this.cwd = cwd;
    this.lastUsage = { inputTokens: 0, outputTokens: 0 };
    await this.init();
  }

  // ---------- slash commands ----------

  /** Slash commands surfaced in the composer panel. */
  async listCommands(): Promise<CommandSummary[]> {
    const handle = await this.ensureHandle();
    if (!handle) {
      return [];
    }
    const commands: CommandSummary[] = handle.cmdRegistry
      .listCommands()
      .filter((command) => !command.isSkill)
      .map((command) => ({
        isSkill: false,
        name: command.name,
        description: command.description,
        type: command.type,
      }));
    for (const skill of handle.skillCatalog?.list() ?? []) {
      if (!commands.some((command) => command.name === skill.name)) {
        commands.push({
          isSkill: true,
          name: skill.name,
          description: skill.description,
          type:
            handle.skillCatalog?.get(skill.name)?.meta.mode === "fork"
              ? "skill_fork"
              : "prompt",
        });
      }
    }
    for (const [name, description] of Object.entries({
      reload: "Reload settings and project resources",
      settings: "Agent and appearance preferences",
      retry: "Automatic retry controls",
      warming: "Cache warming controls",
      provider: "Switch the active provider",
    })) {
      if (!commands.some((command) => command.name === name)) {
        commands.push({ name, description, type: "local_ui", isSkill: false });
      }
    }
    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Executes a slash command; results stream back as BridgeEvents. */
  async runCommand(input: string): Promise<void> {
    this.assertIdle();
    const handle = await this.ensureHandle();
    if (!handle) {
      return;
    }
    const parsed = resolve(input, handle.cmdRegistry);
    if (!parsed) {
      return;
    }
    if (parsed.name === "goal") {
      await this.runLoop(handle, input);
      return;
    }
    await this.runCommandInternal(handle, parsed.name, parsed.args);
  }

  private async runCommandInternal(
    handle: AgentRuntime,
    name: string,
    args: string,
  ): Promise<void> {
    if (
      [
        "reload",
        "settings",
        "retry",
        "warming",
        "session",
        "provider",
      ].includes(name)
    ) {
      await this.runLocalUiCommand(handle, name, args);
      return;
    }
    const cmd = handle.cmdRegistry.find(name);
    const skill = handle.skillCatalog?.get(name);
    if (skill && (!cmd || cmd.isSkill)) {
      if (skill.meta.mode === "fork") {
        await this.runSkillFork(handle, name, args);
      } else {
        const prompt = runInline(skill, args, {
          activateSkill: (skillName, body) => {
            handle.activeSkills.set(skillName, body);
          },
        });
        await this.runLoop(handle, prompt);
      }
      return;
    }
    if (!cmd) {
      emit({
        type: "error",
        data: {
          message: `Unknown command: /${name} — type /help to see available commands`,
        },
      });
      return;
    }

    switch (cmd.type) {
      case "local":
        await this.runLocalCommand(handle, cmd, args);
        return;
      case "local_ui":
        await this.runLocalUiCommand(handle, name, args);
        return;
      case "prompt":
        await this.runPromptCommand(handle, cmd, args);
        return;
      case "skill_fork":
        await this.runSkillFork(handle, name, args);
        return;
    }
  }

  /** Mirrors the WS server's CommandContext so local handlers behave identically. */
  private buildCommandContext(
    handle: AgentRuntime,
    args: string,
  ): CommandContext {
    return {
      cwd: handle.cwd,
      args,
      permissionMode: () => handle.permissionMode,
      tokenCount: () =>
        [this.lastUsage.inputTokens, this.lastUsage.outputTokens] as const,
      toolCount: () => handle.registry.listTools().length,
      memoryList: () =>
        handle.memoryEnabled
          ? handle.memoryManager.getMemories().map((m) => m.name)
          : [],
      model: handle.provider.model,
      thinkingLevel: () => this.currentThinkingLevel(handle),
      availableThinkingLevels: () => this.supportedThinkingLevels(handle),
      setThinkingLevel: handle.client.setThinkingLevel
        ? (level) => {
            handle.client.setThinkingLevel?.(level);
            handle.provider.thinking =
              handle.client.getThinkingLevel?.() ?? level;
          }
        : undefined,
      persistThinkingLevel: (level) => {
        persistThinkingLevel(handle.provider.base_url, level);
      },
    };
  }

  private async runLocalCommand(
    handle: AgentRuntime,
    cmd: Command,
    args: string,
  ): Promise<void> {
    // Placeholder-token handlers are intercepted by name (server parity).
    if (cmd.name === "memory") {
      emit({
        type: "system",
        data: { message: this.buildMemoryStatus(handle, args) },
      });
      return;
    }
    if (cmd.name === "status") {
      emit({
        type: "system",
        data: { message: this.buildSessionStatus(handle) },
      });
      return;
    }
    if (cmd.name === "mcp") {
      if (args.trim() === "reload") {
        await this.reloadResources();
      }
      emit({ type: "open_runtime", page: "mcp" });
      return;
    }
    if (cmd.name === "thinking" && !args.trim()) {
      emit({ type: "open_settings" });
      return;
    }
    const result = cmd.handler(this.buildCommandContext(handle, args));
    emit({ type: "system", data: { message: result, markdown: cmd.markdown } });
    if (cmd.name === "thinking") {
      this.broadcastUpdatedState(handle);
    }
  }

  private async runLocalUiCommand(
    handle: AgentRuntime,
    name: string,
    args: string,
  ): Promise<void> {
    switch (name) {
      case "quit":
        app.quit();
        return;
      case "clear": {
        await this.newSession();
        return;
      }

      case "compact":
        await this.runCompact(handle, args.trim());
        return;

      case "reload":
        await this.reloadResources();
        return;
      case "settings":
        emit({ type: "open_settings" });
        return;
      case "retry":
        if (args.trim() === "abort") {
          this.session!.abortRetry();
        } else if (["on", "off"].includes(args.trim())) {
          this.session!.setAutoRetry(args.trim() === "on");
        }
        emit({
          type: "system",
          data: {
            message: `Automatic retry: ${this.session!.getSettings().values.auto_retry ? "on" : "off"}`,
          },
        });
        return;
      case "session":
        emit({ type: "open_runtime", page: "session" });
        return;
      case "warming":
        emit({ type: "open_runtime", page: "controls" });
        return;
      case "login":
      case "provider":
        emit({ type: "open_settings" });
        return;

      case "model":
        if (args.trim()) {
          await this.setModelInternal(handle, args.trim());
          return;
        }
        emit({ type: "open_settings" });
        return;

      case "resume":
        await this.runResume(handle, args.trim());
        return;

      case "workflows": {
        const [action, id] = args.trim().split(/\s+/u);
        if (!action) {
          emit({ type: "open_runtime", page: "workflows" });
          return;
        }
        if (action === "resume" && id) {
          await this.executeControl({
            type: "workflow_run",
            input: { resumeFromRunId: id },
          });
          emit({ type: "open_runtime", page: "workflows" });
          return;
        }
        const service = getWorkflowService(handle.registry);
        const message = service
          ? await service.command(args, {
              cwd: handle.cwd,
              permissionChecker: handle.checker,
              onPermissionRequest: this.createPermissionCallback(),
            })
          : "Workflow service is not initialized";
        emit({ type: "system", data: { message } });
        return;
      }
      case "rewind":
        emit({ type: "open_runtime", page: "history" });
        return;
      case "sandbox": {
        this.assertIdle();
        const mode = args.trim();
        if (["auto", "manual", "off"].includes(mode)) {
          const bash = handle.registry.getInstanceOf("Bash", BashTool);
          if (bash?.sandbox) {
            await bash.sandbox.dispose?.();
            bash.sandbox = null;
          }
          await configureBashSandbox(
            handle.registry,
            handle.cwd,
            { enabled: mode !== "off", auto_allow: mode === "auto" },
            handle.checker,
          );
        }
        emit({
          type: "system",
          data: {
            message: `Sandbox: ${handle.checker.sandboxEnabled ? "on" : "off"}\n/sandbox auto | manual | off`,
          },
        });
        return;
      }
      case "worktree": {
        const { stdout } = await promisify(execFile)(
          "git",
          ["worktree", "list"],
          { cwd: handle.cwd },
        );
        emit({ type: "system", data: { message: stdout } });
        return;
      }
      case "skills": {
        if (args.trim() === "reload") {
          await this.reloadResources();
        }
        const skills = handle.skillCatalog?.list() ?? [];
        if (skills.length === 0) {
          emit({ type: "system", data: { message: "No skills found." } });
        } else {
          const lines = skills.map(
            (skill) => `  ${skill.name}: ${skill.description}`,
          );
          emit({
            type: "system",
            data: {
              message: `Available skills (${String(skills.length)}):\n\n${lines.join("\n")}`,
            },
          });
        }
        return;
      }

      default:
        throw new Error(`Unknown desktop command: /${name}`);
    }
  }

  private async runPromptCommand(
    handle: AgentRuntime,
    cmd: Command,
    args: string,
  ): Promise<void> {
    const prompt = cmd.handler(this.buildCommandContext(handle, args));
    const displayText = args ? `/${cmd.name} ${args}` : `/${cmd.name}`;

    if (cmd.agent) {
      const agent = cmd.agent;
      // Foreground subagent command (/plan, /review) — the agent runs on the
      // parent registry/conversation but reports through its own events.
      this.setStreaming(true);
      const controller = new AbortController();
      this.commandController = controller;
      try {
        const result = await this.session!.runHostOperation(
          async (_runtime, signal) =>
            runSubagentCommand(agent, prompt, displayText, {
              cwd: handle.cwd,
              sessionId: handle.sessionId,
              registry: handle.registry,
              conversation: handle.conv,
              permissionChecker: handle.checker,
              onPermissionRequest: this.createPermissionCallback(),
              abortSignal: AbortSignal.any([controller.signal, signal]),
              onEvent: (event) => {
                this.emitAgentEvent(event);
              },
            }),
        );
        if (
          cmd.agent === "plan" &&
          !result.isError &&
          !controller.signal.aborted
        ) {
          const choice = await this.requestPlan(
            loadPlan(handle) ?? "",
            controller.signal,
          );
          if (choice === "approve") {
            handle.checker.exitPlanMode("default");
            await this.runLoop(
              handle,
              buildPlanExecutionPrompt(loadPlan(handle) ?? ""),
            );
          } else if (typeof choice === "object") {
            await this.runLoop(handle, choice.feedback);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", data: { message } });
      } finally {
        this.commandController = null;
        this.completeRun(handle);
      }
      return;
    }

    await this.runLoop(handle, prompt);
  }

  private async runSkillFork(
    handle: AgentRuntime,
    name: string,
    args: string,
  ): Promise<void> {
    const skill = handle.skillCatalog?.get(name);
    if (!skill) {
      emit({ type: "system", data: { message: `Skill not found: ${name}` } });
      return;
    }
    this.setStreaming(true);
    const controller = new AbortController();
    this.commandController = controller;
    const activity = {
      toolCallId: `skill-${randomUUID()}`,
      role: name,
      background: false,
    };
    this.reportSubagent({ ...activity, type: "started" });
    emit({
      type: "system",
      data: { message: `Running skill "${name}" in fork mode…` },
    });
    try {
      const forkHost: SkillForkHost = {
        activateSkill: (skillName, body) => {
          handle.activeSkills.set(skillName, body);
        },
        snapshotParentMessages: (count) => {
          return handle.conv
            .getMessages()
            .slice(-count)
            .map(
              (message) =>
                `[${message.role}] ${contentToText(message.content)}`,
            )
            .join("\n");
        },
        runSubagent: (prompt, signal, context) =>
          spawnSubagent(
            {
              name: skill.meta.name,
              description: skill.meta.description,
              model: skill.meta.model,
            },
            prompt,
            handle.client,
            handle.registry,
            handle.provider,
            handle.cwd,
            undefined,
            (event) => {
              if (
                event.type === "tool_use" ||
                event.type === "tool_result" ||
                event.type === "turn_complete"
              ) {
                this.reportSubagent({ ...activity, ...event });
              }
            },
            undefined,
            context?.permissionChecker?.forCwd(handle.cwd) ??
              handle.checker.forCwd(handle.cwd),
            {
              abortSignal: signal ?? controller.signal,
              background: false,
              onPermissionRequest: this.createPermissionCallback(),
            },
          ),
      };
      const result = await this.session!.runHostOperation(
        async (_runtime, signal) => {
          const input = recordInput({
            text: `/${name}${args ? ` ${args}` : ""}`,
            cwd: handle.cwd,
            sessionId: handle.sessionId,
            source: "sdk",
          });
          const message: Message = {
            role: "user",
            content: input.text,
            userInput: { id: input.id, timestamp: input.timestamp },
          };
          this.session!.sessionManager.append(message);
          handle.conv.appendMessages([message]);
          const output = await runFork(
            skill,
            args,
            forkHost,
            AbortSignal.any([controller.signal, signal]),
          );
          const response: Message = { role: "assistant", content: output };
          this.session!.sessionManager.append(response);
          handle.conv.appendMessages([response]);
          return output;
        },
      );
      this.reportSubagent({
        ...activity,
        type: "finished",
        status: controller.signal.aborted ? "stopped" : "completed",
      });
      emit({ type: "stream_text", data: { text: result } });
      emit({ type: "turn_complete" });
      emit({ type: "loop_complete", data: { stopReason: "end_turn" } });
    } catch (error) {
      this.reportSubagent({
        ...activity,
        type: "finished",
        status: controller.signal.aborted ? "stopped" : "failed",
      });
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "error",
        data: { message: `Skill fork error: ${message}` },
      });
    } finally {
      this.commandController = null;
      this.completeRun(handle);
    }
  }

  private async runCompact(
    handle: AgentRuntime,
    instructions: string,
  ): Promise<void> {
    this.setStreaming(true);
    try {
      await this.session!.compact(instructions);
    } finally {
      this.completeRun(handle);
    }
  }

  private async runResume(handle: AgentRuntime, args: string): Promise<void> {
    const sessions = listSessions(handle.cwd);
    if (sessions.length === 0) {
      emit({
        type: "system",
        data: { message: "No previous sessions found." },
      });
      return;
    }
    if (!args) {
      const lines = sessions.slice(0, 20).map((session, index) => {
        const when = session.modTime
          .toISOString()
          .slice(0, 16)
          .replace("T", " ");
        return `${String(index + 1)}. [${session.id}] ${when} · ${session.messageCount} msgs — ${session.firstMessage}`;
      });
      emit({
        type: "system",
        data: {
          message: `Recent sessions:\n\n${lines.join("\n")}\n\nUse the sidebar or /resume <number> to restore one.`,
        },
      });
      return;
    }
    let targetId = args;
    const idx = /^\d+$/.test(targetId) ? Number(targetId) : Number.NaN;
    if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      targetId = sessions[idx - 1]?.id ?? targetId;
    }
    if (!sessions.some((session) => session.id === targetId)) {
      emit({ type: "system", data: { message: `Session not found: ${args}` } });
      return;
    }
    const result = await this.resumeSession(targetId);
    // The IPC path returns history to the caller; the command path pushes it.
    emit({ type: "history", data: result });
  }

  private buildMemoryStatus(handle: AgentRuntime, args: string): string {
    if (!handle.memoryEnabled) {
      return "Auto memory is disabled (enable_memory: false in config.yaml).";
    }
    const sub = args.trim().split(/\s+/u)[0];
    if (sub === "clear") {
      handle.memoryManager.clear();
      return "All memories cleared.";
    }
    const memories = handle.memoryManager.getMemories();
    if (memories.length === 0) {
      return "No memories saved yet. They are auto-extracted; /memory clear wipes them.";
    }
    return (
      `Memories (${String(memories.length)}):\n` +
      memories
        .map((m) => `  [${m.type}] ${m.name} — ${m.description}`)
        .join("\n")
    );
  }

  private buildSessionStatus(handle: AgentRuntime): string {
    return [
      `Mode:      ${handle.permissionMode}`,
      `Model:     ${handle.provider.model}`,
      `Provider:  ${handle.provider.name} (${handle.provider.protocol})`,
      `Tokens:    ${String(this.lastUsage.inputTokens)} in / ${String(this.lastUsage.outputTokens)} out`,
      `Tools:     ${String(handle.registry.listTools().length)}`,
      `Memories:  ${handle.memoryEnabled ? String(handle.memoryManager.getMemories().length) : "disabled"}`,
      `Skills:    ${String(handle.skillCatalog?.list().length ?? 0)}`,
      `MCP:       ${String(handle.mcpManager?.connectedServers().length ?? 0)} server(s)`,
      `Session:   ${handle.sessionId}`,
      `Directory: ${handle.cwd}`,
    ].join("\n");
  }

  // ---------- settings ----------

  async getSettings(): Promise<SettingsSnapshot> {
    const handle = this.handle;
    const config = !handle
      ? loadConfig(undefined, { allowEmptyProviders: true })
      : null;
    const providers = config?.providers ?? this.providers;
    this.providers = providers;
    const current =
      handle?.provider ?? providers[config?.default_provider ?? 0];
    return {
      providers: providers.map((provider) => ({
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.base_url,
        model: provider.model,
      })),
      currentProvider: Math.max(
        0,
        providers.findIndex(
          (provider) => provider.base_url === current?.base_url,
        ),
      ),
      model: current?.model ?? "",
      thinkingLevel: handle
        ? this.currentThinkingLevel(handle)
        : (current?.thinking ?? DEFAULT_THINKING),
      thinkingLevels: handle
        ? this.supportedThinkingLevels(handle)
        : [...THINKING_LEVELS],
      preferences: this.session?.getSettings() ?? {
        values: RuntimePreferencesSchema.parse(config),
        sources: [],
      },
    };
  }

  async listModels(): Promise<ModelListResult> {
    const handle = await this.ensureHandle();
    if (!handle) {
      return { status: "error", models: [], current: "" };
    }
    this.modelListController?.abort();
    const controller = new AbortController();
    this.modelListController = controller;
    const current = handle.provider.model;
    try {
      const models = await discoverModels(
        {
          protocol: handle.provider.protocol,
          base_url: handle.provider.base_url,
          api_key: handle.provider.api_key,
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        return { status: "loading", models: [], current };
      }
      return {
        status: models.length > 0 ? "ready" : "empty",
        models: models.map((model) => ({
          id: model.id,
          name: model.display_name ?? model.name ?? null,
        })),
        current,
      };
    } catch {
      return { status: "error", models: [], current };
    } finally {
      if (this.modelListController === controller) {
        this.modelListController = null;
      }
    }
  }

  /** Persists the new model to config.yaml and rebuilds the LLM client. */
  async setModel(model: string): Promise<void> {
    this.assertIdle();
    const trimmed = model.trim();
    if (!trimmed) {
      throw new Error("Enter a model name");
    }
    if (this.initPromise) {
      await this.initPromise;
    }
    const handle = this.handle;
    if (!handle) {
      const config = loadConfig(undefined, {
        allowEmptyProviders: true,
      });
      const provider = resolveDefaultProvider(
        config.providers,
        config.default_provider,
      );
      persistModel(provider.base_url, trimmed);
      const result = await this.init();
      if (!result.ok) {
        throw new Error(result.error);
      }
      return;
    }
    await this.setModelInternal(handle, trimmed);
  }

  private async setModelInternal(
    handle: AgentRuntime,
    model: string,
  ): Promise<void> {
    await this.session!.setModel(model);
    this.providers = this.providers.map((entry) =>
      entry.base_url === handle.provider.base_url ? { ...entry, model } : entry,
    );
    persistModel(handle.provider.base_url, model);
    this.broadcastUpdatedState(this.handle!);
  }

  async setProvider(index: number): Promise<void> {
    this.assertIdle();
    const config = loadConfig(undefined, { allowEmptyProviders: true });
    const provider = config.providers[index];
    if (!provider) {
      throw new Error("The provider no longer exists. Refresh settings.");
    }
    this.providers = config.providers;
    if (!this.session) {
      persistDefaultProvider(index);
      const result = await this.init();
      if (!result.ok) {
        throw new Error(result.error);
      }
      return;
    }
    await this.session.setModel(provider);
    persistDefaultProvider(index);
    this.broadcastUpdatedState(this.handle!);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.assertIdle();
    const handle = await this.ensureHandle();
    if (!handle || !this.session) {
      throw new Error("The agent is not initialized");
    }
    const effective = this.session.setThinking(level as ThinkingLevel);
    persistThinkingLevel(handle.provider.base_url, effective);
    this.broadcastUpdatedState(this.handle!);
  }

  /** Re-emits init_state so the header badge/model stays in sync. */
  private broadcastUpdatedState(handle: AgentRuntime): void {
    emit({ type: "init_state", data: this.buildInitState(handle) });
  }

  private broadcastPreferences(): void {
    if (this.session) {
      const settings = this.session.getSettings();
      emit({ type: "preferences", data: settings });
      const theme = settings.values.theme;
      this.setTheme(theme === "auto" ? "system" : theme);
    }
  }

  async setPreferences(
    input: PreferencesPatch,
    persist = false,
  ): Promise<SettingsSnapshot> {
    const patch = PreferencesPatchSchema.parse(input);
    if (this.session) {
      await this.session.setSettings(patch, { persist });
    } else {
      if (!persist) {
        throw new Error("Add a provider before changing session settings");
      }
      persistPreferences(patch);
    }
    this.broadcastPreferences();
    return this.getSettings();
  }

  async reloadResources(): Promise<void> {
    this.assertIdle();
    if (!this.session) {
      const state = await this.init();
      if (!state.ok) {
        throw new Error(state.error);
      }
      return;
    }
    await this.executeControl({ type: "reload" });
    emit({
      type: "system",
      data: {
        message:
          "Reloaded settings, instructions, skills, hooks, commands and MCP.",
      },
    });
  }

  private resetSessionUi(): void {
    this.subagents.clear();
    this.mcpApps.clear();
    this.pendingPlan = null;
    emit({ type: "plan_approval", data: null });
  }

  private async observeWorkflows(handle: AgentRuntime): Promise<void> {
    const service = getWorkflowService(handle.registry);
    if (this.workflowObserver?.service === service) {
      await this.workflowObserver?.ready;
      return;
    }
    this.workflowObserver?.off();
    this.workflowObserver = null;
    if (!service) {
      return;
    }
    const observer = {
      service,
      ready: service.loadPersistedRuns(),
      off: service.store.subscribe(() => {
        emit({ type: "runtime_changed" });
      }),
    };
    this.workflowObserver = observer;
    try {
      await observer.ready;
    } catch (error) {
      if (this.workflowObserver === observer) {
        observer.off();
        this.workflowObserver = null;
      }
      throw error;
    }
  }

  private assertIdle(): void {
    if (this.streaming || this.session?.isBusy) {
      throw new Error(
        "Stop the current task before switching projects, sessions, or settings",
      );
    }
  }

  async getRuntime(): Promise<RuntimeSnapshot> {
    const session = this.session;
    const handle = this.handle;
    if (!session || !handle) {
      throw new Error(
        "The agent is not initialized. Check the provider configuration.",
      );
    }
    await this.observeWorkflows(handle);
    if (handle !== this.handle) {
      return this.getRuntime();
    }
    const tools = handle.registry.listTools();
    return {
      tools: tools.map((tool) => tool.name),
      toolDescriptions: Object.fromEntries(
        tools.map((tool) => [tool.name, tool.description]),
      ),
      skills: (handle.skillCatalog?.list() ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      memories: handle.memoryEnabled
        ? handle.memoryManager.getMemories().map((memory) => ({
            name: memory.name,
            description: memory.description,
            type: memory.type,
            content: memory.content,
          }))
        : [],
      mcpServers: handle.mcpManager?.connectedServers() ?? [],
      tasks: handle.taskList.list(),
      backgroundTasks: handle.backgroundTaskManager.list().map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status,
        kind: task.kind ?? "agent",
        startedAt: task.startedAt,
        output: task.output.slice(-100_000),
      })),
      teammates: handle.teamManager.getAllTeammateStates(),
      subagents: [...this.subagents.values()],
      workflows: session.getWorkflowState(),
      namedWorkflows: handle.cmdRegistry
        .listCommands()
        .filter((command) => command.resource === "workflow")
        .map((command) => command.name)
        .sort(),
      goal: handle.goalManager?.get() ?? null,
      sandbox: {
        enabled: handle.checker.sandboxEnabled,
        autoAllow: handle.checker.sandboxAutoAllow,
      },
      coordinator: handle.enableCoordinatorMode,
      hooks: (handle.hookEngine?.size ?? 0) > 0,
      memoryEnabled: handle.memoryEnabled,
      activeSkills: [...handle.activeSkills.keys()],
      checkpoints: handle.fileHistory.getSnapshots().map((snapshot) => ({
        id: snapshot.id,
        text: snapshot.userText,
        timestamp: snapshot.timestamp,
        files: Object.keys(snapshot.backups).length,
      })),
      permissionMode: handle.permissionMode,
    };
  }

  async runtimeAction(action: RuntimeAction): Promise<void> {
    const handle = this.handle;
    if (!handle) {
      throw new Error("The agent is not initialized");
    }
    await applyRuntimeAction(handle, action, {
      assertIdle: () => {
        this.assertIdle();
      },
      reloadMcp: () => this.reloadResources(),
      reloadSkills: () => this.reloadResources(),
      setSandbox: (mode) => this.runLocalUiCommand(handle, "sandbox", mode),
    });
  }

  async rewind(
    id: string,
    mode: "code_only" | "conversation_only" | "code_and_conversation",
  ): Promise<void> {
    this.assertIdle();
    if (
      !["code_only", "conversation_only", "code_and_conversation"].includes(
        mode,
      )
    ) {
      throw new Error("Invalid restore scope");
    }
    const handle = await this.ensureHandle();
    if (!handle) {
      throw new Error("The agent is not initialized");
    }
    const snapshot = handle.fileHistory
      .getSnapshots()
      .find((entry) => entry.id === id);
    if (!snapshot) {
      throw new Error("This checkpoint is no longer valid. Refresh the list.");
    }
    if (mode !== "conversation_only") {
      handle.fileHistory.rewind(snapshot.id);
    }
    if (mode !== "code_only") {
      await handle.stopMemoryTasks();
      await this.session!.navigate(snapshot.entryId);
    }
    emit({ type: "workspace_changed", data: { cwd: this.cwd, path: null } });
    emit({
      type: "system",
      data: { message: "Restored the selected checkpoint" },
    });
  }

  private async executeControl(action: AgentControl): Promise<unknown> {
    const session = this.session;
    if (!session) {
      throw new Error("The agent is not initialized");
    }
    const exclusive = [
      "reload",
      "navigate",
      "fork",
      "clone",
      "compact",
      "cycle_model",
      "revoke_trust",
      "mcp_register",
      "mcp_connect",
      "mcp_reload",
      "mcp_login",
      "mcp_read",
      "mcp_resources",
      "workflow_run",
    ].includes(action.type);
    const ownsStreaming = exclusive && !this.streaming;
    if (ownsStreaming) {
      this.setStreaming(true);
    }
    try {
      const result = await controlAgent(
        session,
        action,
        async (url, submitCallback) => {
          if (!["https:", "http:"].includes(url.protocol)) {
            throw new Error("Invalid authorization URL");
          }
          await shell.openExternal(url.href);
          if (
            action.type === "mcp_login" &&
            this.handle?.mcpManager?.getServerConfig(action.server).oauth
              ?.callback?.mode === "headless"
          ) {
            const question =
              "Paste the authorization callback URL from your browser";
            const answers = await this.createAsker()(
              [{ question, multiSelect: false, options: [] }],
              this.lifetimeController.signal,
            );
            const callback = answers[question]?.trim();
            if (!callback) {
              throw new Error("Authorization cancelled");
            }
            submitCallback(callback);
          }
        },
      );
      if (
        action.type === "reload" &&
        this.session === session &&
        !session.isDisposed
      ) {
        this.providers = loadConfig().providers;
      }
      return result;
    } finally {
      if (this.session === session && !session.isDisposed) {
        if (action.type === "reload") {
          this.mcpApps.clear();
        }
        if (ownsStreaming) {
          this.setStreaming(session.isBusy);
        }
        this.broadcastPreferences();
        this.broadcastUpdatedState(session.runtime);
      }
    }
  }

  // ---------- ipc ----------

  registerIpc(): void {
    const handle = (
      channel: string,
      listener: Parameters<typeof ipcMain.handle>[1],
    ): void => {
      ipcMain.handle(channel, withIpcLogging(this.log, channel, listener));
    };
    const workspace = (): Workspace => {
      if (!this.workspace) {
        throw new Error("Open a project first");
      }
      return this.workspace;
    };
    handle("workspace:list", (_event, path?: string) => workspace().list(path));
    handle("workspace:read", (_event, path: string) => workspace().read(path));
    handle(
      "workspace:save",
      (_event, path: string, content: string, revision: string) =>
        workspace().save(path, content, revision),
    );
    handle("workspace:snapshot", () => workspace().snapshot());
    handle("yukino:agent-state", () => {
      if (!this.session) {
        throw new Error("The agent is not initialized");
      }
      return snapshotAgent(this.session, this.originalQueueText);
    });
    handle("yukino:agent-control", (_event, action: AgentControl) =>
      this.executeControl(action),
    );
    handle(
      "yukino:set-preferences",
      (_event, patch: PreferencesPatch, persist: boolean) =>
        this.setPreferences(patch, persist),
    );
    handle("yukino:reload", () => this.reloadResources());
    handle(
      "yukino:transfer",
      async (
        _event,
        action: "import" | "export" | "diagnostics",
        options?: {
          scope: "active" | "tree";
          format: "jsonl" | "html";
          redact: boolean;
        },
      ) => {
        this.assertIdle();
        if (!this.session) {
          throw new Error("The agent is not initialized");
        }
        if (action === "import") {
          const selected = await dialog.showOpenDialog({
            title: "Import session",
            properties: ["openFile"],
            filters: [{ name: "Session", extensions: ["jsonl"] }],
          });
          if (selected.canceled || !selected.filePaths[0]) {
            return false;
          }
          await this.session.importFile(selected.filePaths[0]);
        } else if (action === "export" || action === "diagnostics") {
          const format = action === "diagnostics" ? "json" : options?.format;
          if (!["jsonl", "html", "json"].includes(format ?? "")) {
            throw new Error("Invalid export format");
          }
          const selected = await dialog.showSaveDialog({
            title:
              action === "diagnostics" ? "Save diagnostics" : "Export session",
            defaultPath: `yukino-${this.session.sessionId}.${format}`,
          });
          if (selected.canceled || !selected.filePath) {
            return false;
          }
          if (action === "diagnostics") {
            writeFileSync(selected.filePath, this.session.diagnostics(), {
              mode: 0o600,
            });
          } else {
            await this.session.exportFile(selected.filePath, options!);
          }
        } else {
          throw new Error("Invalid session transfer");
        }
        return true;
      },
    );
    handle("yukino:runtime", () => this.getRuntime());
    handle("yukino:runtime-action", (_event, action: RuntimeAction) =>
      this.runtimeAction(action),
    );
    handle(
      "yukino:mcp-app",
      async (_event, appId: string, operation: McpAppOperation) => {
        const handle = await this.ensureHandle();
        if (!handle) {
          throw new Error("The agent is not initialized");
        }
        const request = McpAppRequestSchema.parse({
          ...operation,
          appId,
          requestId: randomUUID(),
        });
        return this.mcpApps.request(
          request,
          handle,
          this.createPermissionCallback(),
          AbortSignal.timeout(10 * 60 * 1000),
        );
      },
    );
    handle(
      "yukino:respond-plan",
      async (
        _event,
        id: string,
        choice: "approve" | "feedback",
        feedback?: string,
      ) => {
        if (this.pendingPlan?.id !== id || !this.planResponse) {
          throw new Error("The plan request has expired");
        }
        if (choice === "approve") {
          this.planResponse("approve");
        } else if (choice === "feedback" && feedback?.trim()) {
          this.planResponse({ feedback: feedback.trim() });
        } else {
          throw new Error("Invalid plan response");
        }
      },
    );
    handle(
      "yukino:rewind",
      (
        _event,
        id: string,
        mode: "code_only" | "conversation_only" | "code_and_conversation",
      ) => this.rewind(id, mode),
    );
    handle(
      "yukino:permission-mode",
      async (
        _event,
        mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
      ) => {
        this.assertIdle();
        if (
          !["default", "acceptEdits", "plan", "bypassPermissions"].includes(
            mode,
          )
        ) {
          throw new Error("Invalid permission mode");
        }
        const handle = await this.ensureHandle();
        if (handle) {
          await this.session!.runHostOperation(async (runtime) => {
            runtime.permissionMode = mode;
          });
          this.broadcastUpdatedState(handle);
        }
      },
    );
    handle("yukino:open-config", async () => {
      const error = await shell.openPath(globalConfigPath());
      if (error) {
        throw new Error(error);
      }
    });
    handle("yukino:open-logs", async () => {
      const error = await shell.openPath(app.getPath("logs"));
      if (error) {
        throw new Error(error);
      }
    });
    handle("yukino:attachments", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
      });
      return result.canceled ? [] : result.filePaths;
    });
    handle("yukino:paste-image", async () => {
      const id = this.session?.sessionId;
      if (!id) {
        throw new Error("Open a session before attaching an image");
      }
      for (const item of await clipboard.read()) {
        const format = (["image/png", "image/jpeg"] as const).find((type) =>
          item.types.includes(type),
        );
        if (!format) {
          continue;
        }
        const image = await item.getType(format);
        if (image.size > MAX_CLIPBOARD_IMAGE_BYTES) {
          throw new Error("The clipboard image is too large");
        }
        const bytes = Buffer.from(await image.arrayBuffer());
        return storeClipboardImage(
          id,
          format === "image/png"
            ? bytes
            : nativeImage.createFromBuffer(bytes).toPNG(),
        );
      }
      throw new Error("The clipboard does not contain a PNG or JPEG image");
    });
    handle("yukino:init", () => this.init());
    handle("yukino:send", (_event, text: string, delivery?: MessageDelivery) =>
      this.send(text, delivery),
    );
    handle("yukino:cancel-queued-message", (_event, id: string) =>
      this.cancelQueuedMessage(id),
    );
    handle("yukino:abort", () => {
      this.abort();
    });
    handle("yukino:new-session", () => this.newSession());
    handle("yukino:list-sessions", () => this.listSessions());
    handle("yukino:resume-session", (_event, sessionId: string, cwd?: string) =>
      this.resumeSession(sessionId, cwd),
    );
    handle("yukino:select-folder", () => this.selectFolder());
    handle(
      "yukino:respond-permission",
      (_event, id: string, response: PermissionResponse) => {
        this.respondPermission(id, response);
      },
    );
    handle(
      "yukino:respond-ask",
      (_event, id: string, answers: Record<string, string>) => {
        this.respondAsk(id, answers);
      },
    );
    handle("yukino:list-commands", () => this.listCommands());
    handle("yukino:run-command", (_event, input: string) =>
      this.runCommand(input),
    );
    handle("yukino:save-provider", async (_event, input: ProviderInput) => {
      this.assertIdle();
      const config = loadConfig(undefined, {
        allowEmptyProviders: true,
      });
      const saved = saveProvider(input, config.providers);
      this.providers = saved.providers;
      const index = saved.providers.findIndex(
        (provider) => provider.base_url === saved.provider.base_url,
      );
      persistDefaultProvider(index);
      if (this.handle) {
        await this.setProvider(index);
      } else {
        await this.init();
      }
    });
    handle("yukino:get-settings", () => this.getSettings());
    handle("yukino:list-models", () => this.listModels());
    handle("yukino:set-provider", (_event, index: number) =>
      this.setProvider(index),
    );
    handle("yukino:set-model", (_event, model: string) => this.setModel(model));
    handle("yukino:set-thinking-level", (_event, level: string) =>
      this.setThinkingLevel(level),
    );
    handle("yukino:get-theme", () => ({
      mode: this.getTheme(),
      dark: nativeTheme.shouldUseDarkColors,
    }));
    handle(
      "yukino:set-theme",
      async (_event, mode: "system" | "light" | "dark") => {
        if (!["system", "light", "dark"].includes(mode)) {
          throw new Error("Invalid theme");
        }
        await this.setPreferences(
          { theme: mode === "system" ? "auto" : mode },
          true,
        );
        this.setTheme(mode);
      },
    );
  }

  async dispose(): Promise<void> {
    this.workflowObserver?.off();
    this.workflowObserver = null;
    this.disposing = true;
    this.lifetimeController.abort();
    for (const id of this.pendingAsks.keys()) {
      this.respondAsk(id, {});
    }
    for (const id of this.pendingPermissions.keys()) {
      this.respondPermission(id, "deny");
    }
    if (this.wakeupTimer) {
      clearInterval(this.wakeupTimer);
    }
    this.wakeupTimer = null;
    if (this.initPromise) {
      await this.initPromise;
    }
    this.abort();
    this.resetSessionUi();
    this.workspace?.dispose();
    this.workspace = null;
    for (const id of this.pendingPermissions.keys()) {
      this.respondPermission(id, "deny");
    }
    for (const id of this.pendingAsks.keys()) {
      this.respondAsk(id, {});
    }
    const session = this.session;
    this.session = null;
    await session?.dispose();
  }
}
