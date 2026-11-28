// Remote server: Express HTTP + WebSocket bridge for browser-based access.
// Serves the React browser bundle (browser/dist/) and bridges Agent events to WS.

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";

import { execa } from "execa";
import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import type z from "zod";

import type { AgentEvent } from "@/agent/events.js";
import { resolveInvocationProvider } from "@/bootstrap/invocation.js";
import { countMcpTools } from "@/bootstrap/tool-registry.js";
import type { InvocationOptions } from "@/cli.js";
import {
  parse as parseCommand,
  resolve as resolveCommand,
  createDefaultRegistry as createCommandRegistry,
  type CommandContext,
} from "@/commands/commands.js";
import { runSubagentCommand } from "@/commands/subagent.js";
import { currentContextTokens, forceCompact } from "@/compact/compact.js";
import { DEFAULT_THINKING_LEVEL } from "@/config/constants.js";
import { loadConfig } from "@/config/index.js";
import type { AppConfig } from "@/config/index.js";
import type { SandboxYamlConfig } from "@/config/index.js";
import type { HookConfig } from "@/config/index.js";
import {
  PreferencesPatchSchema,
  mergePreferences,
  type PreferencesPatch,
} from "@/config/preferences.js";
import type { CodeModeConfig } from "@/config/preferences.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import {
  getSupportedThinkingLevels,
  resolveDefaultProvider,
} from "@/config/provider-config.js";
import {
  persistDefaultProvider,
  persistModel,
  persistThinkingLevel,
  saveProvider,
} from "@/config/provider-login.js";
import { expandAtRefsWithImages } from "@/conversation/at-expand.js";
import type { UserBashResult } from "@/conversation/index.js";
import { userBashContext } from "@/conversation/prompts.js";
import {
  executeUserBash,
  parseUserBashCommand,
} from "@/conversation/user-bash.js";
import { fileHistoryDir } from "@/file-history/index.js";
import type { Snapshot } from "@/file-history/index.js";
import { handleGoalCommand } from "@/goal/index.js";
import * as historyMod from "@/history/index.js";
import { sniffMediaType } from "@/images/index.js";
import { createClient } from "@/llm/client.js";
import { discoverModels } from "@/llm/model-discovery.js";
import { createChildLogger } from "@/logger/index.js";
import { McpAppToolResultSchema } from "@/mcp/apps.js";
import { executeMCPCommand, formatMCPStatus } from "@/mcp/commands.js";
import type { MCPServerConfig } from "@/mcp/config.js";
import { MCPManagement } from "@/mcp/management.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { type Decision, type PermissionMode } from "@/permissions/index.js";
import { getOrCreatePlanPath, planExists } from "@/plan-file/index.js";
import type { AuthorizedProject } from "@/project/types.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import {
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
} from "@/prompt/plan-mode.js";
import { buildPlanExecutionPrompt } from "@/prompt/prompts.js";
import { parseRemoteAddress } from "@/remote/address.js";
import {
  BROWSER_DIST,
  MCP_APP_AGENT_DISCONNECTED,
  FILE_CACHE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  INPUT_HISTORY_LIMIT,
  MAX_UPLOAD_IMAGE_BYTES,
  PENDING_REQUEST_TIMEOUT_MINUTES,
  PENDING_REQUEST_TIMEOUT_MS,
  SESSION_LIST_LIMIT,
  SHUTDOWN_GRACE_MS,
  TEAMMATE_POLL_INTERVAL_MS,
  WAKEUP_POLL_INTERVAL_MS,
} from "@/remote/constants.js";
import { AgentEventLogger } from "@/remote/log.js";
import { RemoteMcpApps } from "@/remote/mcp-apps.js";
import { ClientMessageSchema, type ServerMessage } from "@/remote/protocol.js";
import type { ProviderSaveSchema } from "@/remote/protocol.js";
import {
  createRuntimeEnvironment,
  type RuntimeEnvironment,
} from "@/remote/runtime-environment.js";
import {
  authorizeWebSocketRequest,
  createWebSocketAccessToken,
  rejectWebSocketUpgrade,
} from "@/remote/websocket-security.js";
import { composeAgentToolFilter } from "@/runtime/agent-runtime.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import { applyRuntimePreferences } from "@/runtime/preferences.js";
import { reloadRuntimeResources } from "@/runtime/resources.js";
import { captureSessionRuntimeState } from "@/runtime/session-state.js";
import {
  controlRuntimeWarming,
  formatRuntimeStatus,
} from "@/runtime/status.js";
import type {
  AgentRuntime,
  RuntimeSubagentEvent,
  RunCallbacks,
} from "@/runtime/types.js";
import { createSandbox, type Sandbox } from "@/sandbox/index.js";
import {
  navigateSessionTree,
  parseSessionTreeCommand,
  updateSessionTreeOptions,
  type SessionTreeOptions,
  requestProjectTrust,
  sessionTransferCommand,
  sessionTreeRows,
} from "@/session/actions.js";
import {
  saveMessage,
  saveCompactBoundary,
  listSessions,
  listAllSessions,
  getSessionFilePath,
  rebuildFromSession,
} from "@/session/index.js";
import { sessionMaintenanceCommand } from "@/session/maintenance-command.js";
import { SessionManager } from "@/session/manager.js";
import { filterSessions } from "@/session/organization.js";
import {
  parseSessionResumeCommand,
  requestSessionRestoration,
} from "@/session/resume.js";
import { runFork as runSkillFork } from "@/skills/executor.js";
import type { SkillForkHost } from "@/skills/types.js";
import { mkdirPrivateSync, writePrivateFile } from "@/storage/private.js";
import { PLAN_AGENT_NAME } from "@/subagent/constants.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { subscribeLeaderTasks } from "@/teams/task-tools.js";
import type { Question, Asker } from "@/tools/ask-user.js";
import { BashTool } from "@/tools/bash.js";
import {
  backgroundAllForegroundTasks,
  hasAnyForegroundTasks,
} from "@/tools/shell-background.js";
import type { ToolContext, ToolResult } from "@/tools/types.js";
import { filterFileMatches, scanCwdFiles } from "@/utils/file-scan.js";
import {
  asErrorString,
  contentToText,
  plainTerminalText,
  strArg,
} from "@/utils/index.js";
import { canonicalPath } from "@/utils/paths.js";
import { getWorkflowService } from "@/workflow/wiring.js";

const log = createChildLogger({ module: "remote" });

