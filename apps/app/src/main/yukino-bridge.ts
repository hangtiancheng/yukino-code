// Electron main-process bridge over the @yukino.js/yukino library entry.
//
// The library barrel (Remote.Server.createRemoteAgent) initializes the full
// agent stack — tools, LLM client, conversation, session, MCP, memory — and
// yields AgentEvents from handle.run(). This bridge adapts that generator
// into push events over IPC, and adapts the permission/ask callbacks into
// pending-promise exchanges with the renderer.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AskRequestPayload,
  BridgeEvent,
  CommandSummary,
  HistoryMessage,
  InitState,
  ModelListResult,
  PermissionRequestPayload,
  PermissionResponse,
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
} from "@yukino.js/yukino";
import { BrowserWindow, dialog, ipcMain, nativeTheme, app } from "electron";

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

/** Commands that only make sense in the terminal/WS UIs. */
const UNSUPPORTED_COMMANDS = new Set([
  "worktree",
  "rewind",
  "sandbox",
  "feedback",
  "quit",
]);

/** Max characters of a tool result forwarded to the renderer. */
const OUTPUT_PREVIEW_CHARS = 8000;

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
  private initPromise: Promise<RemoteAgentHandle | null> | null = null;
  private streaming = false;
  private cwd: string;
  private readonly state = new StateStore();
  /** All configured providers (merged with project MCP); drives settings. */
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
  private readonly followUps: string[] = [];

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
    try {
      const configPath = Config.ProviderConfig.globalConfigPath();
      let config: Config.AppConfig;
      try {
        config = Config.loadConfig();
      } catch (error) {
        return this.initError(
          error instanceof Error
            ? error.message
            : "Failed to load the yukino config.",
          configPath,
        );
      }
      if (config.providers.length === 0) {
        return this.initError(
          "No providers configured. Add one to your config file.",
          configPath,
        );
      }

      const merged = Config.withProjectMcpServers(config, this.cwd);
      this.providers = merged.providers;
      const provider = Config.ProviderConfig.resolveDefaultProvider(
        merged.providers,
        merged.default_provider,
      );

      this.initPromise = this.createHandle(provider, merged).then((handle) => {
        this.handle = handle;
        this.initPromise = null;
        return handle;
      });
      const handle = await this.initPromise;
      if (!handle) {
        return this.initError("Agent initialization failed.", configPath);
      }

      const okState = this.buildInitState(handle);
      emit({ type: "init_state", data: okState });
      return okState;
    } catch (error) {
      return this.initError(
        error instanceof Error ? error.message : String(error),
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

  private initError(message: string, configPath?: string): InitState {
    const failure: InitState = {
      ok: false,
      error: message,
      ...(configPath ? { configPath } : {}),
    };
    emit({ type: "init_state", data: failure });
    return failure;
  }

  private async createHandle(
    provider: ProviderConfig,
    config: Config.AppConfig,
  ): Promise<RemoteAgentHandle | null> {
    try {
      const options: CreateRemoteAgentOptions = {
        provider,
        cwd: this.cwd,
        enableCoordinatorMode: config.enable_coordinator_mode ?? false,
        forkDisabled: !Config.forkEnabled(config),
        memoryEnabled: Config.memoryEnabled(config),
        askUser: this.createAsker(),
        onSubagentEvent: (event) => {
          emit({ type: "subagent", data: event });
        },
      };
      if (config.hooks) {
        options.hooks = config.hooks;
      }
      if (config.mcp_servers) {
        options.mcpServers = config.mcp_servers;
      }
      if (config.lsp_servers) {
        options.lspServers = config.lsp_servers;
      }
      if (config.sandbox) {
        options.sandboxConfig = config.sandbox;
      }
      return await Remote.Server.createRemoteAgent(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "error",
        data: { message: `Agent init failed: ${message}` },
      });
      return null;
    }
  }

  private async ensureHandle(): Promise<RemoteAgentHandle | null> {
    if (this.handle) {
      return this.handle;
    }
    if (this.initPromise) {
      return this.initPromise;
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
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          return;
        }
        this.pendingAsks.set(id, (answers) => {
          signal?.removeEventListener("abort", cancel);
          emit({ type: "ask_resolved", data: { id } });
          resolve(answers);
        });
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
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          return;
        }
        this.pendingPermissions.set(id, (response) => {
          signal?.removeEventListener("abort", cancel);
          emit({ type: "permission_resolved", data: { id, response } });
          resolve(response);
        });
      });
    };
  }

  respondPermission(id: string, response: PermissionResponse): void {
    this.pendingPermissions.get(id)?.(response);
  }

  respondAsk(id: string, answers: Record<string, string>): void {
    this.pendingAsks.get(id)?.(answers);
  }

  // ---------- run loop ----------

  private setStreaming(value: boolean): void {
    if (this.streaming === value) {
      return;
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
    const parsed = Commands.Commands.parse(trimmed);
    if (parsed) {
      await this.runCommandInternal(handle, parsed.name, parsed.args);
      return;
    }

    await this.runLoop(handle, trimmed);
  }

  private async runLoop(
    handle: RemoteAgentHandle,
    text: string,
  ): Promise<void> {
    this.setStreaming(true);
    try {
      for await (const event of handle.run(text, {
        onPermissionRequest: this.createPermissionCallback(),
      })) {
        this.emitAgentEvent(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", data: { message } });
    } finally {
      this.setStreaming(false);
      const next = this.followUps.shift();
      if (next) {
        void this.runLoop(handle, next);
      }
    }
  }

  abort(): void {
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
        emit({
          type: "tool_result",
          data: {
            toolId: event.toolId,
            toolName: event.toolName,
            output:
              event.output.length > OUTPUT_PREVIEW_CHARS
                ? `${event.output.slice(0, OUTPUT_PREVIEW_CHARS)}\n… (truncated)`
                : event.output,
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
    await handle.clearConversation();
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
    let switchedCwd = false;
    if (cwd && Storage.projectKey(cwd) !== Storage.projectKey(this.cwd)) {
      await this.reinit(cwd);
      switchedCwd = true;
    }
    const handle = await this.ensureHandle();
    if (!handle) {
      return { sessionId, messages: [], cwd: this.cwd, switchedCwd };
    }
    const saved = Session.loadSession(handle.cwd, sessionId);
    const replay = Remote.SessionState.restoreRemoteSession(
      handle,
      sessionId,
      saved,
    );
    const messages: HistoryMessage[] = replay.map((message) => ({
      role: message.role,
      content: contentToText(message.content),
      timestamp: 0,
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
    const result = await dialog.showOpenDialog({
      title: "Choose a project folder",
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
    if (this.streaming) {
      this.abort();
    }
    if (this.handle) {
      await this.handle.dispose();
      this.handle = null;
    }
    this.cwd = cwd;
    this.state.write({ cwd });
    this.followUps.length = 0;
    await this.init();
  }

  // ---------- slash commands ----------

  /** Slash commands surfaced in the composer panel. */
  async listCommands(): Promise<CommandSummary[]> {
    const handle = await this.ensureHandle();
    const registry = handle?.cmdRegistry;
    if (!registry) {
      return [];
    }
    return registry
      .listCommands()
      .filter((cmd) => !UNSUPPORTED_COMMANDS.has(cmd.name))
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        type: cmd.type,
      }));
  }

  /** Executes a slash command; results stream back as BridgeEvents. */
  async runCommand(input: string): Promise<void> {
    const handle = await this.ensureHandle();
    if (!handle) {
      return;
    }
    const parsed = Commands.Commands.parse(input);
    if (!parsed) {
      return;
    }
    await this.runCommandInternal(handle, parsed.name, parsed.args);
  }

  private async runCommandInternal(
    handle: RemoteAgentHandle,
    name: string,
    args: string,
  ): Promise<void> {
    if (UNSUPPORTED_COMMANDS.has(name)) {
      emit({
        type: "system",
        data: { message: `/${name} is only supported in the terminal.` },
      });
      return;
    }
    const cmd = handle.cmdRegistry.find(name);
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
        this.runLocalCommand(handle, cmd, args);
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

  private runLocalCommand(
    handle: RemoteAgentHandle,
    cmd: Command,
    args: string,
  ): void {
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
        emit({
          type: "system",
          data: {
            message:
              "Provider settings live in the Settings dialog (gear icon).",
          },
        });
        return;

      case "model":
        if (args.trim()) {
          await this.setModelInternal(handle, args.trim());
          return;
        }
        emit({
          type: "system",
          data: {
            message: "Model settings live in the Settings dialog (gear icon).",
          },
        });
        return;

      case "resume":
        await this.runResume(handle, args.trim());
        return;

      case "skills": {
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
        await Commands.Subagent.runSubagentCommand(
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", data: { message } });
      } finally {
        this.commandController = null;
        this.setStreaming(false);
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
            undefined,
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
      emit({ type: "stream_text", data: { text: result } });
      emit({ type: "turn_complete" });
      emit({ type: "loop_complete", data: { stopReason: "end_turn" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "error",
        data: { message: `Skill fork error: ${message}` },
      });
    } finally {
      this.commandController = null;
      this.setStreaming(false);
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
      this.setStreaming(false);
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
    const handle = await this.ensureHandle();
    if (!handle) {
      return {
        providers: [],
        currentProvider: -1,
        model: "",
        thinkingLevel: DEFAULT_THINKING,
        thinkingLevels: [...Config.Constants.THINKING_LEVELS],
      };
    }
    return {
      providers: this.providers.map((provider) => ({
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.base_url,
        model: provider.model,
      })),
      currentProvider: Math.max(
        0,
        this.providers.findIndex(
          (provider) => provider.base_url === handle.provider.base_url,
        ),
      ),
      model: handle.provider.model,
      thinkingLevel: this.currentThinkingLevel(handle),
      thinkingLevels: this.supportedThinkingLevels(handle),
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
    const handle = await this.ensureHandle();
    if (!handle) {
      return;
    }
    if (this.streaming) {
      emit({
        type: "system",
        data: {
          message: "Cannot change the model while a run is in progress.",
        },
      });
      return;
    }
    await this.setModelInternal(handle, model.trim());
  }

  private async setModelInternal(
    handle: RemoteAgentHandle,
    model: string,
  ): Promise<void> {
    if (!model) {
      return;
    }
    if (model === handle.provider.model) {
      emit({
        type: "system",
        data: { message: `Model already set to ${model}.` },
      });
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
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({
          type: "error",
          data: { message: `Failed to switch model: ${message}` },
        });
        return;
      }
      // A save failure must not undo the runtime switch.
      let saved = true;
      try {
        Config.ProviderLogin.persistModel(updated.base_url, updated.model);
      } catch {
        saved = false;
      }
      this.broadcastUpdatedState(handle);
      emit({
        type: "system",
        data: {
          message: `Model set to ${updated.model}${saved ? " and saved" : " for this session"}.`,
        },
      });
    } finally {
      this.setStreaming(false);
    }
  }

  /** Persists the default provider and rebuilds the LLM client. */
  async setProvider(index: number): Promise<void> {
    const provider = this.providers[index];
    if (!provider) {
      emit({
        type: "error",
        data: { message: `Unknown provider index: ${String(index)}` },
      });
      return;
    }
    const handle = await this.ensureHandle();
    if (!handle) {
      return;
    }
    if (this.streaming) {
      emit({
        type: "system",
        data: {
          message: "Cannot switch providers while a run is in progress.",
        },
      });
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
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({
          type: "error",
          data: { message: `Failed to switch provider: ${message}` },
        });
        return;
      }
      // A save failure must not undo the runtime switch.
      let saved = true;
      try {
        Config.ProviderLogin.persistDefaultProvider(index);
      } catch {
        saved = false;
      }
      this.broadcastUpdatedState(handle);
      emit({
        type: "system",
        data: {
          message: `Provider switched to ${provider.name} · ${provider.model}.${saved ? "" : " Default provider could not be saved."}`,
        },
      });
    } finally {
      this.setStreaming(false);
    }
  }

  async setThinkingLevel(level: string): Promise<void> {
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
      emit({
        type: "error",
        data: { message: `Failed to set thinking level: ${message}` },
      });
      return;
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
    emit({
      type: "system",
      data: { message: `Thinking level set to ${effective}.` },
    });
  }

  /** Re-emits init_state so the header badge/model stays in sync. */
  private broadcastUpdatedState(handle: RemoteAgentHandle): void {
    emit({ type: "init_state", data: this.buildInitState(handle) });
  }

  // ---------- ipc ----------

  registerIpc(): void {
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
    await this.handle?.dispose();
    this.handle = null;
  }
}
