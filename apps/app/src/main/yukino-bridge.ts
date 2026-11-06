// Electron main-process bridge over the @yukino.js/yukino library entry.
//
// The library barrel (Remote.Server.createRemoteAgent) initializes the full
// agent stack — tools, LLM client, conversation, session, MCP, memory — and
// yields AgentEvents from handle.run(). This bridge adapts that generator
// into push events over IPC, and adapts the permission/ask callbacks into
// pending-promise exchanges with the renderer.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  AskRequestPayload,
  BridgeEvent,
  CommandSummary,
  HistoryMessage,
  InitState,
  ModelListResult,
  McpAppOperation,
  PermissionRequestPayload,
  PermissionResponse,
  ProviderInput,
  ResumeResult,
  SessionSummary,
  SettingsSnapshot,
  UsagePayload,
} from "@shared/ipc-types";
import type { Agent, Permissions, Tools } from "@yukino.js/yukino";
import {
  Remote,
  Config,
  Commands,
  Skills,
  Prompt,
  Subagent,
  Compact,
  MCP,
  LLM,
  Session,
  Storage,
  Teams,
  Workflow,
  Bootstrap,
  Tools as YukinoTools,
  Goal,
  Conversation,
  History,
  Utils,
  PlanFile,
} from "@yukino.js/yukino";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  app,
  shell,
} from "electron";

import type {
  RuntimeAction,
  RuntimeSnapshot,
  SubagentSnapshot,
} from "../shared/workspace-types";

import { applyRuntimeAction } from "./agent-runtime";
import { ProjectError, resolveProject } from "./project";
import { Workspace } from "./workspace";

type RemoteAgentHandle = Remote.Server.RemoteAgentHandle;
type CreateRemoteAgentOptions = Remote.Server.CreateRemoteAgentOptions;
type AgentEvent = Agent.Events.AgentEvent;
type Decision = Permissions.Decision;
type AskUserQuestion = Tools.AskUser.Question;
type ProviderConfig = Config.ProviderConfig.ProviderConfig;
type Command = Commands.Commands.Command;
type CommandContext = Commands.Commands.CommandContext;
type ThinkingLevel = Config.ProviderConfig.ThinkingLevel;
type SkillForkHost = Skills.SkillForkHost;
type ToolProtocol = "anthropic" | "openai" | "openai-compat";

const DEFAULT_THINKING = Config.Constants.DEFAULT_THINKING_LEVEL;

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

