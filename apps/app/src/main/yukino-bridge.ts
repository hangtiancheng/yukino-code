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

import { BrowserWindow, dialog, ipcMain, nativeTheme, app } from "electron";
import * as Yukino from "@yukino.js/yukino";

import type {
  AskRequestPayload,
  BridgeEvent,
  HistoryMessage,
  InitState,
  PermissionRequestPayload,
  PermissionResponse,
  ResumeResult,
  SessionSummary,
  UsagePayload,
} from "@shared/ipc-types";

type RemoteAgentHandle = Yukino.Remote.Server.RemoteAgentHandle;
type CreateRemoteAgentOptions = Yukino.Remote.Server.CreateRemoteAgentOptions;
type AgentEvent = Yukino.Agent.Events.AgentEvent;
type Decision = Yukino.Permissions.Decision;
type AskUserQuestion = Yukino.Tools.AskUser.Question;
type ProviderConfig = Yukino.Config.ProviderConfig.ProviderConfig;

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
      if (!existsSync(this.path)) return {};
      return JSON.parse(readFileSync(this.path, "utf-8")) as PersistedState;
    } catch {
      return {};
    }
  }

  write(patch: PersistedState): void {
    try {
      const dir = app.getPath("userData");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
    nativeTheme.on("updated", () => this.broadcastTheme());
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
      const configPath = Yukino.Config.ProviderConfig.globalConfigPath();
      let config: Yukino.Config.AppConfig;
      try {
        config = Yukino.Config.loadConfig();
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

      const merged = Yukino.Config.withProjectMcpServers(config, this.cwd);
      const provider = Yukino.Config.ProviderConfig.resolveDefaultProvider(
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

      const okState: InitState = {
        ok: true,
        cwd: this.cwd,
        providerName: provider.name,
        model: provider.model,
        sessionId: handle.sessionId,
        permissionMode: handle.permissionMode,
        contextWindow: handle.contextWindow,
      };
      emit({ type: "init_state", data: okState });
      return okState;
    } catch (error) {
      return this.initError(
        error instanceof Error ? error.message : String(error),
      );
    }
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
    config: Yukino.Config.AppConfig,
  ): Promise<RemoteAgentHandle | null> {
    try {
      const options: CreateRemoteAgentOptions = {
        provider,
        cwd: this.cwd,
        enableCoordinatorMode: config.enable_coordinator_mode ?? false,
        forkDisabled: !Yukino.Config.forkEnabled(config),
        memoryEnabled: Yukino.Config.memoryEnabled(config),
        askUser: this.createAsker(),
        onSubagentEvent: (event) => {
          emit({ type: "subagent", data: event });
        },
      };
      if (config.hooks) options.hooks = config.hooks;
      if (config.mcp_servers) options.mcpServers = config.mcp_servers;
      if (config.lsp_servers) options.lspServers = config.lsp_servers;
      if (config.sandbox) options.sandboxConfig = config.sandbox;
      return await Yukino.Remote.Server.createRemoteAgent(options);
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
    if (this.handle) return this.handle;
    if (this.initPromise) return this.initPromise;
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
    if (this.streaming === value) return;
    this.streaming = value;
    emit({ type: "run_state", data: { streaming: value } });
  }

  /** Sends a user message, or steers/queues it when a run is active. */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const handle = await this.ensureHandle();
    if (!handle) return;

    if (this.streaming) {
      if (handle.steer(trimmed)) return;
      this.followUps.push(trimmed);
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
    if (!handle) return { sessionId: "" };
    await handle.clearConversation();
    emit({
      type: "session_changed",
      data: { sessionId: handle.sessionId, cwd: this.cwd },
    });
    return { sessionId: handle.sessionId };
  }

  listSessions(): SessionSummary[] {
    try {
      return Yukino.Session.listSessions(this.cwd).map((session) => ({
        id: session.id,
        firstMessage: session.firstMessage,
        messageCount: session.messageCount,
        modTime: session.modTime.getTime(),
      }));
    } catch {
      return [];
    }
  }

  async resumeSession(sessionId: string): Promise<ResumeResult> {
    const handle = await this.ensureHandle();
    if (!handle) return { sessionId, messages: [] };
    const saved = Yukino.Session.loadSession(this.cwd, sessionId);
    const replay = Yukino.Remote.SessionState.restoreRemoteSession(
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
    return { sessionId: handle.sessionId, messages };
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
    if (this.streaming) this.abort();
    if (this.handle) {
      await this.handle.dispose();
      this.handle = null;
    }
    this.cwd = cwd;
    this.state.write({ cwd });
    this.followUps.length = 0;
    await this.init();
  }

  // ---------- ipc ----------

  registerIpc(): void {
    ipcMain.handle("yukino:init", () => this.init());
    ipcMain.handle("yukino:send", (_event, text: string) => this.send(text));
    ipcMain.handle("yukino:abort", () => this.abort());
    ipcMain.handle("yukino:new-session", () => this.newSession());
    ipcMain.handle("yukino:list-sessions", () => this.listSessions());
    ipcMain.handle("yukino:resume-session", (_event, sessionId: string) =>
      this.resumeSession(sessionId),
    );
    ipcMain.handle("yukino:select-folder", () => this.selectFolder());
    ipcMain.handle(
      "yukino:respond-permission",
      (_event, id: string, response: PermissionResponse) =>
        this.respondPermission(id, response),
    );
    ipcMain.handle(
      "yukino:respond-ask",
      (_event, id: string, answers: Record<string, string>) =>
        this.respondAsk(id, answers),
    );
    ipcMain.handle("yukino:get-theme", () => ({
      mode: this.getTheme(),
      dark: nativeTheme.shouldUseDarkColors,
    }));
    ipcMain.handle(
      "yukino:set-theme",
      (_event, mode: "system" | "light" | "dark") => this.setTheme(mode),
    );
  }

  async dispose(): Promise<void> {
    await this.handle?.dispose();
    this.handle = null;
  }
}