// Monotonic request-id counter: Date.now() alone collides when two requests
// land in the same millisecond (e.g. concurrent subagents), which would
// overwrite the first request's resolver and hang its run forever.
let requestCounter = 0;
function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${String(requestCounter)}`;
}

type WsOutbound = ServerMessage;

/** Formats a permission request description for the WS client permission dialog. */
function formatPermissionDesc(
  args: Record<string, unknown>,
  decision: Decision,
): string {
  const parts: string[] = [];
  if (decision.reason) {
    parts.push(decision.reason);
  }
  if (args.command) {
    parts.push(`Command: ${strArg(args, "command")}`);
  } else if (args.file_path) {
    parts.push(`File: ${strArg(args, "file_path")}`);
  }
  return parts.join("\n");
}

interface RemoteServerOptions {
  config?: AppConfig;
  codeMode?: CodeModeConfig;
  sandboxConfig?: SandboxYamlConfig;
  providers: ProviderConfig[];
  /** Index of the provider the server starts with; defaults to 0. */
  defaultProvider?: number;
  mcpServers?: MCPServerConfig[];
  hookConfigs?: HookConfig[];
  addr: string;
  enableCoordinatorMode: boolean;
  /** Auto memory switch from config.yaml (`enable_memory:`); defaults to true. */
  memoryEnabled?: boolean;
  /** Agent constructor used for eager and lazy initialization. */
  agentFactory?: typeof createAgentRuntime;
  invocationOptions?: InvocationOptions;
}

export class RemoteServer {
  private readonly mcpApps = new RemoteMcpApps();
  private app: Express;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private opts: RemoteServerOptions;

  private agentHandle: AgentRuntime | null = null;
  private environment: RuntimeEnvironment | null = null;
  private authorizedProject?: AuthorizedProject;
  private invocationProviderConsumed = false;
  private preferenceOverrides: PreferencesPatch = {};
  private mcpManagement: MCPManagement | null = null;
  private mcpManagementRuntime: AgentRuntime | null = null;
  private mcpController: AbortController | null = null;
  private initializationController = new AbortController();
  private treeController: AbortController | null = null;
  private treeOptions: SessionTreeOptions = {};
  private replacingEnvironment = false;
  private agentInitPromise: Promise<AgentRuntime | null> | null = null;
  private isStreaming = false;
  private stopping = false;
  private get streaming(): boolean {
    return this.isStreaming;
  }
  private set streaming(value: boolean) {
    if (this.isStreaming === value) {
      return;
    }
    this.isStreaming = value;
    this.broadcast({ type: "run_state", data: { streaming: value } });
  }
  private compactController: AbortController | null = null;
  private turnCount = 0;
  private readonly eventLogger = new AgentEventLogger(log);
  /** Resolves run() once stop() has completed; run() blocks on it. */
  private stoppedResolve: (() => void) | null = null;
  /** Last pong timestamp per client; drives the heartbeat sweep. */
  private lastPongAt = new Map<WebSocket, number>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly accessToken = createWebSocketAccessToken();

  // Plan-mode state (parity with the terminal UI approval flow).
  private hasExitedPlanMode = false;
  private exitPlanSucceeded = false;
  /** Set by cancelActiveRun so steering leftovers are dropped, not re-run. */
  private runCanceled = false;
  /** Whether a plan approval request is awaiting a client response. */
  private planApprovalId: string | null = null;
  private planApprovalTimer: NodeJS.Timeout | null = null;
  private pendingPlanExecution: string | null = null;

  private pendingPermissions = new Map<
    string,
    (response: "allow" | "deny" | "allowAlways") => void
  >();
  private pendingAsks = new Map<
    string,
    (answers: Record<string, string>) => void
  >();
  // Replayable payloads for the pending requests above, so a client that
  // connects (F5, new tab, reconnect) after a request was broadcast still sees
  // it instead of the tool hanging with no visible prompt.
  private pendingPermissionPayloads = new Map<
    string,
    {
      id: string;
      toolName: string;
      description: string;
      rememberPatterns?: string[];
    }
  >();
  private pendingAskPayloads = new Map<
    string,
    { id: string; questions: Question[] }
  >();

  // Messages sent while a turn is busy but steering is unavailable (slash
  // commands, pre-run window): queued and replayed once the slot frees up.
  private followUps: { text: string; input?: historyMod.InputEntry }[] = [];
  private userBashController: AbortController | null = null;
  private subagentController: AbortController | null = null;
  private modelListController: AbortController | null = null;
  /** Lazily created OS sandbox for /sandbox toggling (terminal parity). */
  private sandbox: Promise<Sandbox | null> | null = null;
  /** Live subagent/fork activity keyed by toolCallId (browser Agents view). */
  private subagentStates = new Map<
    string,
    {
      toolCallId: string;
      role: string;
      background: boolean;
      turnCount: number;
      activeTools: { toolId: string; toolName: string }[];
      status: "running" | "completed" | "failed" | "stopped";
    }
  >();
  private activityAttached = false;
  private teammateSignature = "";
  private teammateTimer: NodeJS.Timeout | null = null;
  private wakeupTimer: NodeJS.Timeout | null = null;
  private fileCache: {
    key: string;
    files: string[];
    scannedAt: number;
  } | null = null;
  /** Last usage snapshot; feeds /status between runs. */
  private lastUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(opts: RemoteServerOptions) {
    this.opts = opts;
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
    this.setupRoutes();
    this.setupWebSocketUpgrade();
    this.setupWebSocket();
  }

  private setupWebSocketUpgrade(): void {
    this.server.on("upgrade", (request, socket, head) => {
      const authorization = authorizeWebSocketRequest(
        request,
        "/ws",
        this.accessToken,
      );
      if (!authorization.allowed) {
        rejectWebSocketUpgrade(socket, authorization);
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });
  }

  /** Configures Express routes: static file serving + health check. */
  private setupRoutes(): void {
    this.app.all("/health", (_req, res) => {
      res.json({ status: "ok", remote: true, clients: this.clients.size });
    });

    this.app.get("/auth", (req, res) => {
      const authorization = authorizeWebSocketRequest(
        req,
        "/auth",
        this.accessToken,
      );
      res.setHeader("Cache-Control", "no-store");
      res.sendStatus(authorization.allowed ? 204 : authorization.status);
    });

    if (BROWSER_DIST) {
      this.app.use(express.static(BROWSER_DIST, { dotfiles: "deny" }));
      this.app.get(/.*/, (_req, res, next) => {
        res.sendFile(
          "index.html",
          { root: BROWSER_DIST, dotfiles: "deny" },
          (error) => {
            if (error) {
              next(error);
            }
          },
        );
      });
    }
    this.app.use((_req, res) => {
      res.status(404).send("Not found");
    });
  }

  /** Configures WebSocket connection handling. */
  private setupWebSocket(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      this.lastPongAt.set(ws, Date.now());

      // Send initial connected message to the newly connected client only.
      // Deferred until the agent exists so the session id is never empty;
      // ensureAgent() broadcasts it once initialization completes.
      if (this.agentHandle) {
        this.send(ws, {
          type: "connected",
          data: {
            session: this.agentHandle.sessionId,
            cwd:
              this.agentHandle?.cwd ??
              canonicalPath(this.opts.invocationOptions?.cwd ?? cwd()),
            streaming: this.streaming,
          },
        });
        const status = this.statusPayload();
        if (status) {
          this.send(ws, status);
          if (this.agentHandle) {
            this.send(ws, {
              type: "runtime_status",
              data: this.agentHandle.getStatus(),
            });
          }
        }
      }

      this.send(ws, { type: "commands", data: this.buildCommandList() });
      this.send(ws, {
        type: "history",
        data: {
          entries: historyMod.loadInputTexts().slice(-INPUT_HISTORY_LIMIT),
        },
      });
      this.sendUsageSnapshot(ws);
      for (const payload of this.mcpApps.entries()) {
        this.send(ws, { type: "tool_result", data: payload });
      }
      if (this.opts.providers.length === 0) {
        this.send(ws, {
          type: "provider_list",
          data: { providers: [], current: 0 },
        });
      }
      if (this.planApprovalId) {
        this.sendPlanApprovalRequest(ws);
      }
      // Replay in-flight permission/ask requests so this client sees the same
      // pending prompts (no tool restart, no timeout reset).
      for (const permPayload of this.pendingPermissionPayloads.values()) {
        this.send(ws, { type: "permission_request", data: permPayload });
      }
      for (const askPayload of this.pendingAskPayloads.values()) {
        this.send(ws, { type: "ask_user", data: askPayload });
      }

      ws.on("message", (data: Buffer) => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString("utf-8"));
        } catch {
          log.warn("received non-JSON WebSocket message");
          return;
        }
        const parsed = ClientMessageSchema.safeParse(raw);
        if (!parsed.success) {
          log.warn("received malformed WS message");
          return;
        }
        void this.handleWsMessage(ws, parsed.data);
      });

      ws.on("pong", () => {
        this.lastPongAt.set(ws, Date.now());
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        this.lastPongAt.delete(ws);
      });

      ws.on("error", () => {
        this.clients.delete(ws);
        this.lastPongAt.delete(ws);
      });
      if (!this.agentHandle && this.opts.providers.length) {
        void this.ensureAgent();
      }
    });
  }

  /**
   * Ping/sweep loop for half-open connections: a browser tab killed without a
   * close frame stays in the clients set forever without this, receiving
   * broadcasts into a dead socket.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const ws of [...this.clients]) {
        const last = this.lastPongAt.get(ws) ?? now;
        if (now - last > HEARTBEAT_STALE_MS) {
          ws.terminate();
          this.clients.delete(ws);
          this.lastPongAt.delete(ws);
          continue;
        }
        try {
          ws.ping();
        } catch {
          // Dead socket: the sweep will remove it.
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  /** Handles incoming WebSocket messages from the Web UI. */
  private async handleWsMessage(
    ws: WebSocket,
    msg: z.infer<typeof ClientMessageSchema>,
  ): Promise<void> {
    try {
      switch (msg.type) {
        case "mcp_app_request": {
          const controller = new AbortController();
          const close = () => {
            controller.abort();
          };
          ws.once("close", close);
          try {
            if (!this.agentHandle) {
              throw new Error(MCP_APP_AGENT_DISCONNECTED);
            }
            const result = await this.mcpApps.request(
              msg.data,
              this.agentHandle,
              this.createPermissionCallback(),
              AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(PENDING_REQUEST_TIMEOUT_MS),
              ]),
            );
            this.send(ws, {
              type: "mcp_app_response",
              data: { requestId: msg.data.requestId, result },
            });
          } catch (error) {
            this.send(ws, {
              type: "mcp_app_response",
              data: {
                requestId: msg.data.requestId,
                error: asErrorString(error),
              },
            });
          } finally {
            ws.off("close", close);
          }
          break;
        }
        case "user_message": {
          if (this.streaming) {
            this.handleSteeringMessage(msg.data.content);
          } else {
            await this.handleUserMessage(msg.data.content);
          }

          break;
        }
        case "plan_approval_response": {
          await this.handlePlanApprovalResponse(
            msg.data.id,
            msg.data.choice,
            msg.data.feedback,
          );

          break;
        }
        case "permission_response": {
          const id = msg.data.id;
          const resolver = this.pendingPermissions.get(id);
          // Atomic claim: only the first responder (vs a duplicate answer or
          // a racing timeout/cancel) completes the request exactly once.
          if (this.pendingPermissions.delete(id) && resolver) {
            const response =
              msg.data.response === "allowAlways" &&
              !this.pendingPermissionPayloads.get(id)?.rememberPatterns?.length
                ? "allow"
                : msg.data.response;
            resolver(response);
            this.broadcast({
              type: "request_expired",
              data: {
                id,
                kind: "permission",
                response,
              },
            });
          }

          break;
        }
        case "ask_user_response": {
          const id = msg.data.id;
          const resolver = this.pendingAsks.get(id);
          if (this.pendingAsks.delete(id) && resolver) {
            resolver(msg.data.answers);
            this.broadcast({
              type: "request_expired",
              data: { id, kind: "ask" },
            });
          }

          break;
        }
        case "cancel": {
          this.cancelActiveRun();
          break;
        }
        case "ping": {
          // Reply to the sender only: pong is a keepalive, not a broadcast.
          this.send(ws, { type: "pong", data: null });
          break;
        }
        case "set_permission_mode": {
          this.applyPermissionMode(msg.data.mode);

          break;
        }
        case "model_list_request": {
          await this.broadcastModelList();
          break;
        }
        case "model_select": {
          await this.changeProviderConfiguration(() =>
            this.applyModel(msg.data.model),
          );

          break;
        }
        case "provider_list_request": {
          this.broadcastProviderList();
          break;
        }
        case "provider_select": {
          await this.changeProviderConfiguration(() =>
            this.applyProviderSwitch(msg.data.index),
          );

          break;
        }
        case "provider_save": {
          await this.changeProviderConfiguration(() =>
            this.handleProviderSave(msg.data),
          );

          break;
        }
        case "rewind_list_request": {
          this.broadcastRewindList();
          break;
        }
        case "rewind_action": {
          void this.handleRewindAction(
            msg.data.snapshotId,
            msg.data.action,
          ).catch((error: unknown) => {
            this.broadcast({
              type: "error",
              data: { message: asErrorString(error) },
            });
          });

          break;
        }
        case "file_complete_request": {
          this.sendFileCompletions(ws, msg.data.requestId, msg.data.query);

          break;
        }
        case "image_upload": {
          await this.handleImageUpload(msg.data, (message) => {
            this.send(ws, message);
          });

          break;
        }
        case "background_shells": {
          this.backgroundForegroundShells();
          break;
        }
        default:
          break;
      }
    } catch (err) {
      // A throwing handler must not become an unhandled rejection (or escalate
      // to process.exit). Log a safe diagnostic and return a controlled error so
      // the server keeps serving the next message. Run owners release their
      // own streaming slot; an unrelated failing request cannot release it.
      log.error({ err, type: msg.type }, "remote WS message handling failed");
      this.send(ws, {
        type: "system",
        data: { message: `Request failed: ${asErrorString(err)}` },
      });
    }
  }

  /**
   * The provider the server runs with: the `default_provider` entry, falling
   * back to the first one when the recorded index is out of range.
   */
  private startProvider(): ProviderConfig {
    return resolveDefaultProvider(
      this.opts.providers,
      this.opts.defaultProvider ?? 0,
    );
  }

  /**
   * Returns the agent handle, initializing it on first use. On success the
   * real session id is broadcast so clients can show the welcome card.
   */
  private async ensureAgent(): Promise<AgentRuntime | null> {
    if (this.agentHandle) {
      return this.agentHandle;
    }
    if (this.agentInitPromise) {
      return this.agentInitPromise;
    }

    const factory = this.opts.agentFactory ?? createAgentRuntime;
    const initPromise = (async (): Promise<AgentRuntime | null> => {
      try {
        const manager =
          this.environment?.manager ??
          SessionManager.create(
            canonicalPath(this.opts.invocationOptions?.cwd ?? cwd()),
            { persist: this.opts.invocationOptions?.persist },
          );
        const environment = await this.buildEnvironment(manager, factory);
        if (this.stopping) {
          await Promise.allSettled([
            environment.runtime.dispose(),
            environment.project.dispose(),
          ]);
          return null;
        }
        this.environment = environment;
        if (environment.project.trusted) {
          this.authorizedProject = {
            identity: environment.project.identity,
            fingerprint: environment.project.fingerprint,
          };
        }
        this.invocationProviderConsumed = true;
        const handle = environment.runtime;
        this.agentHandle = handle;
        this.attachActivityBridge(handle);
        if (environment.errors.length) {
          this.broadcast({
            type: "system",
            data: {
              message: `MCP errors: ${environment.errors.map((error) => `${error.serverName}: ${error.error}`).join("; ")}`,
            },
          });
        }
        if (environment.droppedDeclarations.length) {
          this.broadcast({
            type: "system",
            data: {
              message: `Unavailable historical tool declarations: ${environment.droppedDeclarations.join(", ")}`,
            },
          });
        }
        this.broadcast({
          type: "connected",
          data: {
            session: handle.sessionId,
            cwd:
              this.agentHandle?.cwd ??
              canonicalPath(this.opts.invocationOptions?.cwd ?? cwd()),
            streaming: this.streaming,
          },
        });
        this.broadcastStatus();
        this.broadcast({ type: "commands", data: this.buildCommandList() });
        this.broadcast({ type: "usage", data: this.usagePayload() });
        return handle;
      } catch (err) {
        log.error({ err }, "failed to initialize agent");
        this.broadcast({
          type: "error",
          data: {
            message: `Failed to initialize agent: ${asErrorString(err)}`,
          },
        });
        return null;
      }
    })();
    this.agentInitPromise = initPromise;

    try {
      return await initPromise;
    } finally {
      if (this.agentInitPromise === initPromise) {
        this.agentInitPromise = null;
      }
    }
  }

  private persistRuntimeState(): void {
    const environment = this.environment;
    if (!environment) {
      return;
    }
    environment.manager.refresh();
    const state = captureSessionRuntimeState(
      environment.runtime,
      environment.project,
    );
    if (
      JSON.stringify(environment.manager.getRuntimeState()) !==
      JSON.stringify(state)
    ) {
      environment.manager.appendRuntimeState(state);
    }
  }

  private async buildEnvironment(
    manager: SessionManager,
    factory = this.opts.agentFactory ?? createAgentRuntime,
    reload = false,
    signal = this.initializationController.signal,
  ): Promise<RuntimeEnvironment> {
    const global = reload
      ? loadConfig(this.opts.invocationOptions?.config)
      : (this.opts.config ?? {
          providers: this.opts.providers,
          default_provider: this.opts.defaultProvider ?? 0,
          hooks: this.opts.hookConfigs ?? [],
          mcp_servers: this.opts.mcpServers ?? [],
          sandbox: this.opts.sandboxConfig,
          code_mode: this.opts.codeMode,
          enable_memory: this.opts.memoryEnabled ?? true,
          enable_coordinator_mode: this.opts.enableCoordinatorMode,
        });
    const askUser = this.createAskUserCallback();
    const environment = await createRuntimeEnvironment(global, manager, {
      factory,
      signal,
      authorizedProject: this.authorizedProject,
      overrides: this.preferenceOverrides,
      invocationOptions: {
        ...this.opts.invocationOptions,
        ...(this.invocationProviderConsumed
          ? {
              provider: undefined,
              model: undefined,
              thinking: undefined,
              trustProject: undefined,
            }
          : {}),
      },
      enableCoordinatorMode: this.opts.enableCoordinatorMode,
      enableModelPlanMode: true,
      askUser,
      onTrustRequest: this.clients.size
        ? (request) =>
            requestProjectTrust(
              (questions) => askUser(questions, signal),
              request,
            )
        : undefined,
      onSubagentEvent: (event) => {
        this.handleSubagentEvent(event);
      },
    });
    return environment;
  }

  private clearSessionInteractions(): void {
    this.treeOptions = {};
    this.mcpController?.abort();
    this.mcpManagement = null;
    this.mcpManagementRuntime = null;
    this.mcpApps.clear();
    this.followUps = [];
    this.pendingPlanExecution = null;
    this.closePlanApproval();
    for (const resolve of this.pendingPermissions.values()) {
      resolve("deny");
    }
    for (const resolve of this.pendingAsks.values()) {
      resolve({});
    }
    this.pendingPermissions.clear();
    this.pendingAsks.clear();
    this.pendingPermissionPayloads.clear();
    this.pendingAskPayloads.clear();
  }

  private async replaceEnvironment(
    manager: SessionManager,
    reload = false,
    signal = this.initializationController.signal,
  ): Promise<void> {
    if (this.replacingEnvironment) {
      throw new Error("Session replacement is already in progress");
    }
    this.replacingEnvironment = true;
    const previous = this.environment;
    const runtime = this.agentHandle;
    let candidate: RuntimeEnvironment | undefined;
    try {
      this.mcpController?.abort();
      runtime?.abort();
      signal.throwIfAborted();
      candidate = await this.buildEnvironment(
        manager,
        undefined,
        reload,
        signal,
      );
      signal.throwIfAborted();
      this.clearSessionInteractions();
      const cleanup = await Promise.allSettled([
        previous?.project.dispose(),
        runtime?.dispose(),
      ]);
      this.agentHandle = null;
      this.environment = null;
      if (cleanup.some((result) => result.status === "rejected")) {
        throw new Error("Previous runtime cleanup failed");
      }
      signal.throwIfAborted();
      this.environment = candidate;
      this.agentHandle = candidate.runtime;
      if (candidate.project.trusted) {
        this.authorizedProject = {
          identity: candidate.project.identity,
          fingerprint: candidate.project.fingerprint,
        };
      }
      this.invocationProviderConsumed = true;
      this.attachActivityBridge(candidate.runtime);
      this.broadcast({
        type: "connected",
        data: {
          session: manager.id,
          cwd: manager.cwd,
          streaming: this.streaming,
        },
      });
      this.broadcast({ type: "clear", data: null });
      for (const message of manager.getMessages()) {
        this.broadcast({
          type: message.role === "user" ? "replay_user" : "replay_assistant",
          data: { content: contentToText(message.content) },
        });
      }
      if (candidate.droppedDeclarations.length) {
        this.broadcast({
          type: "system",
          data: {
            message: `Unavailable historical tool declarations: ${candidate.droppedDeclarations.join(", ")}`,
          },
        });
      }
      this.broadcastStatus();
      this.broadcast({ type: "commands", data: this.buildCommandList() });
    } catch (error) {
      if (candidate && this.environment !== candidate) {
        await Promise.allSettled([
          candidate.project.dispose(),
          candidate.runtime.dispose(),
        ]);
      }
      throw error;
    } finally {
      this.replacingEnvironment = false;
    }
  }

  /** Handles a user message: creates agent (if needed) and streams events. */
  private async handleUserMessage(
    content: string,
    submittedInput?: historyMod.InputEntry,
  ): Promise<void> {
    const text = content.trim();
    if (!text || this.streaming || this.stopping) {
      return;
    }
    // Claim the streaming slot synchronously, BEFORE any await: ensureAgent()
    // performs real I/O on cold start, and a second message arriving during
    // that await would otherwise pass the guard and run two agents on the
    // same conversation concurrently.
    this.streaming = true;
    this.exitPlanSucceeded = false;
    this.closePlanApproval();
    this.runCanceled = false;
    // totalTurns in loop_complete describes THIS run, not the process.
    this.turnCount = 0;
    this.subagentStates.clear();
    this.broadcastSubagents();
    let handle: AgentRuntime | null = null;
    try {
      const command = parseCommand(text);
      if (command?.name === "login" || command?.name === "provider") {
        if (!submittedInput) {
          historyMod.recordInput({
            text,
            cwd: cwd(),
            sessionId: this.agentHandle?.sessionId ?? null,
            source: "ws",
            commandName: "login",
          });
        }
        this.broadcast({ type: "replay_user", data: { content: text } });
        this.broadcastProviderList();
        this.broadcast({ type: "command_done", data: null });
        return;
      }
      handle = await this.ensureAgent();
      if (!handle || this.runCanceled) {
        if (!submittedInput) {
          historyMod.recordInput({
            text,
            cwd: cwd(),
            sessionId: null,
            source: "ws",
          });
        }
        return;
      }
      const input =
        submittedInput ??
        historyMod.recordInput({
          text,
          cwd: handle.cwd,
          sessionId: handle.sessionId,
          source: "ws",
          commandName:
            resolveCommand(text, handle.cmdRegistry)?.command?.name ?? null,
        });

      const userBash = parseUserBashCommand(text);
      if (userBash !== null) {
        await this.runUserBash(
          handle,
          userBash.command,
          userBash.excludeFromContext,
          input,
        );
      } else if (text.startsWith("/") && parseCommand(text) !== null) {
        // Slash commands (including prompt-type skills and /plan turns) run
        // through their own handler; leftover replay below covers them too.
        this.broadcast({ type: "replay_user", data: { content: text } });
        await this.handleSlashCommand(text, input);
      } else {
        this.broadcast({ type: "replay_user", data: { content: text } });
        const startTime = Date.now();
        // @-refs expand exactly like the terminal: the transcript shows the
        // raw text while the conversation and session store the expansion
        // (inlined file contents and image blocks).
        const expanded = await expandAtRefsWithImages(text, handle.cwd);
        await this.streamAgentRun(handle, expanded, startTime, input);
      }
    } catch (err) {
      log.error({ err }, "agent stream error");
      this.broadcast({
        type: "error",
        data: { message: asErrorString(err) },
      });
    } finally {
      this.streaming = false;
    }

    if (this.pendingPlanExecution) {
      const plan = this.pendingPlanExecution;
      this.pendingPlanExecution = null;
      await this.handleUserMessage(plan);
    }

    if (!handle) {
      return;
    }
    // Steering queued too late for in-run delivery becomes follow-up turns
    // (parity with the terminal UI), unless the run was canceled. A new run
    // may have started between the reset above and this replay; steer the
    // leftover into it instead of silently dropping the message.
    const leftovers = handle.takeSteeringLeftovers();
    if (!this.runCanceled) {
      for (const leftover of leftovers) {
        if (this.streaming) {
          this.handleSteeringMessage(leftover.text, leftover.input);
        } else {
          await this.handleUserMessage(leftover.text, leftover.input);
        }
      }
    }
    await this.drainFollowUps();
  }

  /**
   * Bridges one agent run to the WebSocket: flushes accumulated stream text
   * before tool results and turn boundaries, mirroring the terminal loop.
   */
  private async streamAgentRun(
    handle: AgentRuntime,
    text: string | Record<string, unknown>[] | null,
    startTime: number,
    input?: historyMod.InputEntry,
  ): Promise<void> {
    const callbacks: RunCallbacks = {
      input,
      onPermissionRequest: this.createPermissionCallback(),
    };
    let streamBuf = "";
    this.persistRuntimeState();
    for await (const ev of handle.run(text, callbacks)) {
      if (
        ev.type === "tool_result" ||
        ev.type === "turn_complete" ||
        ev.type === "loop_complete"
      ) {
        if (streamBuf) {
          this.broadcast({ type: "stream_end", data: { text: streamBuf } });
          streamBuf = "";
        }
      }
      this.bridgeEvent(ev, startTime, (t) => {
        streamBuf += t;
      });
      if (ev.type === "usage" || ev.type === "turn_complete") {
        this.broadcastRuntimeStatus();
      }
    }
    this.persistRuntimeState();
    this.broadcastRuntimeStatus();
  }

  /**
   * Terminal-parity wakeup: background tasks and teammates only deliver their
   * notifications inside a run, so an idle server starts a notification-only
   * turn as soon as something is pending (the terminal's useNotificationWakeup).
   */
  private async runNotificationTurn(): Promise<void> {
    if (this.streaming || this.stopping || !this.agentHandle) {
      return;
    }
    const handle = this.agentHandle;
    this.streaming = true;
    this.exitPlanSucceeded = false;
    this.closePlanApproval();
    this.runCanceled = false;
    this.turnCount = 0;
    const startTime = Date.now();
    try {
      await this.streamAgentRun(handle, null, startTime);
    } catch (err) {
      log.error({ err }, "notification turn failed");
      this.broadcast({
        type: "error",
        data: { message: asErrorString(err) },
      });
    } finally {
      this.streaming = false;
    }
    const leftovers = handle.takeSteeringLeftovers();
    if (!this.runCanceled) {
      for (const leftover of leftovers) {
        await this.handleUserMessage(leftover.text, leftover.input);
      }
    }
    await this.drainFollowUps();
  }

  /** Runs a user "!command" through the Bash tool (terminal parity). */
  private async runUserBash(
    handle: AgentRuntime,
    command: string,
    excludeFromContext: boolean,
    input: historyMod.InputEntry,
  ): Promise<void> {
    if (!command) {
      this.broadcast({
        type: "system",
        data: {
          message: `Warning: Enter a Bash command after ${excludeFromContext ? "!!" : "!"}.`,
        },
      });
      return;
    }
    const bashTool = handle.registry.getInstanceOf("Bash", BashTool);
    if (!bashTool) {
      this.broadcast({
        type: "error",
        data: { message: "Bash tool is unavailable" },
      });
      return;
    }
    const controller = new AbortController();
    this.userBashController = controller;
    const toolId = nextRequestId("user-bash");
    const started = Date.now();
    this.broadcast({
      type: "tool_use",
      data: { toolId, toolName: "Bash", args: { command } },
    });
    let result: ToolResult;
    try {
      result = await executeUserBash(
        bashTool,
        {
          cwd: handle.cwd,
          sessionId: handle.sessionId,
          abortSignal: controller.signal,
          onOutput: (output) => {
            this.broadcast({
              type: "tool_output",
              data: { toolId, output: plainTerminalText(output) },
            });
          },
        },
        command,
        excludeFromContext,
      );
    } catch (error) {
      result = { output: `Error: ${asErrorString(error)}`, isError: true };
    }
    this.userBashController = null;
    const elapsed = (Date.now() - started) / 1000;
    const status = controller.signal.aborted
      ? "stopped"
      : result.isError
        ? "failed"
        : "completed";
    this.broadcast({
      type: "tool_result",
      data: {
        toolId,
        toolName: "Bash",
        output: result.output,
        isError: result.isError ?? false,
        elapsed,
      },
    });
    // Record exactly like the terminal: session row always, model context
    // only unless the user opted out with "!!".
    const recorded: UserBashResult = {
      command,
      excludeFromContext,
      output: result.output,
      isError: result.isError ?? false,
      elapsed,
      status,
    };
    try {
      const message = {
        role: "user" as const,
        content: userBashContext(recorded),
        user_bash: recorded,
        timestamp: input.timestamp / 1000,
      };
      saveMessage(handle.cwd, handle.sessionId, message);
      handle.conv.appendMessages(rebuildFromSession([message]));
    } catch (err) {
      this.broadcast({
        type: "error",
        data: { message: asErrorString(err) },
      });
    }
  }

  /** Queues a mid-run user message as steering for the active agent run. */
  private handleSteeringMessage(
    content: string,
    submittedInput?: historyMod.InputEntry,
  ): void {
    const text = content.trim();
    if (!text) {
      return;
    }
    if (
      /^\/warming(?:\s+(?:status|stop|resume))?$/u.test(text) &&
      this.agentHandle
    ) {
      const handle = this.agentHandle;
      if (!submittedInput) {
        historyMod.recordInput({
          text,
          cwd: handle.cwd,
          sessionId: handle.sessionId,
          source: "ws",
          commandName: "warming",
        });
      }
      void controlRuntimeWarming(handle, text.slice("/warming".length)).then(
        (message) => {
          if (this.agentHandle !== handle) {
            return;
          }
          this.broadcast({ type: "system", data: { message } });
          this.broadcastRuntimeStatus();
        },
        (error: unknown) => {
          this.broadcast({
            type: "error",
            data: { message: asErrorString(error) },
          });
        },
      );
      return;
    }
    const goalControl = /^\/goal(?:\s+(status|pause|clear|complete))?$/u.exec(
      text,
    );
    if (goalControl && this.agentHandle?.goalManager) {
      historyMod.recordInput({
        text,
        cwd: this.agentHandle.cwd,
        sessionId: this.agentHandle.sessionId,
        source: "ws",
        commandName: "goal",
      });
      const result = handleGoalCommand(
        this.agentHandle.goalManager,
        goalControl[1] ?? "",
      );
      this.broadcast({ type: "system", data: { message: result.message } });
      return;
    }
    // Slash and Bash commands run as follow-ups instead of model steering.
    if (
      (text.startsWith("/") && parseCommand(text) !== null) ||
      parseUserBashCommand(text) !== null
    ) {
      this.enqueueFollowUp(text);
      return;
    }
    if (!this.agentHandle) {
      this.enqueueFollowUp(text, submittedInput);
      return;
    }
    const input =
      submittedInput ??
      historyMod.recordInput({
        text,
        cwd: this.agentHandle.cwd,
        sessionId: this.agentHandle.sessionId,
        source: "ws",
      });
    if (!this.agentHandle?.steer(text, input)) {
      this.enqueueFollowUp(text, input);
      return;
    }
    this.broadcast({ type: "steering_queued", data: { text } });
  }

  /** Queues a message that cannot run or steer right now. */
  private enqueueFollowUp(text: string, input?: historyMod.InputEntry): void {
    this.followUps.push({ text, input });
    this.broadcastFollowUps();
  }

  private broadcastFollowUps(): void {
    this.broadcast({
      type: "followups",
      data: { list: this.followUps.map((entry) => entry.text) },
    });
  }

  /** Replays queued follow-ups once the streaming slot is free. */
  private async drainFollowUps(): Promise<void> {
    while (!this.streaming && !this.stopping && this.followUps.length > 0) {
      const next = this.followUps.shift();
      this.broadcastFollowUps();
      if (next !== undefined) {
        await this.handleUserMessage(next.text, next.input);
      }
    }
  }

  /** Bridges an AgentEvent to the corresponding WS message. */
  private bridgeEvent(
    ev: AgentEvent,
    startTime: number,
    appendStream: (text: string) => void,
  ): void {
    // Unified structured event log; only noteworthy events emit a JSONL line (see log.ts).
    this.eventLogger.onEvent(ev);

    switch (ev.type) {
      case "stream_text":
        appendStream(ev.text);
        this.broadcast({ type: "stream_text", data: { text: ev.text } });
        break;

      case "thinking_text":
        this.broadcast({ type: "thinking_text", data: { text: ev.text } });
        break;

      case "thinking_complete":
        // No WS message needed; handled internally by Agent
        break;

      case "tool_use":
        this.broadcast({
          type: "tool_use",
          data: { toolId: ev.toolId, toolName: ev.toolName, args: ev.args },
        });
        break;

      case "tool_result":
        this.broadcast({
          type: "tool_result",
          data: {
            toolId: ev.toolId,
            toolName: ev.toolName,
            output: ev.output,
            ...(ev.mcpApp ? { mcpApp: ev.mcpApp } : {}),
            isError: ev.isError,
            elapsed: ev.elapsed,
          },
        });
        if (
          (ev.toolName === "ExitPlanMode" || ev.toolName === "EnterPlanMode") &&
          !ev.isError
        ) {
          this.exitPlanSucceeded = true;
        }
        if (ev.toolName === "EnterPlanMode" && !ev.isError) {
          this.broadcastStatus();
        }
        break;

      case "steering_delivered": {
        this.broadcast({
          type: "steering_delivered",
          data: { text: ev.text },
        });
        break;
      }

      case "turn_complete":
        this.persistRuntimeState();
        this.turnCount++;
        this.broadcast({
          type: "turn_complete",
          data: { turn: this.turnCount },
        });
        break;

      case "loop_complete": {
        const elapsed = (Date.now() - startTime) / 1000;
        this.broadcast({
          type: "loop_complete",
          data: {
            stopReason: ev.stopReason,
            totalTurns: this.turnCount,
            elapsed,
          },
        });
        // Plan approval gate (parity with the terminal UI): after a run in
        // plan mode where planning succeeded, ask the user to approve.
        if (
          this.agentHandle?.permissionMode === "plan" &&
          this.exitPlanSucceeded
        ) {
          this.broadcastPlanApprovalRequest();
        }
        break;
      }

      case "usage":
        this.lastUsage = {
          inputTokens: ev.usage.inputTokens,
          outputTokens: ev.usage.outputTokens,
        };
        this.broadcast({ type: "usage", data: this.usagePayload() });
        break;

      case "error":
        this.broadcast({
          type: "error",
          data: { message: ev.error.message },
        });
        break;

      case "compact":
        this.broadcast({ type: "compact", data: { message: ev.message } });
        break;

      case "retry":
        this.broadcast({
          type: "retry",
          data: { reason: ev.reason, waitMs: ev.delay },
        });
        break;

      case "permission_request":
        // Handled by onPermissionRequest callback; no-op here
        break;
    }
  }

  /** Handles slash command input: parse, dispatch to handler by type. */
  private async handleSlashCommand(
    input: string,
    submittedInput?: historyMod.InputEntry,
  ): Promise<void> {
    const handle = await this.ensureAgent();
    if (!handle) {
      // Init failed; reset the client-side streaming state so the UI is usable again.
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    const parsed = resolveCommand(input, handle.cmdRegistry);
    if (
      parsed &&
      [
        "tree",
        "fork",
        "clone",
        "name",
        "tags",
        "archive",
        "unarchive",
        "maintenance",
        "export",
        "import",
        "diagnostics",
      ].includes(parsed.name)
    ) {
      const runtime = this.agentHandle;
      if (!runtime) {
        return;
      }
      const manager =
        this.environment?.manager ??
        SessionManager.open(runtime.cwd, runtime.sessionId);
      manager.refresh();
      try {
        if (parsed.name === "tree") {
          const command = parseSessionTreeCommand(parsed.args);
          if (command.action === "label" && command.entryId) {
            manager.setLabel(command.entryId, command.text || null);
          } else if (command.action === "go" && command.entryId) {
            const controller = new AbortController();
            this.treeController = controller;
            const originalLeaf = manager.leafId;
            let selectedLeaf: string | null | undefined;
            let result: { input?: string };
            try {
              result = await navigateSessionTree(
                runtime,
                manager,
                command.entryId,
                command.summary,
                AbortSignal.any([
                  controller.signal,
                  this.initializationController.signal,
                ]),
              );
              selectedLeaf = manager.leafId;
              await this.replaceEnvironment(manager);
            } catch (error) {
              if (selectedLeaf !== undefined) {
                manager.refresh();
                if (manager.leafId === selectedLeaf) {
                  manager.selectActiveLeaf(originalLeaf);
                }
              }
              throw error;
            } finally {
              if (this.treeController === controller) {
                this.treeController = null;
              }
            }
            if (result.input) {
              this.broadcast({
                type: "input_prefill",
                data: { content: result.input },
              });
            }
          }
          if (
            command.action === "show" ||
            command.action === "fold" ||
            command.action === "unfold"
          ) {
            this.treeOptions = updateSessionTreeOptions(
              manager.getTree(),
              this.treeOptions,
              command,
            );
          }
          this.broadcast({
            type: "session_tree",
            data: {
              rows: sessionTreeRows(
                manager.getTree(),
                manager.leafId,
                command.text,
                this.treeOptions,
              ),
              leafId: manager.leafId,
              ...(command.action === "show" && command.summary !== undefined
                ? { summary: command.summary }
                : {}),
            },
          });
        } else if (
          parsed.name === "archive" ||
          parsed.name === "unarchive" ||
          parsed.name === "maintenance"
        ) {
          const message = await sessionMaintenanceCommand(
            parsed.name,
            parsed.args,
            manager,
            this.createAskUserCallback(),
            this.initializationController.signal,
          );
          this.broadcast({ type: "system", data: { message } });
        } else {
          const result = await sessionTransferCommand(
            parsed.name,
            parsed.args,
            runtime,
            manager,
            this.createAskUserCallback(),
            this.createPermissionCallback(),
          );
          if (result.manager) {
            await this.replaceEnvironment(result.manager);
            if (result.manager.initialInput) {
              this.broadcast({
                type: "input_prefill",
                data: { content: result.manager.initialInput },
              });
            }
          }
          this.broadcast({ type: "system", data: { message: result.message } });
        }
      } catch (error) {
        this.broadcast({
          type: "error",
          data: { message: asErrorString(error) },
        });
      }
      this.broadcast({ type: "command_done", data: null });
      return;
    }
    if (!parsed) {
      return;
    }

    const { name, args } = parsed;
    const cmd = parsed.command;
    if (name === "warming") {
      if (!submittedInput) {
        historyMod.recordInput({
          text: input,
          cwd: handle.cwd,
          sessionId: handle.sessionId,
          source: "ws",
          commandName: "warming",
        });
      }
      try {
        const message = await controlRuntimeWarming(handle, args);
        if (this.agentHandle !== handle) {
          return;
        }
        this.broadcast({ type: "system", data: { message } });
        this.broadcastRuntimeStatus();
      } catch (error) {
        this.broadcast({
          type: "error",
          data: { message: asErrorString(error) },
        });
      }
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    if (!cmd) {
      this.broadcast({
        type: "error",
        data: {
          message: `Unknown command: /${name} -- type /help to see available commands`,
        },
      });
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    const inputEntry =
      submittedInput ??
      historyMod.recordInput({
        text: input,
        cwd: handle.cwd,
        sessionId: handle.sessionId,
        source: "ws",
        commandName: cmd.name,
      });
    const ctx = this.buildCommandContext(args);

    switch (cmd.type) {
      case "local": {
        // The /memory and /mcp handlers return placeholder tokens; both the
        // terminal UI and the remote server intercept these command names and
        // render the real status themselves (the remote version is below).
        if (name === "memory") {
          this.broadcast({
            type: "system",
            data: { message: this.buildMemoryStatus(args) },
          });
        } else if (name === "status") {
          this.broadcast({
            type: "system",
            data: { message: await this.buildSessionStatus() },
          });
        } else if (name === "mcp") {
          if (args.trim().toLowerCase() === "reload") {
            await this.reloadMcpServers();
            this.broadcast({ type: "command_done", data: null });
            break;
          }
          if (!args.trim() || args.trim().toLowerCase() === "status") {
            this.broadcast({
              type: "system",
              data: { message: this.buildMcpStatus() },
            });
          } else {
            await this.handleMcpCommand(args);
          }
        } else if (name === "thinking" && !args.trim()) {
          // Terminal parity: bare /thinking opens the level picker.
          this.broadcast({
            type: "thinking_form",
            data: {
              current:
                handle.client.getThinkingLevel?.() ??
                handle.provider.thinking ??
                DEFAULT_THINKING_LEVEL,
              levels: [
                ...(handle.client.getSupportedThinkingLevels?.() ??
                  getSupportedThinkingLevels(handle.provider)),
              ],
            },
          });
        } else {
          const result = cmd.handler(ctx);
          this.broadcast({
            type: "system",
            data: { message: result, markdown: cmd.markdown },
          });
        }
        if (name === "thinking") {
          this.broadcastStatus();
        }
        this.broadcast({ type: "command_done", data: null });
        break;
      }

      case "local_ui":
        await this.handleLocalUICommand(name, args);
        break;

      case "prompt": {
        const prompt = cmd.handler(ctx);
        const displayText = args ? `/${name} ${args}` : `/${name}`;

        if (cmd.agent) {
          this.exitPlanSucceeded = false;
          this.runCanceled = false;
          const controller = new AbortController();
          this.subagentController = controller;
          const startTime = Date.now();
          try {
            const result = await runSubagentCommand(
              cmd.agent,
              prompt,
              displayText,
              {
                cwd: handle.cwd,
                sessionId: handle.sessionId,
                inputEntry,
                registry: handle.registry,
                conversation: handle.conv,
                permissionChecker: handle.checker,
                onPermissionRequest: this.createPermissionCallback(),
                abortSignal: controller.signal,
                onEvent: (event) => {
                  this.bridgeEvent(event, startTime, () => {});
                  if (event.type === "stream_text") {
                    this.broadcast({
                      type: "stream_end",
                      data: { text: event.text },
                    });
                  }
                },
              },
            );
            if (cmd.agent === PLAN_AGENT_NAME && !result.isError) {
              this.broadcastStatus();
              this.broadcastPlanApprovalRequest();
            }
          } finally {
            this.subagentController = null;
            this.broadcast({ type: "command_done", data: null });
          }
          break;
        }

        this.exitPlanSucceeded = false;
        const startTime = Date.now();
        try {
          const callbacks: RunCallbacks = {
            input: inputEntry,
            userContent: displayText,
            onPermissionRequest: this.createPermissionCallback(),
          };

          let streamBuf = "";
          // handle.run() adds the prompt to conv and announces MCP instructions
          for await (const ev of handle.run(prompt, callbacks)) {
            if (
              ev.type === "tool_result" ||
              ev.type === "turn_complete" ||
              ev.type === "loop_complete"
            ) {
              if (streamBuf) {
                this.broadcast({
                  type: "stream_end",
                  data: { text: streamBuf },
                });
                streamBuf = "";
              }
            }
            this.bridgeEvent(ev, startTime, (t) => {
              streamBuf += t;
            });
          }
        } catch (err) {
          log.error({ err }, "agent stream error in prompt command");
          this.broadcast({
            type: "error",
            data: { message: asErrorString(err) },
          });
        }
        break;
      }

      case "skill_fork":
        await this.handleSkillFork(name, args);
        break;
    }
  }

  /** Runs a fork-mode skill command in an isolated subagent (terminal parity). */
  private async handleSkillFork(name: string, args: string): Promise<void> {
    const handle = this.agentHandle;
    if (!handle) {
      this.broadcast({ type: "command_done", data: null });
      return;
    }
    const skill = handle.skillCatalog?.get(name);
    if (!skill) {
      this.broadcast({
        type: "system",
        data: { message: `Skill not found: ${name}` },
      });
      this.broadcast({ type: "command_done", data: null });
      return;
    }
    const controller = new AbortController();
    this.subagentController = controller;
    this.runCanceled = false;
    this.broadcast({
      type: "system",
      data: { message: `Running skill "${name}" in fork mode…` },
    });
    try {
      const forkHost: SkillForkHost = {
        activateSkill: (skillName, body) => {
          handle.activeSkills.set(skillName, body);
        },
        snapshotParentMessages: (count: number) => {
          const msgs = handle.conv.getMessages();
          return msgs
            .slice(-count)
            .map((m) => `[${m.role}] ${contentToText(m.content)}`)
            .join("\n");
        },
        runSubagent: (
          prompt: string,
          abortSignal?: AbortSignal,
          context?: ToolContext,
        ) =>
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
            undefined,
            undefined,
            context?.permissionChecker?.forCwd(handle.cwd) ??
              handle.checker.forCwd(handle.cwd),
            {
              abortSignal: abortSignal ?? controller.signal,
              background: false,
              onPermissionRequest: this.createPermissionCallback(),
            },
          ),
      };
      const result = await runSkillFork(
        skill,
        args,
        forkHost,
        controller.signal,
      );
      this.broadcast({ type: "stream_text", data: { text: result } });
      this.broadcast({ type: "stream_end", data: { text: result } });
    } catch (err) {
      this.broadcast({
        type: "error",
        data: { message: `Skill fork error: ${asErrorString(err)}` },
      });
    } finally {
      this.subagentController = null;
      this.broadcast({ type: "command_done", data: null });
    }
  }

  /** Handles local_ui commands (clear, compact, plan, resume, rewind, quit, etc.). */
  private async handleLocalUICommand(
    name: string,
    args: string,
  ): Promise<void> {
    if (!this.agentHandle) {
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    switch (name) {
      case "reload":
      case "settings":
      case "retry": {
        try {
          const environment = this.environment;
          if (!environment) {
            throw new Error("Agent is not initialized");
          }
          let message: string;
          if (name === "reload") {
            const result = await reloadRuntimeResources(
              environment,
              loadConfig(this.opts.invocationOptions?.config),
              {
                overrides: this.preferenceOverrides,
                disabled: this.opts.invocationOptions?.noProjectResources,
                onTrustRequest: (request) =>
                  requestProjectTrust(this.createAskUserCallback(), request),
              },
            );
            this.authorizedProject = environment.project.trusted
              ? {
                  identity: environment.project.identity,
                  fingerprint: environment.project.fingerprint,
                }
              : undefined;
            this.persistRuntimeState();
            message = `Resources reloaded: ${result.skills} skills · ${result.commands} commands${result.errors.map((error) => `\n${error.serverName}: ${error.error}`).join("")}`;
          } else if (name === "settings") {
            if (args.trim()) {
              const parsed: unknown = JSON.parse(args);
              const patch = PreferencesPatchSchema.parse(parsed);
              applyRuntimePreferences(environment.runtime, patch);
              this.preferenceOverrides = mergePreferences(
                this.preferenceOverrides,
                patch,
              );
            }
            message = JSON.stringify(environment.runtime.preferences, null, 2);
          } else {
            const action = args.trim() || "status";
            if (action === "abort") {
              message = environment.runtime.abortRetry()
                ? "Retry cancelled"
                : "No retry pending";
            } else {
              if (action === "on" || action === "off") {
                const patch = { auto_retry: action === "on" };
                applyRuntimePreferences(environment.runtime, patch);
                this.preferenceOverrides = mergePreferences(
                  this.preferenceOverrides,
                  patch,
                );
              } else if (action !== "status") {
                throw new Error("Usage: /retry [status|on|off|abort]");
              }
              message = `Automatic retry: ${environment.runtime.preferences.auto_retry ? "on" : "off"}`;
            }
          }
          this.broadcast({ type: "system", data: { message } });
        } catch (error) {
          this.broadcast({
            type: "error",
            data: { message: asErrorString(error) },
          });
        }
        this.broadcast({ type: "command_done", data: null });
        break;
      }
      case "workflows": {
        const handle = this.agentHandle;
        const service = getWorkflowService(handle.registry);
        try {
          const message = service
            ? await service.command(args, {
                cwd: handle.cwd,
                permissionChecker: handle.checker,
                onPermissionRequest: this.createPermissionCallback(),
              })
            : "Workflow service is not initialized";
          this.broadcast({ type: "system", data: { message } });
        } catch (error) {
          this.broadcast({
            type: "error",
            data: { message: asErrorString(error) },
          });
        }
        this.broadcast({ type: "command_done", data: null });
        break;
      }
      case "clear": {
        // Stop the old teammates AND background tasks before rotating the
        // session, and wait for both (parity with the TUI clear), so no
        // teammate keeps running — and billing/notifying — into the new
        // session. A stop failure is surfaced, never masked as a clean clear.
        const stopResults = await Promise.allSettled([
          this.agentHandle.backgroundTaskManager.stopAll(),
          this.agentHandle.teamManager.stopAll(),
        ]);
        for (const result of stopResults) {
          if (result.status === "rejected") {
            this.broadcast({
              type: "error",
              data: {
                message: `Clear could not stop all background work: ${asErrorString(result.reason)}`,
              },
            });
          }
        }
        if (stopResults.some((result) => result.status === "rejected")) {
          this.broadcast({ type: "command_done", data: null });
          break;
        }
        // Reset in place (AgentTool captured the conversation manager) and
        // rotate the session so /resume and the JSONL no longer see the
        // pre-clear history.
        await this.replaceEnvironment(
          SessionManager.create(this.agentHandle.cwd, {
            persist: this.opts.invocationOptions?.persist,
          }),
        );
        if (!this.agentHandle) {
          break;
        }
        this.subagentStates.clear();
        this.broadcastSubagents();
        this.broadcast({
          type: "connected",
          data: {
            session: this.agentHandle.sessionId,
            cwd:
              this.agentHandle?.cwd ??
              canonicalPath(this.opts.invocationOptions?.cwd ?? cwd()),
            streaming: this.streaming,
          },
        });
        this.broadcast({ type: "clear", data: null });
        this.broadcast({ type: "command_done", data: null });
        break;
      }

      case "compact":
        await this.handleCompact(args);
        break;

      case "login":
      case "provider":
        // Browser parity: open the provider dialog (switch or add a provider).
        this.broadcastProviderList();
        this.broadcast({ type: "command_done", data: null });
        break;

      case "model":
        if (args.trim()) {
          await this.applyModel(args.trim());
        } else {
          await this.broadcastModelList();
        }
        this.broadcast({ type: "command_done", data: null });
        break;

      case "resume":
        await this.handleResume(args);
        break;

      case "rewind":
        this.broadcastRewindList();
        this.broadcast({ type: "command_done", data: null });
        break;

      case "quit":
        this.broadcast({
          type: "system",
          data: { message: "Shutting down the remote server…" },
        });
        this.broadcast({ type: "command_done", data: null });
        setTimeout(() => {
          void this.stop();
        }, SHUTDOWN_GRACE_MS).unref();
        break;

      case "skills": {
        const catalog = this.agentHandle.skillCatalog;
        if (!catalog) {
          this.broadcast({
            type: "system",
            data: { message: "No skills loaded." },
          });
        } else {
          const skills = catalog.list();
          if (skills.length === 0) {
            this.broadcast({
              type: "system",
              data: { message: "No skills found." },
            });
          } else {
            const lines = skills.map((s) => `  ${s.name}: ${s.description}`);
            this.broadcast({
              type: "system",
              data: {
                message: `Available skills (${String(skills.length)}):\n\n${lines.join("\n")}`,
              },
            });
          }
        }
        this.broadcast({ type: "command_done", data: null });
        break;
      }

      case "sandbox":
        await this.handleSandboxCommand(args);
        this.broadcast({ type: "command_done", data: null });
        break;

      case "worktree":
        try {
          const { stdout: output } = await execa("git", ["worktree", "list"], {
            cwd: this.agentHandle.cwd,
          });
          this.broadcast({
            type: "system",
            data: { message: `Worktree list:\n${output}` },
          });
        } catch {
          this.broadcast({
            type: "system",
            data: {
              message: "Not a git repository or git worktree not available.",
            },
          });
        }
        this.broadcast({ type: "command_done", data: null });
        break;

      default:
        this.broadcast({ type: "command_done", data: null });
        break;
    }
  }

  /** Mirrors the terminal Shift+Tab / onModeChange permission-mode transitions. */
  private applyPermissionMode(mode: PermissionMode): void {
    const handle = this.agentHandle;
    if (!handle || handle.permissionMode === mode) {
      return;
    }
    if (mode === "plan") {
      handle.checker.enterPlanMode();
      const planPath = getOrCreatePlanPath(handle);
      this.broadcast({
        type: "system",
        data: {
          message: `Entered plan mode (read-only). Plan file: ${planPath}`,
        },
      });
      if (this.hasExitedPlanMode && planExists(handle)) {
        const reentryMsg = buildPlanModeReentryReminder(planPath, true);
        if (reentryMsg) {
          handle.conv.addSystemReminder(reentryMsg);
          this.broadcast({ type: "system", data: { message: reentryMsg } });
        }
      }
      this.hasExitedPlanMode = false;
    } else if (handle.permissionMode === "plan") {
      const planPath = handle.checker.planFilePath;
      this.hasExitedPlanMode = true;
      handle.checker.exitPlanMode(mode);
      handle.conv.addSystemReminder(
        buildPlanModeExitReminder(planPath, !!planPath && planExists(handle)),
      );
      this.broadcast({
        type: "system",
        data: {
          message:
            mode === "bypassPermissions"
              ? "Exited plan mode. Entered YOLO mode."
              : "Exited plan mode. Each edit requires confirmation.",
        },
      });
    } else {
      handle.checker.mode = mode;
    }
    this.broadcastStatus();
  }

  /** Discovers the provider's models and opens the browser model picker. */
  private async broadcastModelList(): Promise<void> {
    const handle = this.agentHandle ?? (await this.ensureAgent());
    if (!handle) {
      return;
    }
    this.modelListController?.abort();
    const controller = new AbortController();
    this.modelListController = controller;
    const current = handle.provider.model;
    this.broadcast({
      type: "model_list",
      data: { status: "loading", models: [], current },
    });
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
        return;
      }
      this.broadcast({
        type: "model_list",
        data: {
          status: models.length > 0 ? "ready" : "empty",
          models: models.map((m) => ({
            id: m.id,
            name: m.display_name ?? m.name ?? null,
          })),
          current,
        },
      });
    } catch {
      if (!controller.signal.aborted) {
        this.broadcast({
          type: "model_list",
          data: { status: "error", models: [], current },
        });
      }
    } finally {
      if (this.modelListController === controller) {
        this.modelListController = null;
      }
    }
  }

  private async changeProviderConfiguration(
    change: () => Promise<void>,
  ): Promise<void> {
    if (this.streaming || this.stopping) {
      this.broadcast({
        type: "system",
        data: {
          message:
            "Cannot change models or providers while a run is in progress.",
        },
      });
      return;
    }
    this.streaming = true;
    try {
      await change();
    } finally {
      this.streaming = false;
      await this.drainFollowUps();
    }
  }

  /** Switches the active model, rebuilding the client (terminal /model parity). */
  private async applyModel(modelId: string): Promise<void> {
    const handle = this.agentHandle ?? (await this.ensureAgent());
    if (!handle) {
      return;
    }
    const nextModel = modelId.trim();
    if (!nextModel) {
      return;
    }
    if (nextModel === handle.provider.model) {
      this.broadcast({
        type: "system",
        data: { message: `Model already set to ${nextModel}.` },
      });
      return;
    }
    const updated = resolveInvocationProvider([handle.provider], 0, {
      model: nextModel,
    });
    try {
      const environment = detectEnvironment(handle.cwd);
      environment.model = updated.model;
      const client = await createClient(
        updated,
        buildSystemPrompt(environment),
      );
      await handle.updateProvider(updated, client);
      this.persistRuntimeState();
      this.opts.providers = this.opts.providers.map((entry) =>
        entry.base_url === updated.base_url ? { ...updated } : entry,
      );
      decideAndApply(handle.registry, updated.base_url, updated.protocol);
    } catch (err) {
      this.broadcast({
        type: "error",
        data: { message: `Failed to switch model: ${asErrorString(err)}` },
      });
      return;
    }
    // A save failure must not undo the runtime switch.
    let saved = true;
    try {
      persistModel(updated.base_url, updated.model);
    } catch {
      saved = false;
    }
    this.broadcastStatus();
    this.broadcast({
      type: "system",
      data: {
        message: `Model set to ${updated.model}${saved ? " and saved" : " for this session"}.`,
      },
    });
  }

  /** Opens the browser provider dialog (never exposes API keys). */
  private broadcastProviderList(): void {
    const handle = this.agentHandle;
    const currentIndex = handle
      ? Math.max(
          0,
          this.opts.providers.findIndex(
            (entry) => entry.base_url === handle.provider.base_url,
          ),
        )
      : (this.opts.defaultProvider ?? 0);
    this.broadcast({
      type: "provider_list",
      data: {
        providers: this.opts.providers.map((entry) => ({
          name: entry.name,
          protocol: entry.protocol,
          base_url: entry.base_url,
          model: entry.model,
        })),
        current: currentIndex,
      },
    });
  }

  /** Switches the active provider, rebuilding the client (terminal parity). */
  private async applyProviderSwitch(index: number): Promise<void> {
    const provider = this.opts.providers[index];
    if (!provider) {
      this.broadcast({
        type: "error",
        data: { message: `Unknown provider index: ${String(index)}` },
      });
      return;
    }
    if (!this.agentHandle) {
      this.opts.defaultProvider = index;
    }
    const handle = this.agentHandle ?? (await this.ensureAgent());
    if (!handle) {
      return;
    }
    try {
      const environment = detectEnvironment(handle.cwd);
      environment.model = provider.model;
      const client = await createClient(
        provider,
        buildSystemPrompt(environment),
      );
      await handle.updateProvider(provider, client);
      this.persistRuntimeState();
      decideAndApply(handle.registry, provider.base_url, provider.protocol);
      this.opts.defaultProvider = index;
    } catch (err) {
      this.broadcast({
        type: "error",
        data: { message: `Failed to switch provider: ${asErrorString(err)}` },
      });
      return;
    }
    let saved = true;
    try {
      persistDefaultProvider(index);
    } catch {
      saved = false;
    }
    this.broadcastStatus();
    this.broadcast({
      type: "system",
      data: {
        message: `Provider switched to ${provider.name} · ${provider.model}.${saved ? "" : " Default provider could not be saved."}`,
      },
    });
  }

  /** Saves a provider from the browser login form and activates it. */
  private async handleProviderSave(
    form: z.infer<typeof ProviderSaveSchema>,
  ): Promise<void> {
    let saved: ReturnType<typeof saveProvider>;
    try {
      saved = saveProvider(form, this.opts.providers);
    } catch (err) {
      this.broadcast({
        type: "error",
        data: { message: `Failed to save provider: ${asErrorString(err)}` },
      });
      return;
    }
    this.opts.providers = saved.providers;
    this.broadcast({
      type: "system",
      data: {
        message: `Provider ${saved.provider.name} saved${saved.replaced ? " (replaced existing entry)" : ""}.`,
      },
    });
    const index = saved.providers.findIndex(
      (entry) => entry.base_url === saved.provider.base_url,
    );
    await this.applyProviderSwitch(Math.max(0, index));
  }

  /** Sends the rewind checkpoint list for the browser picker. */
  private broadcastRewindList(): void {
    const handle = this.agentHandle;
    if (!handle) {
      return;
    }
    const fileHistory = handle.fileHistory;
    if (!fileHistory.hasSnapshots()) {
      this.broadcast({
        type: "system",
        data: { message: "No checkpoints to rewind to." },
      });
      return;
    }
    this.broadcast({
      type: "rewind_list",
      data: {
        snapshots: fileHistory.getSnapshots().map((snap, index) => ({
          index,
          id: snap.id,
          userText: snap.userText,
          timestamp: snap.timestamp,
          fileCount: Object.keys(snap.backups).length,
        })),
      },
    });
  }

  /** Restores code and/or conversation to a checkpoint (terminal /rewind parity). */
  private async handleRewindAction(
    snapshotId: string,
    action: "code_and_conversation" | "conversation_only" | "code_only",
  ): Promise<void> {
    const handle = this.agentHandle;
    if (!handle) {
      return;
    }
    if (this.streaming) {
      this.broadcast({
        type: "system",
        data: { message: "Cannot rewind while a run is in progress." },
      });
      return;
    }
    const fileHistory = handle.fileHistory;
    // Resolve by snapshot UUID, not the index the client saw: another
    // client's runs can trim the head and shift indices between listing and
    // choosing. A missing id means the checkpoint was trimmed or the session
    // was reset — fail explicitly instead of rewinding to the wrong snapshot.
    const snapshots = fileHistory.getSnapshots();
    const snapshotIndex = snapshots.findIndex(
      (candidate) => candidate.id === snapshotId,
    );
    if (snapshotIndex < 0) {
      this.broadcast({
        type: "error",
        data: {
          message:
            "That checkpoint is no longer available (the list changed or the session was reset). Reopen /rewind.",
        },
      });
      return;
    }
    const snap = snapshots[snapshotIndex];
    if (action !== "code_only") {
      void handle.stopMemoryTasks();
    }
    const fileList = (changed: string[]): string =>
      changed.length > 0
        ? "\n" + changed.map((file) => "  " + file).join("\n")
        : "";
    switch (action) {
      case "code_and_conversation": {
        const changed = fileHistory.rewind(snap.id);
        await this.rewindConversation(handle, snap);
        this.broadcast({
          type: "system",
          data: {
            message: `⟲ Rewound to checkpoint. Restored ${String(changed.length)} file(s) and conversation.${fileList(changed)}`,
          },
        });
        break;
      }
      case "conversation_only": {
        await this.rewindConversation(handle, snap);
        this.broadcast({
          type: "system",
          data: { message: "⟲ Rewound conversation. Files unchanged." },
        });
        break;
      }
      case "code_only": {
        const changed = fileHistory.rewind(snap.id);
        this.broadcast({
          type: "system",
          data: {
            message: `⟲ Restored ${String(changed.length)} file(s). Conversation unchanged.${fileList(changed)}`,
          },
        });
        break;
      }
    }
  }

  private async rewindConversation(
    handle: AgentRuntime,
    snap: Snapshot,
  ): Promise<void> {
    const manager = SessionManager.open(handle.cwd, handle.sessionId);
    const result = manager.navigate(snap.entryId);
    await this.replaceEnvironment(manager);
    if (result.input) {
      this.broadcast({
        type: "input_prefill",
        data: { content: result.input },
      });
    }
  }

  private getSandbox(): Promise<Sandbox | null> {
    return (this.sandbox ??= createSandbox());
  }

  private async disposeSandbox(): Promise<void> {
    const pending = this.sandbox;
    this.sandbox = null;
    const bashTool = this.agentHandle?.registry.getInstanceOf("Bash", BashTool);
    if (bashTool) {
      bashTool.sandbox = null;
      bashTool.sandboxRequired = false;
    }
    await (await pending)?.dispose?.();
  }

  /** /sandbox <auto|manual|off> — runtime sandbox toggle (terminal parity). */
  private async handleSandboxCommand(args: string): Promise<void> {
    const handle = this.agentHandle;
    if (!handle) {
      return;
    }
    const bashTool = handle.registry.getInstanceOf("Bash", BashTool);
    const arg = args.trim();
    if (arg === "off") {
      handle.checker.sandboxEnabled = false;
      handle.checker.sandboxAutoAllow = false;
      await this.disposeSandbox();
      this.broadcast({ type: "system", data: { message: "Sandbox: OFF" } });
      this.broadcastStatus();
      return;
    }
    if (arg === "auto" || arg === "manual") {
      const sandbox = await this.getSandbox();
      const sbAvailable = (await sandbox?.available()) ?? false;
      const unavailableReason =
        sandbox?.availabilityError ?? "sandbox unavailable";
      if (bashTool) {
        bashTool.sandbox = sandbox;
        bashTool.sandboxRequired = true;
        bashTool.sandboxConfig = {
          allowWrite: [handle.cwd, tmpdir()],
          denyWrite: [],
          networkEnabled: this.opts.sandboxConfig?.network_enabled ?? true,
        };
      }
      handle.checker.sandboxEnabled = true;
      handle.checker.sandboxAutoAllow = arg === "auto";
      this.broadcast({
        type: "system",
        data: {
          message: `Sandbox: ON + ${arg === "auto" ? "auto-allow" : "manual permissions"}${sbAvailable ? "" : ` (blocked: ${unavailableReason})`}`,
        },
      });
      this.broadcastStatus();
      return;
    }
    const enabled = handle.checker.sandboxEnabled;
    const status = enabled
      ? handle.checker.sandboxAutoAllow
        ? "ON + auto-allow"
        : "ON + manual"
      : "OFF";
    let runtime = "not initialized";
    if (enabled) {
      const sandbox = await this.getSandbox();
      const sbAvailable = (await sandbox?.available()) ?? false;
      runtime = sbAvailable
        ? "ready"
        : `blocked (${sandbox?.availabilityError ?? "sandbox unavailable"})`;
    }
    const lines = [
      `Sandbox status: ${status}`,
      `Runtime: ${runtime}`,
      "",
      "Usage: /sandbox <mode>",
      "  auto   — Enable sandbox + auto-allow (recommended)",
      "  manual — Enable sandbox + manual permission confirmation",
      "  off    — Disable sandbox",
    ];
    this.broadcast({
      type: "system",
      data: { message: lines.join("\n") },
    });
  }

  /** /mcp reload — re-reads the config from disk and reconnects (terminal parity). */
  private async reloadMcpServers(): Promise<void> {
    const handle = this.agentHandle;
    if (!handle) {
      return;
    }
    try {
      await this.replaceEnvironment(
        SessionManager.open(handle.cwd, handle.sessionId),
        true,
      );
      this.broadcast({
        type: "system",
        data: {
          message: `MCP reloaded: ${String(this.agentHandle?.mcpManager?.connectedServers().length ?? 0)} server(s) connected.`,
        },
      });
    } catch (error) {
      this.broadcast({
        type: "error",
        data: { message: `MCP reload failed: ${asErrorString(error)}` },
      });
    }
  }

  /** Rich /status output (terminal parity: provider, sandbox, MCP, session). */
  private async buildSessionStatus(): Promise<string> {
    const handle = this.agentHandle;
    if (!handle) {
      return "Agent is not ready yet.";
    }
    const sandbox = handle.checker.sandboxEnabled
      ? await this.getSandbox()
      : null;
    const sandboxReady = (await sandbox?.available()) ?? false;
    const sbStatus = handle.checker.sandboxEnabled
      ? `${handle.checker.sandboxAutoAllow ? "ON (auto-allow)" : "ON (manual)"}, ${sandboxReady ? "ready" : "blocked"}`
      : "OFF";
    const lines = [
      `Mode:      ${handle.permissionMode}`,
      `Model:     ${handle.provider.model}`,
      `Provider:  ${handle.provider.name} (${handle.provider.protocol})`,
      ...formatRuntimeStatus(handle.getStatus()).split("\n"),
      `Tools:     ${String(handle.registry.listTools().length)}`,
      `Sandbox:   ${sbStatus}`,
      `Memories:  ${handle.memoryEnabled ? String(handle.memoryManager.getMemories().length) : "disabled (enable_memory: false)"}`,
      `Skills:    ${String(handle.skillCatalog?.list().length ?? 0)}`,
      `MCP:       ${String(handle.mcpManager?.connectedServers().length ?? 0)} server(s), ${String(countMcpTools(handle.registry))} tool(s)`,
      `Session:   ${handle.sessionId}`,
      `Directory: ${handle.cwd}`,
    ];
    return lines.join("\n");
  }

  /** Stores a browser-uploaded image so @-expansion can attach it (clipboard parity). */
  private async handleImageUpload(
    upload: { clientId: string; name: string; dataBase64: string },
    reply: (message: WsOutbound) => void,
  ): Promise<void> {
    const handle = this.agentHandle ?? (await this.ensureAgent());
    if (!handle) {
      reply({
        type: "image_error",
        data: { clientId: upload.clientId, message: "Agent is not ready yet." },
      });
      return;
    }
    try {
      const bytes = Buffer.from(upload.dataBase64, "base64");
      if (bytes.length === 0) {
        throw new Error("Uploaded image is empty.");
      }
      if (bytes.length > MAX_UPLOAD_IMAGE_BYTES) {
        throw new Error(
          `Uploaded image is too large (${String(bytes.length)} bytes, limit ${String(MAX_UPLOAD_IMAGE_BYTES)}).`,
        );
      }
      const mediaType = await sniffMediaType(bytes);
      if (!mediaType) {
        throw new Error(
          "Uploaded file is not a recognized image (png, jpeg, gif, webp).",
        );
      }
      const ext =
        mediaType === "image/png"
          ? ".png"
          : mediaType === "image/jpeg"
            ? ".jpg"
            : mediaType === "image/gif"
              ? ".gif"
              : ".webp";
      const dir = fileHistoryDir(handle.sessionId);
      mkdirPrivateSync(dir);
      const safeName = upload.name
        .replace(/[^a-zA-Z0-9._-]/gu, "_")
        .replace(/\.[^.]*$/u, "")
        .slice(0, 80);
      const path = join(
        dir,
        `upload-${randomUUID()}-${safeName || "image"}${ext}`,
      );
      await writePrivateFile(path, bytes);
      reply({
        type: "image_saved",
        data: { clientId: upload.clientId, path },
      });
    } catch (err) {
      reply({
        type: "image_error",
        data: { clientId: upload.clientId, message: asErrorString(err) },
      });
    }
  }

  /** @-mention completion for the browser input (terminal dropdown parity). */
  private sendFileCompletions(
    ws: WebSocket,
    requestId: string,
    query: string,
  ): void {
    const root = this.agentHandle?.cwd ?? cwd();
    const cache = this.fileCache;
    let files: string[];
    if (
      cache?.key === root &&
      Date.now() - cache.scannedAt < FILE_CACHE_TTL_MS
    ) {
      files = cache.files;
    } else {
      files = scanCwdFiles(root);
      this.fileCache = { key: root, files, scannedAt: Date.now() };
    }
    this.send(ws, {
      type: "file_complete_response",
      data: { requestId, matches: filterFileMatches(files, query) },
    });
  }

  /** Ctrl+B parity: move running foreground shells to the background. */
  private backgroundForegroundShells(): void {
    const handle = this.agentHandle;
    if (!handle || !hasAnyForegroundTasks(handle.registry)) {
      return;
    }
    const count = backgroundAllForegroundTasks(handle.registry);
    this.broadcast({
      type: "system",
      data: {
        message: `Moved ${String(count)} foreground shell task(s) to the background.`,
      },
    });
  }

  /** Folds a subagent lifecycle event into the broadcast activity state. */
  private handleSubagentEvent(ev: RuntimeSubagentEvent): void {
    const existing = this.subagentStates.get(ev.toolCallId);
    switch (ev.type) {
      case "started":
        this.subagentStates.set(ev.toolCallId, {
          toolCallId: ev.toolCallId,
          role: ev.role,
          background: ev.background,
          turnCount: 0,
          activeTools: [],
          status: "running",
        });
        break;
      case "tool_use":
        if (existing) {
          existing.activeTools = [
            ...existing.activeTools.filter((tool) => tool.toolId !== ev.toolId),
            { toolId: ev.toolId, toolName: ev.toolName },
          ];
        }
        break;
      case "tool_result":
        if (existing) {
          existing.activeTools = existing.activeTools.filter(
            (tool) => tool.toolId !== ev.toolId,
          );
        }
        break;
      case "turn_complete":
        if (existing) {
          existing.turnCount += 1;
          existing.activeTools = [];
        }
        break;
      case "finished":
        if (existing) {
          existing.status = ev.status;
          existing.activeTools = [];
        } else {
          this.subagentStates.set(ev.toolCallId, {
            toolCallId: ev.toolCallId,
            role: ev.role,
            background: ev.background,
            turnCount: 0,
            activeTools: [],
            status: ev.status,
          });
        }
        break;
    }
    this.broadcastSubagents();
  }

  private broadcastSubagents(): void {
    this.broadcast({
      type: "subagents",
      data: {
        list: [...this.subagentStates.values()].map((entry) => ({
          ...entry,
          activeTools: [...entry.activeTools],
        })),
      },
    });
  }

  /**
   * Wires the live activity feeds the terminal gets from its hooks: the task
   * board (todo progress), background tasks, teammate states, and the idle
   * notification wakeup that drains pending task notifications.
   */
  private attachActivityBridge(handle: AgentRuntime): void {
    if (this.activityAttached) {
      return;
    }
    this.activityAttached = true;
    subscribeLeaderTasks(
      handle.teamManager,
      handle.taskList,
      (tasks, boardId) => {
        this.broadcast({
          type: "todo_update",
          data: {
            boardId,
            tasks: tasks.map((task) => ({
              id: task.id,
              subject: task.subject,
              status: task.status,
            })),
          },
        });
      },
    );
    handle.backgroundTaskManager.subscribe((tasks) => {
      this.broadcast({
        type: "background_tasks",
        data: {
          list: tasks.map((task) => ({
            id: task.id,
            name: task.name,
            kind: task.kind ?? "agent",
            status: task.status,
          })),
        },
      });
    });
    this.teammateTimer = setInterval(() => {
      const current = this.agentHandle;
      if (!current) {
        return;
      }
      const states = current.teamManager.getAllTeammateStates();
      const signature = JSON.stringify(states);
      if (signature === this.teammateSignature) {
        return;
      }
      this.teammateSignature = signature;
      this.broadcast({
        type: "teammates",
        data: {
          list: states.map((state) => ({
            name: state.name,
            teamName: state.teamName,
            status: state.status,
            spinnerVerb: state.spinnerVerb,
            lastMessage: state.lastMessage ?? null,
            turnCount: state.progress.turnCount,
            toolUseCount: state.progress.toolUseCount,
            tokenCount: state.progress.tokenCount,
            activeTools: state.progress.activeTools.map((tool) => ({
              toolId: tool.toolId,
              toolName: tool.toolName,
            })),
          })),
        },
      });
    }, TEAMMATE_POLL_INTERVAL_MS);
    this.teammateTimer.unref();
    this.wakeupTimer = setInterval(() => {
      const current = this.agentHandle;
      if (!current || this.streaming || this.followUps.length > 0) {
        return;
      }
      if (
        current.teamManager.hasLeaderNotifications() ||
        current.backgroundTaskManager.hasNotifications()
      ) {
        void this.runNotificationTurn();
      }
    }, WAKEUP_POLL_INTERVAL_MS);
    this.wakeupTimer.unref();
  }

  /** Builds a CommandContext for slash command execution. */
  private buildCommandContext(args: string): CommandContext {
    const handle = this.agentHandle;
    if (!handle) {
      return { cwd: cwd(), args, model: "" };
    }
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
      thinkingLevel: () =>
        handle.client.getThinkingLevel?.() ??
        handle.provider.thinking ??
        DEFAULT_THINKING_LEVEL,
      availableThinkingLevels: () =>
        handle.client.getSupportedThinkingLevels?.() ??
        getSupportedThinkingLevels(handle.provider),
      setThinkingLevel: handle.client.setThinkingLevel
        ? (level) => {
            handle.setThinking(level);
            this.persistRuntimeState();
          }
        : undefined,
      persistThinkingLevel: (level) => {
        persistThinkingLevel(handle.provider.base_url, level);
      },
    };
  }

  /** Handles /compact command: force context compaction. */
  private async handleCompact(customInstructions = ""): Promise<void> {
    if (!this.agentHandle) {
      return;
    }
    const handle = this.agentHandle;
    const controller = new AbortController();
    this.compactController = controller;

    this.broadcast({
      type: "system",
      data: { message: "Compacting conversation..." },
    });

    try {
      const protocol = handle.client.protocol ?? "anthropic";
      const toolFilter = composeAgentToolFilter(
        handle.enableCoordinatorMode,
        handle.toolFilter,
      );
      const toolNames = handle.registry.listVisibleToolNames(
        protocol,
        toolFilter,
      );
      const toolSchemas = handle.registry.getAllSchemas(protocol, toolFilter);
      const result = await forceCompact(
        handle.conv,
        handle.client,
        handle.recoveryState,
        toolNames,
        toolSchemas,
        getSessionFilePath(handle.cwd, handle.sessionId),
        controller.signal,
        customInstructions,
      );
      this.broadcast({
        type: "system",
        data: { message: `Compacted: ${result.message}` },
      });
      if (result.boundary) {
        saveCompactBoundary(handle.cwd, handle.sessionId, result.boundary);
      }
    } catch (err) {
      this.broadcast({
        type: "error",
        data: { message: asErrorString(err) },
      });
    } finally {
      this.compactController = null;
      this.broadcast({ type: "command_done", data: null });
    }
  }

  /** Usage snapshot with live context-window occupancy (terminal footer parity). */
  private usagePayload(): {
    inputTokens: number;
    outputTokens: number;
    contextTokens: number;
    contextWindow: number;
  } {
    const handle = this.agentHandle;
    return {
      inputTokens: this.lastUsage.inputTokens,
      outputTokens: this.lastUsage.outputTokens,
      contextTokens: handle ? currentContextTokens(handle.conv) : 0,
      contextWindow: handle?.contextWindow ?? 0,
    };
  }

  private sendUsageSnapshot(ws: WebSocket): void {
    if (!this.agentHandle) {
      return;
    }
    this.send(ws, { type: "usage", data: this.usagePayload() });
  }

  /** Builds the status snapshot message, or null before the agent exists. */
  private statusPayload(): WsOutbound | null {
    const handle = this.agentHandle;
    if (!handle) {
      return null;
    }
    return {
      type: "status",
      data: {
        model: handle.provider.model,
        provider: handle.provider.name,
        permissionMode: handle.permissionMode,
        thinkingLevel:
          handle.client.getThinkingLevel?.() ??
          handle.provider.thinking ??
          DEFAULT_THINKING_LEVEL,
        thinkingLevels: [
          ...(handle.client.getSupportedThinkingLevels?.() ??
            getSupportedThinkingLevels(handle.provider)),
        ],
        sandboxEnabled: handle.checker.sandboxEnabled,
        sandboxAutoAllow: handle.checker.sandboxAutoAllow,
        contextWindow: handle.contextWindow,
      },
    };
  }

  private broadcastRuntimeStatus(): void {
    if (this.agentHandle) {
      this.broadcast({
        type: "runtime_status",
        data: this.agentHandle.getStatus(),
      });
    }
  }

  /** Broadcasts the current model/mode/thinking snapshot to all clients. */
  private broadcastStatus(): void {
    const status = this.statusPayload();
    if (status) {
      this.broadcast(status);
      this.broadcastRuntimeStatus();
    }
  }

  private planApprovalMessage(id: string): WsOutbound {
    const handle = this.agentHandle;
    if (!handle) {
      return {
        type: "plan_approval_request",
        data: { id, planPath: "", planContent: "" },
      };
    }
    const planPath = getOrCreatePlanPath(handle);
    let planContent = "";
    try {
      if (existsSync(planPath)) {
        planContent = readFileSync(planPath, "utf-8");
      }
    } catch {
      /** noop */
    }
    return {
      type: "plan_approval_request",
      data: { id, planPath, planContent },
    };
  }

  private sendPlanApprovalRequest(ws: WebSocket): void {
    if (this.planApprovalId) {
      this.send(ws, this.planApprovalMessage(this.planApprovalId));
    }
  }

  private closePlanApproval(): void {
    const id = this.planApprovalId;
    this.planApprovalId = null;
    if (this.planApprovalTimer) {
      clearTimeout(this.planApprovalTimer);
      this.planApprovalTimer = null;
    }
    if (id) {
      this.broadcast({ type: "plan_approval_closed", data: { id } });
    }
  }

  private broadcastPlanApprovalRequest(): void {
    this.closePlanApproval();
    const id = nextRequestId("plan");
    this.planApprovalId = id;
    this.broadcast(this.planApprovalMessage(id));
    this.planApprovalTimer = setTimeout(() => {
      if (this.planApprovalId !== id) {
        return;
      }
      this.closePlanApproval();
      this.broadcast({
        type: "system",
        data: {
          message: `Plan approval expired after ${String(PENDING_REQUEST_TIMEOUT_MINUTES)} minutes.`,
        },
      });
    }, PENDING_REQUEST_TIMEOUT_MS);
    this.planApprovalTimer.unref();
  }

  /**
   * Mirrors the terminal UI plan approval: "yolo" auto-approves every edit,
   * "manual" restores the pre-plan mode, and "feedback" keeps planning.
   */
  private async handlePlanApprovalResponse(
    id: string,
    choice: "yolo" | "manual" | "feedback",
    feedback?: string,
  ): Promise<void> {
    const handle = this.agentHandle;
    if (!handle || this.planApprovalId !== id) {
      return;
    }
    this.closePlanApproval();

    if (choice === "feedback") {
      const text = feedback?.trim() ?? "";
      if (text) {
        await this.handleUserMessage(text);
      }
      return;
    }

    const planPath = getOrCreatePlanPath(handle);
    let planContent = "";
    try {
      if (existsSync(planPath)) {
        planContent = readFileSync(planPath, "utf-8");
      }
    } catch {
      /** noop */
    }

    this.hasExitedPlanMode = true;
    handle.checker.exitPlanMode(
      choice === "yolo" ? "bypassPermissions" : "default",
    );
    handle.conv.addSystemReminder(
      buildPlanModeExitReminder(planPath, !!planContent),
    );
    this.broadcastStatus();
    this.broadcast({
      type: "system",
      data: {
        message:
          choice === "yolo"
            ? "Plan approved. Entered YOLO mode."
            : "Plan approved. Each edit requires confirmation.",
      },
    });
    if (planContent) {
      const execution = buildPlanExecutionPrompt(planContent);
      if (this.streaming) {
        this.pendingPlanExecution = execution;
      } else {
        await this.handleUserMessage(execution);
      }
    }
  }

  /** Renders /memory output (parity with the terminal UI). */
  private buildMemoryStatus(args: string): string {
    const handle = this.agentHandle;
    if (!handle) {
      return "Memory is not available yet.";
    }
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

  private async handleMcpCommand(args: string): Promise<void> {
    const environment = this.environment;
    const runtime = this.agentHandle;
    const manager = runtime?.mcpManager;
    if (!environment || !runtime || !manager) {
      throw new Error("Agent is not initialized");
    }
    if (this.mcpController) {
      throw new Error("MCP operation is already running");
    }
    if (!this.mcpManagement || this.mcpManagementRuntime !== runtime) {
      this.mcpManagement = new MCPManagement(
        runtime,
        environment.manager,
        this.createPermissionCallback(),
      );
      this.mcpManagementRuntime = runtime;
    }
    const controller = new AbortController();
    this.mcpController = controller;
    try {
      const result = await executeMCPCommand(args, {
        management: this.mcpManagement,
        manager,
        askUser: this.createAskUserCallback(),
        signal: AbortSignal.any([
          controller.signal,
          this.initializationController.signal,
        ]),
      });
      if (this.environment === environment) {
        this.persistRuntimeState();
        this.broadcast({ type: "system", data: { message: result.message } });
        this.broadcastStatus();
      }
    } catch (error) {
      if (this.environment === environment) {
        this.broadcast({
          type: "error",
          data: { message: asErrorString(error) },
        });
      }
    } finally {
      if (this.mcpController === controller) {
        this.mcpController = null;
      }
    }
  }

  private buildMcpStatus(): string {
    const handle = this.agentHandle;
    const manager = handle?.mcpManager;
    if (!manager || !handle) {
      return "No MCP servers configured.";
    }
    return formatMCPStatus(manager);
  }

  /** Handles /resume command: resume a previous session. */
  private async handleResume(args: string): Promise<void> {
    if (!this.agentHandle) {
      return;
    }
    const handle = this.agentHandle;
    const command = parseSessionResumeCommand(args);
    if (command.action === "picker") {
      const sessions = filterSessions(listAllSessions(), {
        cwd: handle.cwd,
        allProjects: command.allProjects,
        includeArchived: command.includeArchived,
        query: command.query,
      });
      if (sessions.length === 0) {
        this.broadcast({
          type: "system",
          data: { message: "No previous sessions found." },
        });
        this.broadcast({ type: "command_done", data: null });
        return;
      }

      this.broadcast({
        type: "session_list",
        data: {
          sessions: sessions.slice(0, SESSION_LIST_LIMIT).map((sess) => ({
            id: sess.id,
            cwd: sess.cwd,
            projectKey: sess.projectKey,
            name: sess.metadata.name ?? null,
            tags: sess.metadata.tags ?? [],
            archived: sess.metadata.archived === true,
            firstMessage: sess.firstMessage,
            messageCount: sess.messageCount,
            lastUserMessageTime:
              sess.lastUserMessageTime?.toISOString() ?? null,
          })),
        },
      });
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    const cwd = canonicalPath(command.target.cwd ?? handle.cwd);
    const sessions = listSessions(cwd);
    let targetId = command.target.id;
    const idx = /^\d+$/.test(targetId) ? Number(targetId) : NaN;
    if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      targetId = sessions[idx - 1].id;
    }

    const controller = new AbortController();
    this.treeController = controller;
    const signal = AbortSignal.any([
      controller.signal,
      this.initializationController.signal,
    ]);
    try {
      const source = SessionManager.open(cwd, targetId);
      const prepared = await requestSessionRestoration(
        source,
        handle.cwd,
        this.createAskUserCallback(),
        {
          destination: command.target.destination,
          copy: command.target.copy,
          signal,
        },
      );
      if (!prepared) {
        this.broadcast({
          type: "system",
          data: { message: "Session restoration canceled; source preserved." },
        });
        return;
      }
      await prepared.assertCurrent(signal);
      const manager = prepared.copy
        ? await SessionManager.importStream(
            prepared.destination,
            source.exportStream({ scope: "tree", format: "jsonl", signal }),
            { signal },
          )
        : source;
      await this.replaceEnvironment(manager, false, signal);
      this.subagentStates.clear();
      this.broadcastSubagents();
      this.broadcast({
        type: "system",
        data: {
          message: `Session ${manager.id} restored (${String(manager.getMessages().length)} messages).`,
        },
      });
    } finally {
      if (this.treeController === controller) {
        this.treeController = null;
      }
      this.broadcast({ type: "command_done", data: null });
    }
  }

  /** Creates the askUser callback closure for createAgentRuntime. */
  private createAskUserCallback(): Asker {
    return async (
      questions: Question[],
      signal?: AbortSignal,
    ): Promise<Record<string, string>> => {
      if (signal?.aborted || this.stopping) {
        return {};
      }
      const id = nextRequestId("ask");
      const payload = { id, questions };
      this.pendingAskPayloads.set(id, payload);
      this.broadcast({ type: "ask_user", data: payload });
      return new Promise((resolve) => {
        const cancel = () => {
          const pending = this.pendingAsks.get(id);
          if (this.pendingAsks.delete(id) && pending) {
            pending({});
            this.broadcast({
              type: "request_expired",
              data: { id, kind: "ask" },
            });
          }
        };
        const timer = setTimeout(() => {
          if (this.pendingAsks.delete(id)) {
            signal?.removeEventListener("abort", cancel);
            this.pendingAskPayloads.delete(id);
            this.broadcast({
              type: "system",
              data: {
                message: `Question timed out after ${String(PENDING_REQUEST_TIMEOUT_MINUTES)} minutes with no answer; continuing with empty answers.`,
              },
            });
            this.broadcast({
              type: "request_expired",
              data: { id, kind: "ask" },
            });
            resolve({});
          }
        }, PENDING_REQUEST_TIMEOUT_MS);
        timer.unref();
        this.pendingAsks.set(id, (answers) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          this.pendingAskPayloads.delete(id);
          resolve(answers);
        });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
        }
      });
    };
  }

  /** Creates the onPermissionRequest callback for agent runs. */
  private createPermissionCallback(): RunCallbacks["onPermissionRequest"] {
    return async (
      toolName: string,
      args: Record<string, unknown>,
      decision: Decision,
      _toolCallId: string,
      signal?: AbortSignal,
      source?: { agentName: string; cwd: string },
    ): Promise<"allow" | "deny" | "allowAlways"> => {
      const id = nextRequestId("perm");
      const desc = [
        source ? `${source.agentName} · ${source.cwd}` : "",
        formatPermissionDesc(args, decision),
      ]
        .filter(Boolean)
        .join("\n");
      const payload = {
        id,
        toolName,
        description: desc,
        rememberPatterns: decision.rememberPatterns,
      };
      this.pendingPermissionPayloads.set(id, payload);
      this.broadcast({ type: "permission_request", data: payload });
      return new Promise((resolve) => {
        const cancel = () => {
          const pending = this.pendingPermissions.get(id);
          if (this.pendingPermissions.delete(id) && pending) {
            this.pendingPermissionPayloads.delete(id);
            this.broadcast({
              type: "request_expired",
              data: { id, kind: "permission" },
            });
            pending("deny");
          }
        };
        const timer = setTimeout(() => {
          if (this.pendingPermissions.delete(id)) {
            this.pendingPermissionPayloads.delete(id);
            this.broadcast({
              type: "system",
              data: {
                message: `Permission request timed out after ${String(PENDING_REQUEST_TIMEOUT_MINUTES)} minutes with no response; denying automatically.`,
              },
            });
            this.broadcast({
              type: "request_expired",
              data: { id, kind: "permission" },
            });
            resolve("deny");
            signal?.removeEventListener("abort", cancel);
          }
        }, PENDING_REQUEST_TIMEOUT_MS);
        timer.unref();
        this.pendingPermissions.set(id, (response) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          this.pendingPermissionPayloads.delete(id);
          resolve(response);
        });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
        }
      });
    };
  }

  /** Builds the slash command list for the frontend's autocomplete. */
  private buildCommandList(): { name: string; description: string }[] {
    if (!this.agentHandle) {
      // Fallback: return default commands before agent init
      const defaultReg = createCommandRegistry();
      return defaultReg.listCommands().map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
      }));
    }
    return this.agentHandle.cmdRegistry.listCommands().map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));
  }

  /** Sends a JSON message to a single WebSocket client. */
  private send(ws: WebSocket, msg: WsOutbound): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // Send failure: connection will be cleaned up on close
      }
    }
  }

  /** Broadcasts a message to all connected WebSocket clients. */
  private broadcast(msg: WsOutbound): void {
    if (msg.type === "clear") {
      this.mcpApps.clear();
    }
    if (msg.type === "tool_result" && this.agentHandle) {
      const payload = McpAppToolResultSchema.safeParse(msg.data);
      if (payload.success) {
        this.mcpApps.register(payload.data, this.agentHandle);
      }
    }
    if (this.clients.size === 0) {
      return;
    }
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          // Send failure: connection will be cleaned up on close
        }
      }
    }
  }

  /**
   * Starts the Express HTTP + WebSocket server and blocks until stop() is called.
   * Initializing the agent handle happens eagerly; failures fall back to lazy
   * init on first message. The actual bound address is announced once listening
   * so an ephemeral (port 0) binding reports a reachable URL. Blocking here
   * (instead of resolving once listening) keeps the caller's exit bookkeeping
   * after the server is actually down.
   */
  async run(): Promise<void> {
    const { host, port } = parseRemoteAddress(this.opts.addr, {
      allowEphemeral: true,
    });
    const stopped = new Promise<void>((resolve) => {
      this.stoppedResolve = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(port, host, () => {
        this.startHeartbeat();
        this.announceListening();
        resolve();
      });
    });
    await stopped;
  }

  /**
   * Reports the actual bound address. Essential for port 0 (ephemeral)
   * bindings, where the OS-assigned port is only known after listen() succeeds.
   * Written to stderr to match --a2a and to keep the stdout-mirrored
   * JSONL log stream clean.
   */
  private announceListening(): void {
    const bound = this.server.address();
    if (!bound || typeof bound === "string") {
      return;
    }
    const displayHost =
      bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
    process.stderr.write(
      `Remote server listening at http://${displayHost}:${String(bound.port)}/#token=${encodeURIComponent(this.accessToken)}\n`,
    );
  }

  /**
   * Stops the server and cleans up every child resource: closes WS/HTTP,
   * cancels the active run, and — unlike the fire-and-forget abort() — awaits
   * the background-task and team stopAlls plus the MCP disconnects, so
   * detached shells, teammates, and stdio server children do not outlive the
   * process.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.mcpApps.clear();
    this.followUps = [];
    this.pendingPlanExecution = null;
    this.cancelActiveRun();
    this.initializationController.abort();
    const handleDisposal = this.agentHandle?.dispose();
    await this.environment?.project.dispose();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.teammateTimer) {
      clearInterval(this.teammateTimer);
      this.teammateTimer = null;
    }
    if (this.wakeupTimer) {
      clearInterval(this.wakeupTimer);
      this.wakeupTimer = null;
    }
    this.modelListController?.abort();
    this.modelListController = null;
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    if (this.agentHandle) {
      await handleDisposal;
      try {
        await this.disposeSandbox();
      } catch (error) {
        log.error({ error }, "remote sandbox cleanup failed");
      }
    }
    const resolveStopped = this.stoppedResolve;
    this.stoppedResolve = null;
    resolveStopped?.();
  }

  private cancelActiveRun(): void {
    this.runCanceled = true;
    this.closePlanApproval();
    this.agentHandle?.abort();
    this.treeController?.abort();
    this.compactController?.abort();
    this.mcpController?.abort();
    this.userBashController?.abort();
    this.subagentController?.abort();
    // Aborting a provider cannot settle promises owned by the WebSocket UI.
    for (const [id, resolve] of this.pendingPermissions) {
      resolve("deny");
      this.broadcast({
        type: "request_expired",
        data: { id, kind: "permission" },
      });
    }
    this.pendingPermissions.clear();
    this.pendingPermissionPayloads.clear();
    for (const [id, resolve] of this.pendingAsks) {
      resolve({});
      this.broadcast({ type: "request_expired", data: { id, kind: "ask" } });
    }
    this.pendingAsks.clear();
    this.pendingAskPayloads.clear();
  }
}