function projectHistory(messages: Conversation.Message[]): HistoryMessage[] {
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

/** Persisted UI state (last folder, theme choice). */
interface PersistedState {
  cwd?: string;
  theme?: "system" | "light" | "dark";
}

class StateStore {
  private get path(): string {
    return join(app.getPath("userData"), "state.json");
  }

  read(): PersistedState {
    try {
      if (!existsSync(this.path)) {
        return {};
      }
      return JSON.parse(readFileSync(this.path, "utf-8")) as PersistedState;
    } catch {
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
    } catch {
      // Best-effort persistence; never block the UI on it.
    }
  }
}

export class YukinoBridge {
  private handle: RemoteAgentHandle | null = null;
  private workspace: Workspace | null = null;
  private mcpApps = new Remote.McpApps.RemoteMcpApps();
  private initPromise: Promise<InitState> | null = null;
  private streaming = false;
  private wakeupTimer: ReturnType<typeof setInterval> | null = null;
  private disposing = false;
  private interrupted = false;
  private pendingPlan: { id: string; content: string; path: string } | null =
    null;
  private planReady = false;
  private cwd: string;
  private readonly state = new StateStore();
  /** All configured providers (merged with project MCP); drives settings. */
  private providers: ProviderConfig[] = [];
  /** Last usage snapshot, for /status. */
  private lastUsage = { inputTokens: 0, outputTokens: 0 };
  /** Abort controller for command runs (subagents, compaction) outside handle.run. */
  private commandController: AbortController | null = null;
  private modelListController: AbortController | null = null;
  private mcpLoading: Config.McpLoading = "auto";
  private hasHooks = false;

  private readonly pendingPermissions = new Map<
    string,
    (response: PermissionResponse) => void
  >();
  private readonly pendingAsks = new Map<
    string,
    (answers: Record<string, string>) => void
  >();
  /** Messages sent while a run is busy but steering was unavailable. */
  private readonly followUps: string[] = [];
  private readonly subagents = new Map<string, SubagentSnapshot>();

  constructor() {
    this.cwd = this.state.read().cwd || homedir();
  }

  // ---------- theme ----------

  getTheme(): "system" | "light" | "dark" {
    return this.state.read().theme ?? "system";
  }

  setTheme(mode: "system" | "light" | "dark"): void {
    this.state.write({ theme: mode });
    nativeTheme.themeSource = mode;
    this.broadcastTheme();
  }

  applyTheme(): void {
    nativeTheme.themeSource = this.getTheme();
    nativeTheme.on("updated", () => {
      this.broadcastTheme();
    });
  }

  private broadcastTheme(): void {
    const theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
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
      emit({
        type: "history",
        data: {
          sessionId: this.handle.sessionId,
          messages: projectHistory(this.handle.conv.getMessages()),
        },
      });
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
    try {
      this.cwd = await resolveProject(this.cwd);
      if (!this.workspace) {
        this.workspace = new Workspace(
          this.cwd,
          (path) => {
            emit({ type: "workspace_changed", data: { cwd: this.cwd, path } });
          },
          (path) => {
            this.handle?.fileHistory.trackEdit(path);
            this.handle?.fileStateCache.delete(path);
          },
        );
        this.workspace.start();
      }
      const configPath = Config.ProviderConfig.globalConfigPath();
      let config: Config.AppConfig;
      try {
        config = Config.loadConfig(undefined, { allowEmptyProviders: true });
      } catch (error) {
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

      const merged = Config.withProjectMcpServers(config, this.cwd);
      this.providers = merged.providers;
      const provider = Config.ProviderConfig.resolveDefaultProvider(
        merged.providers,
        merged.default_provider,
      );

      const handle = await this.createHandle(provider, merged);
      this.handle = handle;
      this.startNotificationWakeup();
      this.state.write({ cwd: this.cwd });

      const okState = this.buildInitState(handle);
      emit({ type: "init_state", data: okState });
      return okState;
    } catch (error) {
      this.workspace?.dispose();
      this.workspace = null;
      return this.initError(
        error instanceof ProjectError
          ? error.message
          : "Agent initialization failed. Check the configuration and try again.",
        {
          kind: error instanceof ProjectError ? "project" : "runtime",
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

  private buildInitState(handle: RemoteAgentHandle): InitState & { ok: true } {
    return {
      ok: true,
      cwd: handle.cwd,
      projectKey: Storage.projectKey(handle.cwd),
      providerName: handle.provider.name,
      model: handle.provider.model,
      sessionId: handle.sessionId,
      permissionMode: handle.permissionMode,
      contextWindow: handle.contextWindow,
      thinkingLevel: this.currentThinkingLevel(handle),
    };
  }

  private currentThinkingLevel(handle: RemoteAgentHandle): ThinkingLevel {
    return (
      handle.client.getThinkingLevel?.() ??
      handle.provider.thinking ??
      DEFAULT_THINKING
    );
  }

  private supportedThinkingLevels(handle: RemoteAgentHandle): ThinkingLevel[] {
    return [
      ...(handle.client.getSupportedThinkingLevels?.() ??
        Config.ProviderConfig.getSupportedThinkingLevels(handle.provider)),
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
    const failure: InitState = { ok: false, error: message, ...context };
    emit({ type: "init_state", data: failure });
    return failure;
  }

  private async createHandle(
    provider: ProviderConfig,
    config: Config.AppConfig,
  ): Promise<RemoteAgentHandle> {
    const options: CreateRemoteAgentOptions = {
      provider,
      interactionMode: "interactive",
      enableModelPlanMode: true,
      cwd: this.cwd,
      enableCoordinatorMode: config.enable_coordinator_mode ?? false,
      memoryEnabled: Config.memoryEnabled(config),
      mcpLoading: config.mcp_loading,
      askUser: this.createAsker(),
      onSubagentEvent: (event) => {
        this.reportSubagent(event);
      },
    };
    if (config.hooks) {
      options.hooks = config.hooks;
    }
    if (config.mcp_servers) {
      options.mcpServers = config.mcp_servers;
    }
    if (config.sandbox) {
      options.sandboxConfig = config.sandbox;
    }
    const handle = await Remote.Server.createRemoteAgent(options);
    handle.permissionMode = config.permission_mode ?? "default";
    this.mcpLoading = config.mcp_loading;
    this.hasHooks = config.hooks.length > 0;
    try {
      await Workflow.Wiring.getWorkflowService(
        handle.registry,
      )?.loadPersistedRuns();
      return handle;
    } catch (error) {
      await handle.dispose();
      throw error;
    }
  }

  private reportSubagent(event: Remote.Server.RemoteSubagentEvent): void {
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

  private async ensureHandle(): Promise<RemoteAgentHandle | null> {
    if (this.handle) {
      return this.handle;
    }
    await this.init();
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
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const handle = await this.ensureHandle();
    if (!handle) {
      return;
    }

    if (this.streaming) {
      if (handle.steer(trimmed)) {
        return;
      }
      this.followUps.push(trimmed);
      return;
    }

    // Slash commands run through their own dispatch path (WS server parity);
    // /goal is handled inside handle.run, so plain text takes the run loop.
    const bash = Conversation.UserBash.parseUserBashCommand(trimmed);
    if (bash) {
      await this.runUserBash(handle, bash.command, bash.excludeFromContext);
      return;
    }
    const parsed = Commands.Commands.resolve(trimmed, handle.cmdRegistry);
    if (parsed) {
      if (parsed.name !== "goal") {
        await this.runCommandInternal(handle, parsed.name, parsed.args);
        return;
      }
    }

    await this.runLoop(handle, trimmed);
  }

  private async runLoop(
    handle: RemoteAgentHandle,
    text: string | null,
  ): Promise<void> {
    this.setStreaming(true);
    try {
      const expanded =
        text === null
          ? null
          : await Conversation.AtExpand.expandAtRefsWithImages(
              text,
              handle.cwd,
            );
      for await (const event of handle.run(expanded, {
        onPermissionRequest: this.createPermissionCallback(),
      })) {
        if (event.type === "tool_use") {
          const path = event.args.file_path ?? event.args.path;
          if (
            typeof path === "string" &&
            ["Edit", "Write", "NotebookEdit"].includes(event.toolName)
          ) {
            await this.workspace?.capture(path);
          }
        }
        this.emitAgentEvent(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", data: { message } });
    } finally {
      this.completeRun(handle);
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
        this.followUps.length ||
        this.interrupted
      ) {
        return;
      }
      if (
        handle.backgroundTaskManager.hasNotifications() ||
        handle.teamManager.hasLeaderNotifications()
      ) {
        void this.runLoop(handle, null);
      }
    }, 500);
    this.wakeupTimer.unref();
  }

  private async runUserBash(
    handle: RemoteAgentHandle,
    command: string,
    excludeFromContext: boolean,
  ): Promise<void> {
    if (!command) {
      throw new Error("Enter a command after !");
    }
    const bash = handle.registry.getInstanceOf(
      "Bash",
      YukinoTools.Bash.BashTool,
    );
    if (!bash) {
      throw new Error("The Bash tool is unavailable");
    }
    const controller = new AbortController();
    this.commandController = controller;
    this.setStreaming(true);
    const toolId = randomUUID();
    const start = Date.now();
    emit({
      type: "tool_use",
      data: { toolId, toolName: "Bash", args: { command } },
    });
    let result: Tools.ToolResult;
    try {
      result = await Conversation.UserBash.executeUserBash(
        bash,
        {
          cwd: handle.cwd,
          sessionId: handle.sessionId,
          abortSignal: controller.signal,
          onOutput: (output) => {
            emit({
              type: "tool_output",
              data: { toolId, output: Utils.plainTerminalText(output) },
            });
          },
        },
        command,
        excludeFromContext,
      );
    } catch (error) {
      result = {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
    try {
      const elapsed = (Date.now() - start) / 1000;
      emit({
        type: "tool_result",
        data: {
          toolId,
          toolName: "Bash",
          output: result.output,
          isError: result.isError ?? false,
          elapsed,
        },
      });
      const recorded: Conversation.UserBashResult = {
        command,
        excludeFromContext,
        output: result.output,
        isError: result.isError ?? false,
        elapsed,
        status: controller.signal.aborted
          ? "stopped"
          : result.isError
            ? "failed"
            : "completed",
      };
      const input = History.recordInput({
        text: `${excludeFromContext ? "!!" : "!"}${command}`,
        cwd: handle.cwd,
        sessionId: handle.sessionId,
        source: "sdk",
      });
      const message = Session.saveUserMessage(
        handle.cwd,
        handle.sessionId,
        input,
        {
          content: Conversation.Prompts.userBashContext(recorded),
          user_bash: recorded,
        },
      );
      handle.conv.appendMessages(Session.rebuildFromSession([message]));
    } finally {
      this.commandController = null;
      this.completeRun(handle);
    }
  }

  private completeRun(handle: RemoteAgentHandle): void {
    this.setStreaming(false);
    this.broadcastUpdatedState(handle);
    const leftovers = handle.takeSteeringLeftovers();
    if (this.interrupted) {
      this.planReady = false;
    } else {
      this.followUps.push(...leftovers.map((message) => message.text));
    }
    if (this.planReady && handle.permissionMode === "plan") {
      this.planReady = false;
      const content = PlanFile.loadPlan(handle) ?? "";
      this.pendingPlan = {
        id: randomUUID(),
        content,
        path: handle.planFilePath ?? "",
      };
      emit({ type: "plan_approval", data: this.pendingPlan });
    } else {
      const next = this.followUps.shift();
      if (next) {
        void this.send(next).catch((error: unknown) => {
          emit({
            type: "error",
            data: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
      }
    }
  }

  abort(): void {
    this.interrupted = true;
    this.followUps.length = 0;
    this.pendingPlan = null;
    this.planReady = false;
    emit({ type: "plan_approval", data: null });
    this.commandController?.abort();
    this.handle?.abort();
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
        if (
          ["EnterPlanMode", "ExitPlanMode"].includes(event.toolName) &&
          !event.isError
        ) {
          this.planReady = true;
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
        emit({ type: "error", data: { message: event.error.message } });
        break;
      case "compact":
        emit({ type: "compact", data: { message: event.message } });
        break;
      case "retry":
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
    await handle.backgroundTaskManager.stopAll();
    await handle.teamManager.stopAll();
    this.resetSessionUi();
    await handle.clearConversation();
    this.lastUsage = { inputTokens: 0, outputTokens: 0 };
    emit({
      type: "history",
      data: { sessionId: handle.sessionId, messages: [] },
    });
    emit({
      type: "session_changed",
      data: { sessionId: handle.sessionId, cwd: this.cwd },
    });
    return { sessionId: handle.sessionId };
  }

  /** Sessions across every known project, ordered by last user message. */
  listSessions(): SessionSummary[] {
    try {
      return Session.listAllSessions().map((session) => ({
        id: session.id,
        firstMessage: session.firstMessage,
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
    // Cross-project resume: the session lives in a different folder, so switch
    // the working directory (reinitializing the agent) before loading it.
    // Compare canonical project keys, not raw strings — the app's persisted
    // cwd may be an unresolved alias (symlink, /var vs /private/var) of the
    // canonical path the activity registry recorded.
    this.assertIdle();
    if (cwd) {
      cwd = await resolveProject(cwd);
    }
    let switchedCwd = false;
    if (cwd && Storage.projectKey(cwd) !== Storage.projectKey(this.cwd)) {
      await this.reinit(cwd);
      switchedCwd = true;
    }
    const handle = await this.ensureHandle();
    if (!handle) {
      return { sessionId, messages: [], cwd: this.cwd, switchedCwd };
    }
    await handle.backgroundTaskManager.stopAll();
    await handle.teamManager.stopAll();
    this.resetSessionUi();
    const saved = Session.loadSession(handle.cwd, sessionId);
    await handle.stopMemoryTasks();
    Remote.SessionState.restoreRemoteSession(handle, sessionId, saved);
    const messages = projectHistory(
      Session.rebuildFromSession(saved, { includeExcludedUserBash: true }),
    );
    emit({
      type: "session_changed",
      data: { sessionId: handle.sessionId, cwd: this.cwd },
    });
    return {
      sessionId: handle.sessionId,
      messages,
      cwd: this.cwd,
      switchedCwd,
    };
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
    if (this.handle) {
      await this.handle.dispose();
      this.handle = null;
    }
    this.resetSessionUi();
    this.workspace?.dispose();
    this.workspace = null;
    this.cwd = cwd;
    this.lastUsage = { inputTokens: 0, outputTokens: 0 };
    this.followUps.length = 0;
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
    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Executes a slash command; results stream back as BridgeEvents. */
  async runCommand(input: string): Promise<void> {
    this.assertIdle();
    const handle = await this.ensureHandle();
    if (!handle) {
      return;
    }
    const parsed = Commands.Commands.resolve(input, handle.cmdRegistry);
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
    handle: RemoteAgentHandle,
    name: string,
    args: string,
  ): Promise<void> {
    const cmd = handle.cmdRegistry.find(name);
    const skill = handle.skillCatalog?.get(name);
    if (skill && (!cmd || cmd.isSkill)) {
      if (skill.meta.mode === "fork") {
        await this.runSkillFork(handle, name, args);
      } else {
        const prompt = Skills.Executor.runInline(skill, args, {
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
    handle: RemoteAgentHandle,
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
        Config.ProviderLogin.persistThinkingLevel(
          handle.provider.base_url,
          level,
        );
      },
    };
  }

  private async runLocalCommand(
    handle: RemoteAgentHandle,
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
        await this.reloadMcp(handle);
      }
      emit({ type: "system", data: { message: this.buildMcpStatus(handle) } });
      return;
    }
    if (cmd.name === "thinking" && !args.trim()) {
      // Terminal parity: bare /thinking reports the picker instead of opening a form.
      emit({
        type: "system",
        data: {
          message: `Thinking level: ${this.currentThinkingLevel(handle)}\nUsage: /thinking <${this.supportedThinkingLevels(handle).join(" | ")}>\n(Or change it in Settings.)`,
        },
      });
      return;
    }
    const result = cmd.handler(this.buildCommandContext(handle, args));
    emit({ type: "system", data: { message: result, markdown: cmd.markdown } });
  }

  private async runLocalUiCommand(
    handle: RemoteAgentHandle,
    name: string,
    args: string,
  ): Promise<void> {
    switch (name) {
      case "quit":
        app.quit();
        return;
      case "clear": {
        // Stop teammates AND background tasks before rotating the session
        // (server parity) so nothing keeps running into the new session.
        const stopResults = await Promise.allSettled([
          handle.backgroundTaskManager.stopAll(),
          handle.teamManager.stopAll(),
        ]);
        for (const result of stopResults) {
          if (result.status === "rejected") {
            const reason: unknown = result.reason;
            emit({
              type: "error",
              data: {
                message: `Clear could not stop all background work: ${reason instanceof Error ? reason.message : String(reason)}`,
              },
            });
          }
        }
        if (stopResults.some((result) => result.status === "rejected")) {
          return;
        }
        this.resetSessionUi();
        await handle.clearConversation();
        handle.toolFilter = null;
        emit({
          type: "session_changed",
          data: { sessionId: handle.sessionId, cwd: this.cwd },
        });
        // Empty history clears the renderer surface (same reducer path as resume).
        emit({
          type: "history",
          data: { sessionId: handle.sessionId, messages: [] },
        });
        return;
      }

      case "compact":
        await this.runCompact(handle, args.trim());
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
        const service = Workflow.Wiring.getWorkflowService(handle.registry);
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
        emit({ type: "open_runtime" });
        return;
      case "sandbox": {
        this.assertIdle();
        const mode = args.trim();
        if (["auto", "manual", "off"].includes(mode)) {
          const bash = handle.registry.getInstanceOf(
            "Bash",
            YukinoTools.Bash.BashTool,
          );
          if (bash?.sandbox) {
            await bash.sandbox.dispose?.();
            bash.sandbox = null;
          }
          await Bootstrap.Sandbox.configureBashSandbox(
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
          handle.skillCatalog?.reload();
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
        emit({
          type: "system",
          data: { message: `/${name} is only supported in the terminal.` },
        });
    }
  }

  private async runPromptCommand(
    handle: RemoteAgentHandle,
    cmd: Command,
    args: string,
  ): Promise<void> {
    const prompt = cmd.handler(this.buildCommandContext(handle, args));
    const displayText = args ? `/${cmd.name} ${args}` : `/${cmd.name}`;

    if (cmd.agent) {
      // Foreground subagent command (/plan, /review) — the agent runs on the
      // parent registry/conversation but reports through its own events.
      this.setStreaming(true);
      const controller = new AbortController();
      this.commandController = controller;
      try {
        const result = await Commands.Subagent.runSubagentCommand(
          cmd.agent,
          prompt,
          displayText,
          {
            cwd: handle.cwd,
            sessionId: handle.sessionId,
            registry: handle.registry,
            conversation: handle.conv,
            permissionChecker: handle.checker,
            onPermissionRequest: this.createPermissionCallback(),
            abortSignal: controller.signal,
            onEvent: (event) => {
              this.emitAgentEvent(event);
            },
          },
        );
        if (
          cmd.agent === "plan" &&
          !result.isError &&
          !controller.signal.aborted
        ) {
          this.planReady = true;
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

    // Persist the display text ("/name args") — the run stores the expanded prompt.
    Session.saveMessage(handle.cwd, handle.sessionId, {
      role: "user",
      content: displayText,
      timestamp: Math.floor(Date.now() / 1000),
    });
    await this.runLoop(handle, prompt);
  }

  private async runSkillFork(
    handle: RemoteAgentHandle,
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
          Subagent.Spawn.spawnSubagent(
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
      const result = await Skills.Executor.runFork(
        skill,
        args,
        forkHost,
        controller.signal,
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
    handle: RemoteAgentHandle,
    customInstructions: string,
  ): Promise<void> {
    this.setStreaming(true);
    const controller = new AbortController();
    this.commandController = controller;
    emit({ type: "system", data: { message: "Compacting conversation..." } });
    try {
      const protocol: ToolProtocol = handle.client.protocol ?? "anthropic";
      const toolFilter = Teams.Coordinator.coordinatorToolFilter(
        handle.enableCoordinatorMode,
      );
      const composedFilter = (toolName: string): boolean =>
        toolFilter(toolName) && (handle.toolFilter?.(toolName) ?? true);
      const toolNames = handle.registry.listVisibleToolNames(
        protocol,
        composedFilter,
      );
      const toolSchemas = handle.registry.getAllSchemas(
        protocol,
        composedFilter,
      );
      const result = await Compact.Compact.forceCompact(
        handle.conv,
        handle.client,
        handle.recoveryState,
        toolNames,
        toolSchemas,
        Session.getSessionFilePath(handle.cwd, handle.sessionId),
        controller.signal,
        customInstructions,
      );
      emit({
        type: "compact",
        data: { message: `Compacted: ${result.message}` },
      });
      if (result.boundary) {
        Session.saveCompactBoundary(
          handle.cwd,
          handle.sessionId,
          result.boundary,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", data: { message } });
    } finally {
      this.commandController = null;
      this.completeRun(handle);
    }
  }

  private async runResume(
    handle: RemoteAgentHandle,
    args: string,
  ): Promise<void> {
    const sessions = Session.listSessions(handle.cwd);
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

  private buildMemoryStatus(handle: RemoteAgentHandle, args: string): string {
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

  private buildSessionStatus(handle: RemoteAgentHandle): string {
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

  private buildMcpStatus(handle: RemoteAgentHandle): string {
    const manager = handle.mcpManager;
    if (!manager) {
      return "No MCP servers configured.";
    }
    const connected = manager.connectedServers();
    if (connected.length === 0) {
      return "No MCP servers connected.";
    }
    return [
      `MCP servers (${String(connected.length)}):`,
      ...connected.map((server) => `  · ${server}`),
    ].join("\n");
  }

  // ---------- settings ----------

  async getSettings(): Promise<SettingsSnapshot> {
    const handle = this.handle;
    const config = !handle
      ? Config.loadConfig(undefined, { allowEmptyProviders: true })
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
        : [...Config.Constants.THINKING_LEVELS],
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
      const models = await LLM.ModelDiscovery.discoverModels(
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
      const config = Config.loadConfig(undefined, {
        allowEmptyProviders: true,
      });
      const provider = Config.ProviderConfig.resolveDefaultProvider(
        config.providers,
        config.default_provider,
      );
      Config.ProviderLogin.persistModel(provider.base_url, trimmed);
      const result = await this.init();
      if (!result.ok) {
        throw new Error(result.error);
      }
      return;
    }
    await this.setModelInternal(handle, trimmed);
  }

  private async setModelInternal(
    handle: RemoteAgentHandle,
    model: string,
  ): Promise<void> {
    if (!model) {
      return;
    }
    if (model === handle.provider.model) {
      return;
    }
    const updated = { ...handle.provider, model };
    // Block concurrent sends while the client is being rebuilt.
    this.setStreaming(true);
    try {
      try {
        const environment = Prompt.Builder.detectEnvironment(handle.cwd);
        environment.model = updated.model;
        const client = await LLM.Client.createClient(
          updated,
          Prompt.Builder.buildSystemPrompt(environment),
        );
        await handle.stopMemoryTasks();
        handle.client = client;
        handle.provider = updated;
        handle.contextWindow = Config.ProviderConfig.getContextWindow(updated);
        this.providers = this.providers.map((entry) =>
          entry.base_url === updated.base_url
            ? { ...entry, model: updated.model }
            : entry,
        );
        MCP.Strategy.decideAndApply(
          handle.registry,
          updated.base_url,
          updated.protocol,
          handle.contextWindow,
          this.mcpLoading,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not switch models: ${message}`, {
          cause: error,
        });
      }
      // A save failure must not undo the runtime switch.
      let saved = true;
      try {
        Config.ProviderLogin.persistModel(updated.base_url, updated.model);
      } catch {
        saved = false;
      }
      this.broadcastUpdatedState(handle);
      if (!saved) {
        emit({
          type: "error",
          data: {
            message:
              "Settings are active but could not be saved to the config file.",
          },
        });
      }
    } finally {
      this.completeRun(handle);
    }
  }

  /** Persists the default provider and rebuilds the LLM client. */
  async setProvider(index: number): Promise<void> {
    this.assertIdle();
    if (this.initPromise) {
      await this.initPromise;
    }
    const config = Config.loadConfig(undefined, { allowEmptyProviders: true });
    this.providers = config.providers;
    const provider = this.providers[index];
    if (!provider) {
      throw new Error("The provider no longer exists. Refresh settings.");
    }
    const handle = this.handle;
    if (!handle) {
      Config.ProviderLogin.persistDefaultProvider(index);
      const result = await this.init();
      if (!result.ok) {
        throw new Error(result.error);
      }
      return;
    }
    // Block concurrent sends while the client is being rebuilt.
    this.setStreaming(true);
    try {
      try {
        const environment = Prompt.Builder.detectEnvironment(handle.cwd);
        environment.model = provider.model;
        const client = await LLM.Client.createClient(
          provider,
          Prompt.Builder.buildSystemPrompt(environment),
        );
        await handle.stopMemoryTasks();
        handle.client = client;
        handle.provider = provider;
        handle.contextWindow = Config.ProviderConfig.getContextWindow(provider);
        MCP.Strategy.decideAndApply(
          handle.registry,
          provider.base_url,
          provider.protocol,
          handle.contextWindow,
          this.mcpLoading,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not switch providers: ${message}`, {
          cause: error,
        });
      }
      // A save failure must not undo the runtime switch.
      let saved = true;
      try {
        Config.ProviderLogin.persistDefaultProvider(index);
      } catch {
        saved = false;
      }
      this.broadcastUpdatedState(handle);
      if (!saved) {
        emit({
          type: "error",
          data: {
            message:
              "Settings are active but could not be saved to the config file.",
          },
        });
      }
    } finally {
      this.completeRun(handle);
    }
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.assertIdle();
    const handle = await this.ensureHandle();
    if (!handle?.client.setThinkingLevel) {
      emit({
        type: "system",
        data: {
          message: "Thinking level control is not available for this provider.",
        },
      });
      return;
    }
    try {
      handle.client.setThinkingLevel(level as ThinkingLevel);
      handle.provider.thinking =
        handle.client.getThinkingLevel?.() ?? (level as ThinkingLevel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not set the thinking level: ${message}`, {
        cause: error,
      });
    }
    const effective = this.currentThinkingLevel(handle);
    try {
      Config.ProviderLogin.persistThinkingLevel(
        handle.provider.base_url,
        effective,
      );
    } catch {
      // Persistence is best-effort; the runtime change stands.
    }
    this.broadcastUpdatedState(handle);
  }

  /** Re-emits init_state so the header badge/model stays in sync. */
  private broadcastUpdatedState(handle: RemoteAgentHandle): void {
    emit({ type: "init_state", data: this.buildInitState(handle) });
  }

  private async reloadMcp(handle: RemoteAgentHandle): Promise<void> {
    const config = Config.withProjectMcpServers(
      Config.loadConfig(),
      handle.cwd,
    );
    const servers = config.mcp_servers;
    this.mcpLoading = config.mcp_loading;
    Bootstrap.ToolRegistry.removeMcpTools(handle.registry);
    MCP.Instructions.retractMcpInstructions(handle.conv, handle.mcpAnnounced);
    if (!servers.length) {
      await handle.mcpManager?.disconnectAll();
      handle.mcpManager = null;
      return;
    }
    const manager = handle.mcpManager ?? new MCP.Manager.MCPManager(true);
    handle.mcpManager = manager;
    const result = await manager.reconnectAll(servers);
    for (const { serverName, tool } of result.tools) {
      const client = manager.getClient(serverName);
      if (client) {
        handle.registry.register(
          new MCP.ToolWrapper.MCPToolWrapper(client, serverName, tool),
        );
      }
    }
    MCP.Strategy.decideAndApply(
      handle.registry,
      handle.provider.base_url,
      handle.provider.protocol,
      handle.contextWindow,
      this.mcpLoading,
    );
    for (const error of result.errors) {
      emit({
        type: "error",
        data: { message: `${error.serverName}: ${error.error}` },
      });
    }
  }

  private resetSessionUi(): void {
    this.subagents.clear();
    this.mcpApps.clear();
    this.pendingPlan = null;
    this.planReady = false;
    emit({ type: "plan_approval", data: null });
  }

  private assertIdle(): void {
    if (this.streaming) {
      throw new Error(
        "Stop the current task before switching projects, sessions, or settings",
      );
    }
  }

  async getRuntime(): Promise<RuntimeSnapshot> {
    const handle = this.handle;
    if (!handle) {
      throw new Error(
        "The agent is not initialized. Check the provider configuration.",
      );
    }
    return {
      tools: handle.registry.listTools().map((tool) => tool.name),
      toolDescriptions: Object.fromEntries(
        handle.registry
          .listTools()
          .map((tool) => [tool.name, tool.description]),
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
      workflows:
        Workflow.Wiring.getWorkflowService(
          handle.registry,
        )?.store.getSnapshot() ?? [],
      namedWorkflows: await Workflow.NamedWorkflows.listNamedWorkflows(
        join(handle.cwd, Workflow.Constants.WORKFLOW_DIR_NAME),
      ),
      goal: handle.goalManager?.get() ?? null,
      sandbox: {
        enabled: handle.checker.sandboxEnabled,
        autoAllow: handle.checker.sandboxAutoAllow,
      },
      coordinator: handle.enableCoordinatorMode,
      hooks: this.hasHooks,
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
      reloadMcp: () => this.reloadMcp(handle),
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
    const snapshots = handle.fileHistory.getSnapshots();
    const index = snapshots.findIndex((snapshot) => snapshot.id === id);
    const snapshot = snapshots[index];
    if (!snapshot) {
      throw new Error("This checkpoint is no longer valid. Refresh the list.");
    }
    if (mode !== "conversation_only") {
      handle.fileHistory.rewind(index);
    }
    if (mode !== "code_only") {
      await handle.stopMemoryTasks();
      if (snapshot.sessionLineCount !== undefined) {
        Session.truncateSessionLines(
          Session.getSessionFilePath(handle.cwd, handle.sessionId),
          snapshot.sessionLineCount,
        );
        handle.conv.reset();
        handle.conv.appendMessages(
          Session.rebuildFromSession(
            Session.loadSession(handle.cwd, handle.sessionId),
          ),
        );
      } else {
        handle.conv.truncateTo(snapshot.messageIndex);
      }
      handle.goalManager = new Goal.GoalManager(handle.cwd, handle.sessionId);
      const result = await this.resumeSession(handle.sessionId);
      emit({ type: "history", data: result });
    }
    emit({ type: "workspace_changed", data: { cwd: this.cwd, path: null } });
    emit({
      type: "system",
      data: { message: "Restored the selected checkpoint" },
    });
  }

  // ---------- ipc ----------

  registerIpc(): void {
    const workspace = (): Workspace => {
      if (!this.workspace) {
        throw new Error("Open a project first");
      }
      return this.workspace;
    };
    ipcMain.handle("workspace:list", (_event, path?: string) =>
      workspace().list(path),
    );
    ipcMain.handle("workspace:read", (_event, path: string) =>
      workspace().read(path),
    );
    ipcMain.handle(
      "workspace:save",
      (_event, path: string, content: string, revision: string) =>
        workspace().save(path, content, revision),
    );
    ipcMain.handle("workspace:snapshot", () => workspace().snapshot());
    ipcMain.handle("yukino:runtime", () => this.getRuntime());
    ipcMain.handle("yukino:runtime-action", (_event, action: RuntimeAction) =>
      this.runtimeAction(action),
    );
    ipcMain.handle(
      "yukino:mcp-app",
      async (_event, appId: string, operation: McpAppOperation) => {
        const handle = await this.ensureHandle();
        if (!handle) {
          throw new Error("The agent is not initialized");
        }
        const request = MCP.Apps.McpAppRequestSchema.parse({
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
    ipcMain.handle(
      "yukino:respond-plan",
      async (
        _event,
        id: string,
        choice: "approve" | "feedback",
        feedback?: string,
      ) => {
        this.assertIdle();
        const plan = this.pendingPlan;
        const handle = this.handle;
        if (plan?.id !== id || !handle) {
          throw new Error("The plan request has expired");
        }
        this.pendingPlan = null;
        emit({ type: "plan_approval", data: null });
        if (choice === "feedback") {
          if (feedback?.trim()) {
            await this.runLoop(handle, feedback.trim());
          }
          return;
        }
        if (choice !== "approve") {
          throw new Error("Invalid plan action");
        }
        handle.checker.exitPlanMode("default");
        handle.conv.addSystemReminder(
          Prompt.PlanMode.buildPlanModeExitReminder(
            plan.path,
            Boolean(plan.content),
          ),
        );
        this.broadcastUpdatedState(handle);
        await this.runLoop(
          handle,
          Prompt.Prompts.buildPlanExecutionPrompt(plan.content),
        );
      },
    );
    ipcMain.handle(
      "yukino:rewind",
      (
        _event,
        id: string,
        mode: "code_only" | "conversation_only" | "code_and_conversation",
      ) => this.rewind(id, mode),
    );
    ipcMain.handle(
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
          handle.permissionMode = mode;
          this.broadcastUpdatedState(handle);
        }
      },
    );
    ipcMain.handle("yukino:open-config", async () => {
      const error = await shell.openPath(
        Config.ProviderConfig.globalConfigPath(),
      );
      if (error) {
        throw new Error(error);
      }
    });
    ipcMain.handle("yukino:attachments", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
      });
      return result.canceled ? [] : result.filePaths;
    });
    ipcMain.handle("yukino:init", () => this.init());
    ipcMain.handle("yukino:send", (_event, text: string) => this.send(text));
    ipcMain.handle("yukino:abort", () => {
      this.abort();
    });
    ipcMain.handle("yukino:new-session", () => this.newSession());
    ipcMain.handle("yukino:list-sessions", () => this.listSessions());
    ipcMain.handle(
      "yukino:resume-session",
      (_event, sessionId: string, cwd?: string) =>
        this.resumeSession(sessionId, cwd),
    );
    ipcMain.handle("yukino:select-folder", () => this.selectFolder());
    ipcMain.handle(
      "yukino:respond-permission",
      (_event, id: string, response: PermissionResponse) => {
        this.respondPermission(id, response);
      },
    );
    ipcMain.handle(
      "yukino:respond-ask",
      (_event, id: string, answers: Record<string, string>) => {
        this.respondAsk(id, answers);
      },
    );
    ipcMain.handle("yukino:list-commands", () => this.listCommands());
    ipcMain.handle("yukino:run-command", (_event, input: string) =>
      this.runCommand(input),
    );
    ipcMain.handle(
      "yukino:save-provider",
      async (_event, input: ProviderInput) => {
        this.assertIdle();
        const config = Config.loadConfig(undefined, {
          allowEmptyProviders: true,
        });
        const saved = Config.ProviderLogin.saveProvider(
          input,
          config.providers,
        );
        this.providers = saved.providers;
        const index = saved.providers.findIndex(
          (provider) => provider.base_url === saved.provider.base_url,
        );
        Config.ProviderLogin.persistDefaultProvider(index);
        if (this.handle) {
          await this.setProvider(index);
        } else {
          await this.init();
        }
      },
    );
    ipcMain.handle("yukino:get-settings", () => this.getSettings());
    ipcMain.handle("yukino:list-models", () => this.listModels());
    ipcMain.handle("yukino:set-provider", (_event, index: number) =>
      this.setProvider(index),
    );
    ipcMain.handle("yukino:set-model", (_event, model: string) =>
      this.setModel(model),
    );
    ipcMain.handle("yukino:set-thinking-level", (_event, level: string) =>
      this.setThinkingLevel(level),
    );
    ipcMain.handle("yukino:get-theme", () => ({
      mode: this.getTheme(),
      dark: nativeTheme.shouldUseDarkColors,
    }));
    ipcMain.handle(
      "yukino:set-theme",
      (_event, mode: "system" | "light" | "dark") => {
        this.setTheme(mode);
      },
    );
  }

  async dispose(): Promise<void> {
    this.disposing = true;
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
    await this.handle?.dispose();
    this.handle = null;
  }
}
