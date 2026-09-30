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

// Remote server: Koa.js HTTP + WebSocket bridge for browser-based access.
// Serves the React frontend (fe/dist/) and bridges Agent events to WS.

import { readFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname, normalize } from "node:path";
import { cwd } from "node:process";

import Koa from "koa";
import { WebSocketServer, WebSocket } from "ws";
import z from "zod";

import { parseRemoteAddress } from "./address.js";
import { AgentEventLogger } from "./log.js";
import { restoreRemoteSession } from "./session-state.js";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import { countMcpTools } from "@/bootstrap/tool-registry.js";
import { formatReviewReport } from "@/code-review/report.js";
import { runCodeReview, validateReviewInput } from "@/code-review/runner.js";
import {
  parse as parseCommand,
  createDefaultRegistry as createCommandRegistry,
  type CommandRegistry,
  type CommandContext,
} from "@/commands/commands.js";
import { loadUserCommands } from "@/commands/loader.js";
import { forceCompact } from "@/compact/compact.js";
import { RecoveryState } from "@/compact/recovery.js";
import type { HookConfig, MCPServerConfig } from "@/config/index.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import {
  DEFAULT_THINKING_LEVEL,
  getContextWindow,
  getMaxOutputTokens,
  getSupportedThinkingLevels,
  resolveDefaultProvider,
} from "@/config/provider-config.js";
import { persistThinkingLevel } from "@/config/provider-login.js";
import { ConversationManager } from "@/conversation/index.js";
import { FileHistory } from "@/file-history/index.js";
import { HookEngine, validate as validateHooks } from "@/hooks/index.js";
import { createClient, type LLMClient } from "@/llm/client.js";
import { createChildLogger } from "@/logger/index.js";
import { syncMcpInstructions as announceMcpInstructions } from "@/mcp/instructions.js";
import { MCPManager } from "@/mcp/manager.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { MCPToolWrapper } from "@/mcp/tool-wrapper.js";
import { MemoryConsolidator } from "@/memory/consolidation.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { loadInstructions } from "@/memory/instructions.js";
import { MemoryManager } from "@/memory/manager.js";
import {
  PermissionChecker,
  type Decision,
  type PermissionMode,
} from "@/permissions/index.js";
import { getOrCreatePlanPath, planExists } from "@/plan-file/index.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import {
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
} from "@/prompt/plan-mode.js";
import {
  newSessionId,
  saveMessage,
  saveCompactBoundary,
  listSessions,
  loadSession,
  getSessionFilePath,
  touchSession,
} from "@/session/index.js";
import { SkillCatalog, buildSkillSection } from "@/skills/catalog.js";
import { runInline as runSkillInline } from "@/skills/executor.js";
import type { SkillForkHost, SkillHost } from "@/skills/index.js";
import { LoadSkillTool } from "@/skills/load-skill-tool.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import { BUILTIN_AGENTS } from "@/subagent/definition.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import {
  TaskManager,
  formatAgentTaskNotification,
} from "@/subagent/task-manager.js";
import {
  coordinatorToolFilter,
  coordinatorActive,
} from "@/teams/coordinator.js";
import { TeamManager, type RunAgent } from "@/teams/index.js";
import { TaskStopTool } from "@/teams/task-stop.js";
import {
  TeamCreateTool,
  SendMessageTool,
  TeamDeleteTool,
} from "@/teams/tools.js";
import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
} from "@/todo/tools.js";
import {
  AskUserQuestionTool,
  type Question,
  type Asker,
} from "@/tools/ask-user.js";
import { BashTool } from "@/tools/bash.js";
import { ComputerUseTool } from "@/tools/computer-use.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { EnterWorktreeTool } from "@/tools/enter-worktree.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { ExitWorktreeTool } from "@/tools/exit-worktree.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { GlobTool } from "@/tools/glob.js";
import { GrepTool } from "@/tools/grep.js";
import { McpCallTool } from "@/tools/mcp-call.js";
import { PowerShellTool } from "@/tools/powershell.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { ToolRegistry } from "@/tools/registry.js";
import { attachBackgroundTaskManager } from "@/tools/shell-background.js";
import { SyntheticOutputTool } from "@/tools/synthetic-output.js";
import { ToolSearchTool } from "@/tools/tool-search.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { WriteFileTool } from "@/tools/write-file.js";
import { contentToText, strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "remote" });

// Monotonic request-id counter: Date.now() alone collides when two requests
// land in the same millisecond (e.g. concurrent subagents), which would
// overwrite the first request's resolver and hang its run forever.
let requestCounter = 0;
function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${String(requestCounter)}`;
}

// Permission/ask requests with no client response settle after this long, so
// a closed browser tab cannot pin the streaming slot (and the run) forever.
const PENDING_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const PENDING_REQUEST_TIMEOUT_MINUTES = 10;
// WS heartbeat: ping interval and the no-pong threshold that terminates a
// half-open connection.
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_STALE_MS = 75_000;

// -- WS inbound/outbound types and Zod schemas --------------------------------

interface WsOutbound {
  type: string;
  data: unknown;
}

const WsInboundSchema = z.object({
  type: z.string(),
  data: z.unknown(),
});

const UserMessageSchema = z.object({
  content: z.string(),
});

const PermissionResponseSchema = z.object({
  id: z.string(),
  response: z.enum(["allow", "deny", "allowAlways"]),
});

const AskUserResponseSchema = z.object({
  id: z.string(),
  answers: z.record(z.string(), z.string()),
});

const PlanApprovalResponseSchema = z.object({
  choice: z.enum(["yolo", "manual", "feedback"]),
  feedback: z.string().optional(),
});

const CodeReviewStartSchema = z.object({
  background: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  commit: z.string().optional(),
  excludePatterns: z.array(z.string()).optional(),
});

// -- Static file serving -------------------------------------------------------

const FE_DIST = [
  join(import.meta.dirname, "fe", "dist"),
  join(import.meta.dirname, "..", "fe", "dist"),
].find((directory) => existsSync(directory));

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Serves a static file from fe/dist/. Returns null if not found. */
function serveStatic(path: string): { body: Buffer; mime: string } | null {
  if (!FE_DIST) {
    return null;
  }
  // Normalize and prevent path traversal
  const cleanPath = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const fullPath = join(FE_DIST, cleanPath);

  // Ensure the resolved path is still under FE_DIST
  if (!fullPath.startsWith(FE_DIST)) {
    return null;
  }

  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    return null;
  }

  const body = readFileSync(fullPath);
  const mime = MIME_TYPES[extname(fullPath)] ?? "application/octet-stream";
  return { body, mime };
}

// -- RemoteAgentHandle interface -----------------------------------------------

/** Callback injected into each agent run for the permission-request flow. */
export interface RunCallbacks {
  onPermissionRequest: PermissionRequestHandler;
}

/** Encapsulates ALL agent state needed by the remote server. */
export interface RemoteAgentHandle {
  client: LLMClient;
  conv: ConversationManager;
  registry: ToolRegistry;
  sessionId: string;
  fileHistory: FileHistory;
  fileStateCache: FileStateCache;
  cmdRegistry: CommandRegistry;
  skillCatalog: SkillCatalog | null;
  activeSkills: Map<string, string>;
  toolFilter: ((name: string) => boolean) | null;
  mcpManager: MCPManager | null;
  hookEngine: HookEngine | null;
  recoveryState: RecoveryState;
  teamManager: TeamManager;
  backgroundTaskManager: TaskManager;
  enableCoordinatorMode: boolean;
  forkDisabled: boolean;
  memoryManager: MemoryManager;
  /** Auto memory switch from config.yaml (`enable_memory:`); gates injection, extraction, and consolidation. */
  memoryEnabled: boolean;
  contextWindow: number;
  longTermMemoryInstructions: string;
  longTermMemoryMemoryContent: string;
  provider: ProviderConfig;
  workDir: string;
  /** Current permission mode; plan mode is enforced through the run() checker. */
  permissionMode: PermissionMode;
  /** Shared task board; /clear and /resume swap its store to the target session. */
  taskList: TaskList;

  /** Runs the agent loop: adds the user message, creates Agent, and yields events. */
  run(text: string, callbacks: RunCallbacks): AsyncGenerator<AgentEvent>;

  /** Aborts the currently running agent loop (if any) and stops all background tasks and teammates. */
  abort(): void;

  /**
   * Queues a steering message for the in-flight agent run. Returns false when
   * no run is active, so callers can surface a "busy" hint instead.
   */
  steer(text: string): boolean;

  /** Takes steering messages queued too late for in-run delivery. */
  takeSteeringLeftovers(): string[];

  /**
   * Resets the conversation for /clear. The manager is reset in place —
   * AgentTool captured it for its fork path, so swapping the instance would
   * strand the fork on the discarded history — and every piece of
   * session-scoped state (session id, file history, task board, recovery
   * state, MCP announcements) rotates with it.
   */
  clearConversation(): void;
}

// -- Agent handle implementation -----------------------------------------------

function composeAgentToolFilter(
  enableCoordinatorMode: boolean,
  handleFilter: ((name: string) => boolean) | null,
): (name: string) => boolean {
  const coordinatorFilter = coordinatorToolFilter(enableCoordinatorMode);
  return (name) => coordinatorFilter(name) && (handleFilter?.(name) ?? true);
}

class AgentHandleImpl implements RemoteAgentHandle {
  client: LLMClient;
  conv: ConversationManager;
  registry: ToolRegistry;
  sessionId: string;
  fileHistory: FileHistory;
  fileStateCache: FileStateCache;
  cmdRegistry: CommandRegistry;
  skillCatalog: SkillCatalog | null;
  activeSkills: Map<string, string>;
  toolFilter: ((name: string) => boolean) | null;
  mcpManager: MCPManager | null;
  hookEngine: HookEngine | null;
  recoveryState: RecoveryState;
  teamManager: TeamManager;
  backgroundTaskManager: TaskManager;
  enableCoordinatorMode: boolean;
  forkDisabled: boolean;
  memoryManager: MemoryManager;
  memoryEnabled: boolean;
  contextWindow: number;
  longTermMemoryInstructions: string;
  longTermMemoryMemoryContent: string;
  provider: ProviderConfig;
  workDir: string;
  permissionMode: PermissionMode = "default";
  /** Shared task board; /clear and /resume swap its store to the target session. */
  taskList: TaskList;

  // Servers whose instructions this conversation has already been told about. The
  // remote handle connects MCP once and never reloads it, so nothing is ever
  // retracted here; the record keeps later runs from repeating the guidance, and
  // history decides whether it has to be replayed (compaction, session restore).
  private mcpAnnounced = new Set<string>();

  // One consolidator per handle: a fresh instance per loop would reset the
  // lastScanAt throttle, hammering the lock on every loop_complete.
  private memoryConsolidator: MemoryConsolidator | null = null;

  private abortController: AbortController | null = null;
  /** Agent of the current or most recent run; used for mid-run steering and post-run leftover draining. */
  private currentAgent: Agent | null = null;

  constructor(
    agentHandleImpl: Omit<
      AgentHandleImpl,
      | "abortController"
      | "run"
      | "abort"
      | "steer"
      | "takeSteeringLeftovers"
      | "clearConversation"
      | "permissionMode"
    >,
  ) {
    this.client = agentHandleImpl.client;
    this.conv = agentHandleImpl.conv;
    this.registry = agentHandleImpl.registry;
    this.sessionId = agentHandleImpl.sessionId;
    this.fileHistory = agentHandleImpl.fileHistory;
    this.fileStateCache = agentHandleImpl.fileStateCache;
    this.cmdRegistry = agentHandleImpl.cmdRegistry;
    this.skillCatalog = agentHandleImpl.skillCatalog;
    this.activeSkills = agentHandleImpl.activeSkills;
    this.toolFilter = agentHandleImpl.toolFilter;
    this.mcpManager = agentHandleImpl.mcpManager;
    this.hookEngine = agentHandleImpl.hookEngine;
    this.recoveryState = agentHandleImpl.recoveryState;
    this.teamManager = agentHandleImpl.teamManager;
    this.backgroundTaskManager = agentHandleImpl.backgroundTaskManager;
    this.enableCoordinatorMode = agentHandleImpl.enableCoordinatorMode;
    this.forkDisabled = agentHandleImpl.forkDisabled;
    this.memoryManager = agentHandleImpl.memoryManager;
    this.memoryEnabled = agentHandleImpl.memoryEnabled;
    this.contextWindow = agentHandleImpl.contextWindow;
    this.longTermMemoryInstructions =
      agentHandleImpl.longTermMemoryInstructions;
    this.longTermMemoryMemoryContent =
      agentHandleImpl.longTermMemoryMemoryContent;
    this.provider = agentHandleImpl.provider;
    this.workDir = agentHandleImpl.workDir;
    this.taskList = agentHandleImpl.taskList;
    this.abortController = null;
  }

  async *run(
    text: string,
    callbacks: RunCallbacks,
  ): AsyncGenerator<AgentEvent> {
    this.conv.addUserMessage(text);

    // Announce the instructions of every connected MCP server this conversation has
    // not seen yet. Nothing goes out while the announcement is still in history, and
    // it is replayed once that history no longer holds it.
    if (this.mcpManager) {
      announceMcpInstructions(this.conv, this.mcpAnnounced, this.mcpManager);
    }

    this.abortController = new AbortController();

    try {
      const checker = new PermissionChecker(this.workDir, this.permissionMode);
      const agent = new Agent({
        client: this.client,
        registry: this.registry,
        checker,
        conversation: this.conv,
        workDir: this.workDir,
        sessionId: this.sessionId,
        hookEngine: this.hookEngine ?? undefined,
        fileHistory: this.fileHistory ?? undefined,
        fileStateCache: this.fileStateCache,
        abortSignal: this.abortController.signal,
        contextWindow: this.contextWindow,
        maxOutput: getMaxOutputTokens(this.provider),
        recoveryState: this.recoveryState,
        activeSkills: this.activeSkills,
        // Coordinator narrowing and any handle-level restriction compose into
        // one predicate shared with manual compaction's tool attachment.
        toolFilter: composeAgentToolFilter(
          this.enableCoordinatorMode,
          this.toolFilter,
        ),
        coordinatorActiveFn: () =>
          coordinatorActive(this.enableCoordinatorMode),
        instructions: this.longTermMemoryInstructions,
        memoryContent: this.longTermMemoryMemoryContent,
        skillSection: this.skillCatalog
          ? buildSkillSection(this.skillCatalog, this.workDir)
          : "",
        skillDeltaFn: () => {
          const section = this.skillCatalog
            ? buildSkillSection(this.skillCatalog, this.workDir)
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
          // enable_memory: false disables the whole background memory pipeline
          if (!this.memoryEnabled) {
            return;
          }
          // Best-effort memory extraction (fire-and-forget)
          const summary = conv
            .getMessages()
            .slice(-40)
            .map((m) => `[${m.role}]: ${contentToText(m.content)}`)
            .filter((s) => s.length > 12)
            .join("\n");
          new MemoryExtractor(this.client, this.workDir)
            .extract(summary)
            .catch(() => {
              /* non-fatal */
            });

          // Background memory consolidation (fire-and-forget)
          this.memoryConsolidator ??= new MemoryConsolidator(
            this.client,
            this.workDir,
            {
              appendSystem: (msg) => {
                this.conv.addSystemReminder(msg);
              },
            },
          );
          this.memoryConsolidator.maybeRun().catch(() => {
            /* non-fatal */
          });
        },
      });

      this.currentAgent = agent;
      yield* agent.run();
    } finally {
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
    void this.backgroundTaskManager.stopAll();
    void this.teamManager.stopAll();
  }

  steer(text: string): boolean {
    if (!this.abortController || !this.currentAgent) {
      return false;
    }
    this.currentAgent.steer(text);
    return true;
  }

  takeSteeringLeftovers(): string[] {
    return this.currentAgent?.drainSteering() ?? [];
  }

  clearConversation(): void {
    // Reset in place: AgentTool holds this manager for its fork path, so
    // replacing the instance would leave forks inheriting cleared history.
    this.conv.reset();
    this.activeSkills.clear();
    this.sessionId = newSessionId();
    this.fileHistory = new FileHistory(this.workDir, this.sessionId);
    this.taskList.useStore(new TaskStore(this.workDir, this.sessionId));
    this.recoveryState = new RecoveryState();
    this.mcpAnnounced.clear();
  }
}

// -- createRemoteAgent factory -------------------------------------------------

export interface CreateRemoteAgentOptions {
  provider: ProviderConfig;
  workDir: string;
  hooks?: HookConfig[];
  mcpServers?: MCPServerConfig[];
  enableCoordinatorMode: boolean;
  forkDisabled: boolean;
  /** Auto memory switch from config.yaml (`enable_memory:`); defaults to true. */
  memoryEnabled?: boolean;
  askUser?: Asker;
  sessionId?: string;
}

/**
 * Initializes the full agent stack: tools, LLM client, conversation, session,
 * skills, hooks, MCP servers, team management, and memory.
 */
export async function createRemoteAgent(
  opts: CreateRemoteAgentOptions,
): Promise<RemoteAgentHandle> {
  const {
    provider,
    workDir,
    hooks: hookConfigs,
    mcpServers: mcpConfigs,
    enableCoordinatorMode,
    forkDisabled,
    memoryEnabled = true,
    askUser,
    sessionId = newSessionId(),
  } = opts;

  const hookErr = validateHooks(hookConfigs ?? []);
  if (hookErr) {
    throw hookErr;
  }

  // 1. Create the per-session file history and file-state cache
  // (the session id itself is chosen above; the session file is written lazily)
  const fileHistory = new FileHistory(workDir, sessionId);
  const fileStateCache = new FileStateCache();

  // 2. Build tool registry with all built-in tools
  const { registry, taskList } = buildToolRegistry(workDir, sessionId);

  // 3. Build system prompt
  const env = detectEnvironment(workDir);
  env.model = provider.model;
  const systemPrompt = buildSystemPrompt(env);

  // 4. Create LLM client
  const client = await createClient(provider, systemPrompt);

  // 5. Create conversation manager
  const conv = new ConversationManager();

  const contextWindow = getContextWindow(provider);

  // 6. Load instructions and memory, inject into conversation
  const instructions = loadInstructions(workDir);
  const memoryManager = new MemoryManager(workDir);
  // enable_memory: false keeps the index out of the conversation and nothing
  // is injected, extracted, or consolidated automatically; /memory only
  // reports that auto memory is disabled (the manager object is kept so the
  // handle shape is uniform).
  const memReminder = memoryEnabled ? memoryManager.buildSystemReminder() : "";
  conv.injectLongTermMemory(instructions, memReminder);

  // 7. Initialize hooks
  const hookEngine = new HookEngine(hookConfigs ?? []);

  // 8. Load skills
  const catalog = new SkillCatalog();
  catalog.load(workDir);

  // 9. SkillHost interface
  const activeSkills = new Map<string, string>();
  const skillHost: SkillHost = {
    activateSkill: (name, body) => {
      activeSkills.set(name, body);
    },
  };

  // Fork-mode host: Skills declaring mode: fork run in an isolated sub-agent;
  // the SOP body only appears in the sub-agent's conversation — the main conversation receives the final result
  const skillForkHost: SkillForkHost = {
    // SkillHost declares activateSkill as a method, so @typescript-eslint/unbound-method
    // requires an explicit bind when it is detached. The runtime implementation above is
    // an arrow function closing over `activeSkills`, so the bind itself is a no-op.
    activateSkill: skillHost.activateSkill.bind(skillHost),
    snapshotParentMessages: (count: number) => {
      const msgs = conv?.getMessages() ?? [];
      return msgs
        .slice(-count)
        .map((m) => `${m.role}: ${contentToText(m.content)}`)
        .join("\n");
    },
    runSubagent: (prompt: string, abortSignal?: AbortSignal) =>
      spawnSubagent(
        BUILTIN_AGENTS[0],
        prompt,
        client,
        registry,
        provider,
        workDir,
        undefined,
        undefined,
        undefined,
        new PermissionChecker(workDir, "acceptEdits"),
        { abortSignal, background: false },
      ),
  };

  // 10. Register LoadSkill tool
  registry.register(new LoadSkillTool(catalog, skillHost, skillForkHost));

  // 11. Register AskUserQuestion tool when the host supports interactive questions
  if (askUser) {
    registry.register(new AskUserQuestionTool(askUser));
  }

  // Register team-related tools. teamRunAgentFactory receives a teammate-scoped
  // registry (with shared task-board tools injected) and returns the callback
  // that runs the teammate agent's main loop.
  const teamRunAgentFactory =
    (
      registry: ToolRegistry,
      teamChecker?: PermissionChecker,
      memberWorkDir = workDir,
    ): RunAgent =>
    (task, onEvent, abortSignal) =>
      spawnSubagent(
        BUILTIN_AGENTS[0],
        task,
        client,
        registry,
        provider,
        memberWorkDir,
        undefined,
        onEvent,
        undefined,
        teamChecker,
        // Teammates stay purely foreground: see SubagentRunOptions.backgroundTasks.
        { abortSignal, backgroundTasks: false },
      );
  // 12. Register team tools (plus SyntheticOutput)
  const teamManager = new TeamManager(workDir);
  // Re-adopt any team left on disk (e.g. from a previous server run) so live
  // external teammates' notifications are drained and the UI sees them.
  teamManager.restoreFromDisk();
  const backgroundTaskManager = new TaskManager();
  // Share the background task registry with the command tools registered here
  // (Bash/PowerShell) so run_in_background and timeout auto-background deliver
  // results through the same notification drain as background agents.
  attachBackgroundTaskManager(registry, backgroundTaskManager);
  registry.register(new TeamCreateTool(teamManager));
  registry.register(new SendMessageTool(teamManager));
  registry.register(new TeamDeleteTool(teamManager));
  registry.register(new TaskStopTool(teamManager, backgroundTaskManager));
  registry.register(new SyntheticOutputTool());

  // 13. Register AgentTool (with both spawn and fork paths)
  const agentTool = new AgentTool(
    workDir,
    registry,
    async (
      def,
      prompt,
      background,
      modelOverride?,
      workDirOverride?,
      context?,
    ) => {
      return spawnSubagent(
        def,
        prompt,
        client,
        registry,
        provider,
        workDirOverride ?? workDir,
        undefined,
        undefined,
        modelOverride,
        workDirOverride
          ? context?.permissionChecker?.forWorkDir(workDirOverride)
          : context?.permissionChecker,
        {
          abortSignal: context?.abortSignal,
          background,
          onPermissionRequest: context?.onPermissionRequest,
          permissionMode: context?.permissionChecker?.mode,
        },
      );
    },
    conv,
    async (prompt, forkConv, forkRegistry, modelOverride?, context?) => {
      const forkWorkDir = context?.workDir ?? workDir;
      // Fork path: create an isolated agent on the forked conversation
      const resolvedModel = modelOverride ?? provider.model;
      const forkEnv = detectEnvironment(forkWorkDir);
      forkEnv.model = resolvedModel;
      const forkSystemPrompt = buildSystemPrompt(forkEnv);
      const forkClient = modelOverride
        ? await createClient(
            { ...provider, model: resolvedModel },
            forkSystemPrompt,
          )
        : client;

      const checker =
        context?.permissionChecker ??
        new PermissionChecker(forkWorkDir, "acceptEdits");
      forkConv.addUserMessage(prompt);

      // Per-run background task registry (parity with subagent/spawn.ts): the
      // fork registry shares tool instances with the host, so without this the
      // fork's backgrounded commands would register in the host-level manager
      // — the fork would never see their notifications and nothing would kill
      // its shells when it exits.
      const forkTaskManager = new TaskManager();

      const agent = new Agent({
        client: forkClient,
        registry: forkRegistry,
        checker,
        conversation: forkConv,
        workDir: forkWorkDir,
        maxIterations: 200,
        abortSignal: context?.abortSignal,
        onPermissionRequest: context?.onPermissionRequest,
        fileStateCache: new FileStateCache(),
        instructions,
        memoryContent: memReminder,
        taskManager: forkTaskManager,
        notificationFn: () =>
          forkTaskManager.drainNotifications().map(formatAgentTaskNotification),
      });

      let output = "";
      try {
        for await (const event of agent.run()) {
          switch (event.type) {
            case "stream_text":
              output += event.text;
              break;
            case "loop_complete":
              return output || "[No output]";
            case "error":
              return output
                ? `${output}\n\n[Error: ${event.error.message}]`
                : `Error: ${event.error.message}`;
          }
        }
        return output || "[No output]";
      } finally {
        await forkTaskManager.stopAll();
      }
    },
    backgroundTaskManager,
  );
  agentTool.forkDisabled = forkDisabled ?? false;
  // Wire the team manager into AgentTool so the team_name teammate path takes
  // effect (teammates receive shared team task-board tools). No provider index:
  // external teammates resolve `default_provider` from the config — the same
  // provider this server was started with.
  agentTool.setTeamManager(teamManager, teamRunAgentFactory);
  registry.register(agentTool);

  // 14. Load user-defined slash commands
  const cmdRegistry = createCommandRegistry();
  for (const cmd of loadUserCommands(workDir)) {
    try {
      cmdRegistry.register(cmd);
    } catch {
      // Name conflict: keep built-in command
    }
  }

  // 15. Wire skills to slash commands
  wireSkillsToCommands(catalog, skillHost, cmdRegistry);

  // 16. Initialize MCP servers
  let mcpManager: MCPManager | null = null;

  if (mcpConfigs && mcpConfigs.length > 0) {
    const mgr = new MCPManager();
    mcpManager = mgr;

    const result = await mgr.connectAll(mcpConfigs);

    // Register all MCP tools
    for (const { serverName, tool } of result.tools) {
      const mcpClient = mgr.getClient(serverName);
      if (mcpClient) {
        registry.register(new MCPToolWrapper(mcpClient, serverName, tool));
      }
    }

    for (const { serverName, error } of result.errors) {
      log.error({ serverName, error }, "MCP server connection error");
    }

    // Only decide the load mode after all tools are registered: it compares total schema size against the context window
    if (result.tools.length > 0) {
      decideAndApply(
        registry,
        provider.base_url,
        provider.protocol,
        getContextWindow(provider),
      );
    }
  }

  // 17. Construct the handle
  const handle = new AgentHandleImpl({
    client,
    conv,
    registry,
    sessionId,
    fileHistory,
    fileStateCache,
    cmdRegistry,
    skillCatalog: catalog,
    activeSkills,
    toolFilter: null,
    mcpManager,
    hookEngine,
    recoveryState: new RecoveryState(),
    teamManager,
    backgroundTaskManager,
    forkDisabled,
    enableCoordinatorMode,
    memoryManager,
    memoryEnabled,
    contextWindow,
    longTermMemoryInstructions: instructions,
    longTermMemoryMemoryContent: memReminder,
    provider,
    workDir,
    taskList,
  });

  // ExitPlanMode gates on the live permission mode and requires a plan file,
  // mirroring the terminal UI wiring.
  const exitPlan = registry.getInstanceOf("ExitPlanMode", ExitPlanModeTool);
  if (exitPlan) {
    exitPlan.isPlanMode = () => handle.permissionMode === "plan";
    exitPlan.planExists = () => planExists(workDir);
  }

  return handle;
}

// -- Helper functions for agent initialization ---------------------------------

/** Creates the tool registry and registers all 17 built-in tools. */
function buildToolRegistry(
  workDir: string,
  sessionId: string,
): { registry: ToolRegistry; taskList: TaskList } {
  const store = new TaskStore(workDir, sessionId);
  const taskList = new TaskList(store);

  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new BashTool());
  registry.register(new PowerShellTool());
  registry.register(new ComputerUseTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());
  registry.register(new ToolSearchTool(registry));
  registry.register(new McpCallTool(registry));
  registry.register(new EnterWorktreeTool());
  registry.register(new ExitWorktreeTool());
  registry.register(new ExitPlanModeTool());
  registry.register(new TaskCreateTool(taskList));
  registry.register(new TaskGetTool(taskList));
  registry.register(new TaskListTool(taskList));
  registry.register(new TaskUpdateTool(taskList));
  return { registry, taskList };
}

/** Registers loaded skills as slash commands (inline mode -> prompt type, fork mode -> skill_fork). */
function wireSkillsToCommands(
  catalog: SkillCatalog,
  skillHost: SkillHost,
  cmdRegistry: CommandRegistry,
): void {
  for (const meta of catalog.list()) {
    if (cmdRegistry.find(meta.name)) {
      continue;
    }
    const skill = catalog.get(meta.name);
    if (!skill) {
      continue;
    }

    const isFork = skill.meta.mode === "fork";
    try {
      cmdRegistry.register({
        name: meta.name,
        type: isFork ? "skill_fork" : "prompt",
        description: `${meta.description} [skill]`,
        isSkill: true,
        handler: isFork
          ? () => ""
          : (ctx) => runSkillInline(skill, ctx.args, skillHost),
      });
    } catch {
      // Name conflict: skip
    }
  }
}

// -- Permission description formatter ------------------------------------------

/** Formats a permission request description for the WS client permission dialog. */
function formatPermissionDesc(
  toolName: string,
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

// -- RemoteServer --------------------------------------------------------------

interface RemoteServerOptions {
  providers: ProviderConfig[];
  /** Index of the provider the server starts with; defaults to 0. */
  defaultProvider?: number;
  mcpServers?: MCPServerConfig[];
  hookConfigs?: HookConfig[];
  addr: string;
  enableCoordinatorMode: boolean;
  forkDisabled: boolean;
  /** Auto memory switch from config.yaml (`enable_memory:`); defaults to true. */
  memoryEnabled?: boolean;
  /** Agent constructor used for eager and lazy initialization. */
  agentFactory?: typeof createRemoteAgent;
}

export class RemoteServer {
  private app: Koa;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private opts: RemoteServerOptions;

  private agentHandle: RemoteAgentHandle | null = null;
  private agentInitPromise: Promise<RemoteAgentHandle | null> | null = null;
  private streaming = false;
  private compactController: AbortController | null = null;
  private reviewController: AbortController | null = null;
  private turnCount = 0;
  private readonly eventLogger = new AgentEventLogger(log);
  /** Resolves run() once stop() has completed; run() blocks on it. */
  private stoppedResolve: (() => void) | null = null;
  /** Last pong timestamp per client; drives the heartbeat sweep. */
  private lastPongAt = new Map<WebSocket, number>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Plan-mode state (parity with the terminal UI approval flow).
  private prePlanMode: PermissionMode = "default";
  private hasExitedPlanMode = false;
  private exitPlanSucceeded = false;
  /** Set by cancelActiveRun so steering leftovers are dropped, not re-run. */
  private runCanceled = false;
  /** Whether a plan approval request is awaiting a client response. */
  private planApprovalPending = false;

  private pendingPermissions = new Map<
    string,
    (response: "allow" | "deny" | "allowAlways") => void
  >();
  private pendingAsks = new Map<
    string,
    (answers: Record<string, string>) => void
  >();

  constructor(opts: RemoteServerOptions) {
    this.opts = opts;
    this.app = new Koa();
    this.server = createServer((req, res) => {
      void this.app.callback()(req, res);
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.setupRoutes();
    this.setupWebSocket();
  }

  /** Configures Koa middleware: static file serving + health check. */
  private setupRoutes(): void {
    this.app.use(async (ctx, next) => {
      if (ctx.path === "/health") {
        ctx.body = { status: "ok", remote: true, clients: this.clients.size };
        return;
      }
      await next();
    });

    this.app.use((ctx) => {
      const filePath = ctx.path === "/" ? "/index.html" : ctx.path;
      const result = serveStatic(filePath);
      if (result) {
        ctx.type = result.mime;
        ctx.body = result.body;
        return;
      }

      // Fallback: serve index.html for client-side routing (SPA)
      const indexResult = serveStatic("/index.html");
      if (indexResult) {
        ctx.type = indexResult.mime;
        ctx.body = indexResult.body;
        return;
      }

      ctx.status = 404;
      ctx.body = "Not found";
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
          data: { session: this.agentHandle.sessionId, cwd: cwd() },
        });
        const status = this.statusPayload();
        if (status) {
          this.send(ws, status);
        }
      }

      this.send(ws, { type: "commands", data: this.buildCommandList() });

      ws.on("message", (data: Buffer) => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString("utf-8"));
        } catch {
          log.warn("received non-JSON WebSocket message");
          return;
        }
        const parsed = WsInboundSchema.safeParse(raw);
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
    msg: z.infer<typeof WsInboundSchema>,
  ): Promise<void> {
    switch (msg.type) {
      case "user_message": {
        const parsed = UserMessageSchema.safeParse(msg.data);
        if (parsed.success) {
          if (this.streaming) {
            this.handleSteeringMessage(parsed.data.content);
          } else {
            await this.handleUserMessage(parsed.data.content);
          }
        } else {
          log.warn("dropping malformed user_message");
        }
        break;
      }
      case "plan_approval_response": {
        const parsed = PlanApprovalResponseSchema.safeParse(msg.data);
        if (parsed.success) {
          await this.handlePlanApprovalResponse(
            parsed.data.choice,
            parsed.data.feedback,
          );
        }
        break;
      }
      case "code_review_start": {
        const parsed = CodeReviewStartSchema.safeParse(msg.data);
        if (parsed.success) {
          await this.handleCodeReviewStart(parsed.data);
        }
        break;
      }
      case "permission_response": {
        const parsed = PermissionResponseSchema.safeParse(msg.data);
        if (parsed.success) {
          const resolver = this.pendingPermissions.get(parsed.data.id);
          if (resolver) {
            resolver(parsed.data.response);
            this.pendingPermissions.delete(parsed.data.id);
          }
        }
        break;
      }
      case "ask_user_response": {
        const parsed = AskUserResponseSchema.safeParse(msg.data);
        if (parsed.success) {
          const resolver = this.pendingAsks.get(parsed.data.id);
          if (resolver) {
            resolver(parsed.data.answers);
            this.pendingAsks.delete(parsed.data.id);
          }
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
      default:
        log.warn({ type: msg.type }, "unknown WS message type");
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
  private async ensureAgent(): Promise<RemoteAgentHandle | null> {
    if (this.agentHandle) {
      return this.agentHandle;
    }
    if (this.agentInitPromise) {
      return this.agentInitPromise;
    }

    const factory = this.opts.agentFactory ?? createRemoteAgent;
    const initPromise = (async (): Promise<RemoteAgentHandle | null> => {
      try {
        const handle = await factory({
          provider: this.startProvider(),
          workDir: cwd(),
          hooks: this.opts.hookConfigs,
          mcpServers: this.opts.mcpServers,
          askUser: this.createAskUserCallback(),
          enableCoordinatorMode: this.opts.enableCoordinatorMode,
          forkDisabled: this.opts.forkDisabled,
          memoryEnabled: this.opts.memoryEnabled !== false,
        });
        this.agentHandle = handle;
        this.broadcast({
          type: "connected",
          data: { session: handle.sessionId, cwd: cwd() },
        });
        this.broadcastStatus();
        return handle;
      } catch (err) {
        log.error({ err }, "failed to initialize agent");
        this.broadcast({
          type: "error",
          data: {
            message: `Failed to initialize agent: ${err instanceof Error ? err.message : String(err)}`,
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

  /** Handles a user message: creates agent (if needed) and streams events. */
  private async handleUserMessage(content: string): Promise<void> {
    const text = content.trim();
    if (!text || this.streaming) {
      return;
    }
    // Claim the streaming slot synchronously, BEFORE any await: ensureAgent()
    // performs real I/O on cold start, and a second message arriving during
    // that await would otherwise pass the guard and run two agents on the
    // same conversation concurrently.
    this.streaming = true;
    this.exitPlanSucceeded = false;
    this.runCanceled = false;
    // totalTurns in loop_complete describes THIS run, not the process.
    this.turnCount = 0;
    let handle: RemoteAgentHandle | null = null;
    try {
      handle = await this.ensureAgent();
      if (!handle) {
        return;
      }

      this.broadcast({ type: "replay_user", data: { content: text } });

      if (text.startsWith("/") && parseCommand(text) !== null) {
        // Slash commands (including prompt-type skills and /plan turns) run
        // through their own handler; leftover replay below covers them too.
        await this.handleSlashCommand(text);
      } else {
        const startTime = Date.now();
        const workDir = handle.workDir;
        const sessionId = handle.sessionId;

        saveMessage(workDir, sessionId, {
          role: "user",
          content: text,
          timestamp: Math.floor(Date.now() / 1000),
        });

        const callbacks: RunCallbacks = {
          onPermissionRequest: this.createPermissionCallback(),
        };

        let streamBuf = "";
        for await (const ev of handle.run(text, callbacks)) {
          // Flush accumulated stream text BEFORE tool_result/turn_complete/loop_complete
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
          this.bridgeEvent(ev, startTime, workDir, sessionId, (t) => {
            streamBuf += t;
          });
        }
      }
    } catch (err) {
      log.error({ err }, "agent stream error");
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      this.streaming = false;
    }

    if (!handle) {
      return;
    }
    // Steering queued too late for in-run delivery becomes follow-up turns
    // (parity with the terminal UI), unless the run was canceled. A new run
    // may have started between the reset above and this replay; steer the
    // leftover into it instead of silently dropping the message.
    if (!this.runCanceled) {
      for (const leftover of handle.takeSteeringLeftovers()) {
        if (this.streaming) {
          this.handleSteeringMessage(leftover);
        } else {
          await this.handleUserMessage(leftover);
        }
      }
    }
  }

  /** Queues a mid-run user message as steering for the active agent run. */
  private handleSteeringMessage(content: string): void {
    const text = content.trim();
    if (!text) {
      return;
    }
    // Slash commands need a full turn; they cannot be steered mid-run, and
    // they are not queued either — the client is told to resend afterwards.
    if (text.startsWith("/") && parseCommand(text) !== null) {
      this.broadcast({
        type: "system",
        data: {
          message:
            "Commands cannot run mid-turn. Wait for the turn to finish, then resend.",
        },
      });
      return;
    }
    if (!this.agentHandle?.steer(text)) {
      this.broadcast({
        type: "system",
        data: { message: "The agent is busy; try again shortly." },
      });
      return;
    }
    this.broadcast({ type: "steering_queued", data: { text } });
  }

  /** Bridges an AgentEvent to the corresponding WS message; compact events also persist their boundary to the session. */
  private bridgeEvent(
    ev: AgentEvent,
    startTime: number,
    workDir: string,
    sessionId: string,
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
            isError: ev.isError,
            elapsed: ev.elapsed,
          },
        });
        if (ev.toolName === "ExitPlanMode" && !ev.isError) {
          this.exitPlanSucceeded = true;
        }
        break;

      case "steering_delivered":
        this.broadcast({
          type: "steering_delivered",
          data: { text: ev.text },
        });
        break;

      case "turn_complete":
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
        // plan mode where ExitPlanMode succeeded, ask the user to approve.
        if (
          this.agentHandle?.permissionMode === "plan" &&
          this.exitPlanSucceeded
        ) {
          this.broadcastPlanApprovalRequest();
        }
        break;
      }

      case "usage":
        this.broadcast({
          type: "usage",
          data: {
            inputTokens: ev.usage.inputTokens,
            outputTokens: ev.usage.outputTokens,
          },
        });
        break;

      case "error":
        this.broadcast({
          type: "error",
          data: { message: ev.error.message },
        });
        break;

      case "compact":
        this.broadcast({ type: "compact", data: { message: ev.message } });
        if (ev.boundary) {
          saveCompactBoundary(workDir, sessionId, ev.boundary);
        }
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

  // -- Slash command handling ---------------------------------------------------

  /** Handles slash command input: parse, dispatch to handler by type. */
  private async handleSlashCommand(input: string): Promise<void> {
    const handle = await this.ensureAgent();
    if (!handle) {
      // Init failed; reset the client-side streaming state so the UI is usable again.
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    const parsed = parseCommand(input);
    if (!parsed) {
      return;
    }

    const { name, args } = parsed;
    const cmd = handle.cmdRegistry.find(name);

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
        } else if (name === "mcp") {
          this.broadcast({
            type: "system",
            data: { message: this.buildMcpStatus(args) },
          });
        } else {
          const result = cmd.handler(ctx);
          this.broadcast({ type: "system", data: { message: result } });
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

        this.streaming = true;
        this.exitPlanSucceeded = false;
        const workDir = handle.workDir;
        const sessionId = handle.sessionId;

        // Persist the display text (not the handler output)
        saveMessage(workDir, sessionId, {
          role: "user",
          content: displayText,
          timestamp: Math.floor(Date.now() / 1000),
        });

        const startTime = Date.now();
        try {
          const callbacks: RunCallbacks = {
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
            this.bridgeEvent(ev, startTime, workDir, sessionId, (t) => {
              streamBuf += t;
            });
          }
        } catch (err) {
          log.error({ err }, "agent stream error in prompt command");
          this.broadcast({
            type: "error",
            data: { message: err instanceof Error ? err.message : String(err) },
          });
        } finally {
          this.streaming = false;
        }
        break;
      }

      case "skill_fork":
        this.broadcast({
          type: "system",
          data: {
            message:
              "Fork-mode skill commands are not available in remote mode. The agent can still run such skills — mention the skill in your message and it will activate them via the LoadSkill tool.",
          },
        });
        this.broadcast({ type: "command_done", data: null });
        break;
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
      case "clear":
        // Reset in place (AgentTool captured the conversation manager) and
        // rotate the session so /resume and the JSONL no longer see the
        // pre-clear history.
        this.agentHandle.clearConversation();
        this.agentHandle.toolFilter = null;
        this.broadcast({
          type: "connected",
          data: { session: this.agentHandle.sessionId, cwd: cwd() },
        });
        this.broadcast({ type: "clear", data: null });
        this.broadcast({ type: "command_done", data: null });
        break;

      case "compact":
        await this.handleCompact(args);
        break;

      case "plan":
        await this.handlePlan(args);
        break;

      case "login":
        this.broadcast({
          type: "system",
          data: {
            message:
              "Provider login is only available in terminal mode. The remote server uses the provider it was started with.",
          },
        });
        this.broadcast({ type: "command_done", data: null });
        break;

      case "model":
        this.broadcast({
          type: "system",
          data: {
            message:
              "Model selection is only available in terminal mode. The remote server keeps the model it was started with.",
          },
        });
        this.broadcast({ type: "command_done", data: null });
        break;

      case "resume":
        this.handleResume(args);
        break;

      case "rewind":
        this.broadcast({
          type: "system",
          data: { message: "Rewind is not yet supported in remote mode." },
        });
        this.broadcast({ type: "command_done", data: null });
        break;

      case "quit":
        this.broadcast({
          type: "system",
          data: {
            message:
              "Quit is not supported in remote mode. Close the browser tab.",
          },
        });
        this.broadcast({ type: "command_done", data: null });
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
        this.broadcast({
          type: "system",
          data: {
            message: "Sandbox toggle is not yet supported in remote mode.",
          },
        });
        this.broadcast({ type: "command_done", data: null });
        break;

      case "worktree":
        this.broadcast({
          type: "system",
          data: {
            message: "Worktree management is not yet supported in remote mode.",
          },
        });
        this.broadcast({ type: "command_done", data: null });
        break;

      case "code-review":
        if (args.trim()) {
          this.broadcast({
            type: "system",
            data: { message: "Usage: /code-review" },
          });
        } else {
          this.broadcast({ type: "code_review_form", data: null });
        }
        this.broadcast({ type: "command_done", data: null });
        break;

      default:
        this.broadcast({ type: "command_done", data: null });
        break;
    }
  }

  /** Builds a CommandContext for slash command execution. */
  private buildCommandContext(args: string): CommandContext {
    const handle = this.agentHandle;
    if (!handle) {
      return { workDir: cwd(), args, model: "" };
    }
    return {
      workDir: handle.workDir,
      args,
      permissionMode: () => "default",
      tokenCount: () => [0, 0] as const,
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

  /** Handles /compact command: force context compaction. */
  private async handleCompact(customInstructions = ""): Promise<void> {
    if (!this.agentHandle) {
      return;
    }
    const handle = this.agentHandle;
    const controller = new AbortController();
    this.compactController = controller;
    this.streaming = true;

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
        getSessionFilePath(handle.workDir, handle.sessionId),
        controller.signal,
        customInstructions,
      );
      this.broadcast({
        type: "system",
        data: { message: `Compacted: ${result.message}` },
      });
      if (result.boundary) {
        saveCompactBoundary(handle.workDir, handle.sessionId, result.boundary);
      }
    } catch (err) {
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      this.compactController = null;
      this.streaming = false;
      this.broadcast({ type: "command_done", data: null });
    }
  }

  /** Handles /plan command: enter plan mode, optionally with args. */
  private async handlePlan(args: string): Promise<void> {
    if (!this.agentHandle) {
      return;
    }
    const handle = this.agentHandle;
    const workDir = handle.workDir;
    const planPath = getOrCreatePlanPath(workDir);

    if (handle.permissionMode !== "plan") {
      this.prePlanMode = handle.permissionMode;
      handle.permissionMode = "plan";
    }
    this.broadcast({
      type: "system",
      data: {
        message:
          `Entered plan mode (read-only). Plan file: ${planPath}\n` +
          "Investigate and design your approach. The agent will call ExitPlanMode when the plan is ready.",
      },
    });
    this.broadcastStatus();

    // Re-enter plan mode: if a plan file already exists, rebuild the reminder
    // (parity with the terminal UI).
    if (this.hasExitedPlanMode && planExists(workDir)) {
      const reentryMsg = buildPlanModeReentryReminder(planPath, true);
      if (reentryMsg) {
        handle.conv.addSystemReminder(reentryMsg);
        this.broadcast({ type: "system", data: { message: reentryMsg } });
      }
      this.hasExitedPlanMode = false;
    }

    if (args) {
      this.streaming = true;
      this.exitPlanSucceeded = false;
      this.runCanceled = false;
      saveMessage(workDir, handle.sessionId, {
        role: "user",
        content: `/plan ${args}`,
        timestamp: Math.floor(Date.now() / 1000),
      });

      const startTime = Date.now();
      try {
        const callbacks: RunCallbacks = {
          onPermissionRequest: this.createPermissionCallback(),
        };

        let streamBuf = "";
        for await (const ev of handle.run(args, callbacks)) {
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
          this.bridgeEvent(ev, startTime, workDir, handle.sessionId, (t) => {
            streamBuf += t;
          });
        }
      } catch (err) {
        log.error({ err }, "agent stream error in plan command");
        this.broadcast({
          type: "error",
          data: { message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        this.streaming = false;
      }
    } else {
      this.broadcast({ type: "command_done", data: null });
    }
  }

  // -- Plan approval ------------------------------------------------------------

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
        permissionMode: handle.permissionMode,
        thinkingLevel:
          handle.client.getThinkingLevel?.() ??
          handle.provider.thinking ??
          DEFAULT_THINKING_LEVEL,
      },
    };
  }

  /** Broadcasts the current model/mode/thinking snapshot to all clients. */
  private broadcastStatus(): void {
    const status = this.statusPayload();
    if (status) {
      this.broadcast(status);
    }
  }

  /** Sends the plan approval request with the current plan file content. */
  private broadcastPlanApprovalRequest(): void {
    const handle = this.agentHandle;
    if (!handle) {
      return;
    }
    const planPath = getOrCreatePlanPath(handle.workDir);
    let planContent = "";
    try {
      if (existsSync(planPath)) {
        planContent = readFileSync(planPath, "utf-8");
      }
    } catch {
      /** noop */
    }
    this.planApprovalPending = true;
    this.broadcast({
      type: "plan_approval_request",
      data: { planPath, planContent },
    });
  }

  /**
   * Mirrors the terminal UI plan approval: "yolo" auto-approves every edit,
   * "manual" restores the pre-plan mode, and "feedback" keeps planning.
   */
  private async handlePlanApprovalResponse(
    choice: "yolo" | "manual" | "feedback",
    feedback?: string,
  ): Promise<void> {
    const handle = this.agentHandle;
    if (!handle || !this.planApprovalPending) {
      return;
    }
    this.planApprovalPending = false;

    if (choice === "feedback") {
      const text = feedback?.trim() ?? "";
      if (text) {
        await this.handleUserMessage(text);
      }
      return;
    }

    const workDir = handle.workDir;
    const planPath = getOrCreatePlanPath(workDir);
    let planContent = "";
    try {
      if (existsSync(planPath)) {
        planContent = readFileSync(planPath, "utf-8");
      }
    } catch {
      /** noop */
    }

    this.hasExitedPlanMode = true;
    handle.permissionMode =
      choice === "yolo" ? "bypassPermissions" : this.prePlanMode;
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
      await this.handleUserMessage(`Execute this plan:\n\n${planContent}`);
    }
  }

  // -- Code review ----------------------------------------------------------------

  /** Runs a code review configured through the browser form. */
  private async handleCodeReviewStart(
    options: z.infer<typeof CodeReviewStartSchema>,
  ): Promise<void> {
    if (this.streaming) {
      this.broadcast({
        type: "system",
        data: { message: "A run is already in progress." },
      });
      return;
    }

    const from = options.from?.trim() || undefined;
    const to = options.to?.trim() || undefined;
    const commit = options.commit?.trim() || undefined;
    try {
      validateReviewInput(from, to, commit);
      for (const ref of [from, to, commit]) {
        if (ref && /[\r\n]/u.test(ref)) {
          throw new Error("Git refs must be a single line");
        }
      }
    } catch (err) {
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    // Claim the shared foreground slot before cold initialization yields. This
    // prevents a second review or chat run from entering the same conversation.
    const controller = new AbortController();
    this.reviewController = controller;
    this.streaming = true;
    this.runCanceled = false;

    try {
      const handle = await this.ensureAgent();
      if (!handle) {
        return;
      }

      const startTime = Date.now();
      this.broadcast({
        type: "code_review_progress",
        data: { phase: "diff", message: "Starting code review…" },
      });
      const result = await runCodeReview(
        {
          workDir: handle.workDir,
          background: options.background?.trim() || undefined,
          from,
          to,
          commit,
          excludePatterns:
            options.excludePatterns?.filter((pattern) => pattern.trim()) ?? [],
          abortSignal: controller.signal,
          onProgress: (event) => {
            this.broadcast({
              type: "code_review_progress",
              data: {
                phase: event.phase,
                message: event.message,
                progress: event.progress,
              },
            });
          },
          onToolEvent: (event) => {
            if (event.type === "tool_use") {
              this.broadcast({
                type: "tool_use",
                data: {
                  toolId: event.toolId,
                  toolName: event.toolName,
                  args: event.args,
                },
              });
            } else {
              this.broadcast({
                type: "tool_result",
                data: {
                  toolId: event.toolId,
                  toolName: event.toolName,
                  output: event.output,
                  isError: event.isError,
                  elapsed: event.elapsed,
                },
              });
            }
          },
        },
        { provider: handle.provider },
      );
      const report = formatReviewReport(result);
      this.broadcast({ type: "stream_text", data: { text: report } });
      this.broadcast({ type: "stream_end", data: { text: report } });
      if (result.comments.length > 0) {
        handle.conv.addSystemReminder(
          `<code_review_findings>\n${report}\n</code_review_findings>`,
        );
      }
      this.broadcast({
        type: "loop_complete",
        data: {
          stopReason: result.aborted ? "aborted" : "end_turn",
          totalTurns: 0,
          elapsed: (Date.now() - startTime) / 1000,
        },
      });
    } catch (err) {
      log.error({ err }, "code review failed");
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
      this.broadcast({ type: "command_done", data: null });
    } finally {
      this.reviewController = null;
      this.streaming = false;
    }
  }

  // -- Local status commands and session resume --------------------------------------

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

  /** Renders /mcp status output (parity with the terminal UI). */
  private buildMcpStatus(args: string): string {
    if (args.trim().toLowerCase() === "reload") {
      return "MCP reload is not supported in remote mode. Restart the remote server to reconnect.";
    }
    const handle = this.agentHandle;
    const manager = handle?.mcpManager;
    if (!manager || !handle) {
      return "No MCP servers configured.";
    }
    const connected = manager.connectedServers();
    if (connected.length === 0) {
      return "No MCP servers connected.";
    }
    const lines = [
      `MCP servers (${String(connected.length)}):`,
      ...connected.map((s) => `  · ${s}`),
      `Tools: ${String(countMcpTools(handle.registry))} total`,
    ];
    return lines.join("\n");
  }

  /** Handles /resume command: resume a previous session. */
  private handleResume(args: string): void {
    if (!this.agentHandle) {
      return;
    }
    const handle = this.agentHandle;
    const workDir = handle.workDir;
    const sessions = listSessions(workDir);

    if (!args) {
      // No arguments: send the structured session list for the browser picker.
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
          sessions: sessions.slice(0, 50).map((sess) => ({
            id: sess.id,
            firstMessage: sess.firstMessage,
            messageCount: sess.messageCount,
            modTime: sess.modTime.toISOString(),
          })),
        },
      });
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    // Resolve target session (by index or session ID)
    let targetId = args.trim();
    const idx = /^\d+$/.test(targetId) ? Number(targetId) : NaN;
    if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      targetId = sessions[idx - 1].id;
    }

    const saved = sessions.some((session) => session.id === targetId)
      ? loadSession(workDir, targetId)
      : [];
    if (saved.length === 0) {
      this.broadcast({
        type: "error",
        data: { message: `Session '${targetId}' not found or empty.` },
      });
      this.broadcast({ type: "command_done", data: null });
      return;
    }

    const replay = restoreRemoteSession(handle, targetId, saved);
    touchSession(workDir, targetId);

    this.broadcast({ type: "clear", data: null });
    for (const msg of replay) {
      // Messages carrying only tool results have no text content; skip pushing them to the frontend
      if (!msg.content) {
        continue;
      }
      const displayContent = contentToText(msg.content);
      if (msg.role === "user") {
        this.broadcast({
          type: "replay_user",
          data: { content: displayContent },
        });
      } else {
        this.broadcast({
          type: "replay_assistant",
          data: { content: displayContent },
        });
      }
    }

    this.broadcast({
      type: "system",
      data: {
        message: `Session ${targetId} restored (${String(replay.length)} messages).`,
      },
    });
    this.broadcast({ type: "command_done", data: null });
  }

  // -- Helper methods -----------------------------------------------------------

  /** Creates the askUser callback closure for createRemoteAgent. */
  private createAskUserCallback(): Asker {
    return async (questions: Question[]): Promise<Record<string, string>> => {
      const id = nextRequestId("ask");
      this.broadcast({ type: "ask_user", data: { id, questions } });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.pendingAsks.delete(id)) {
            this.broadcast({
              type: "system",
              data: {
                message: `Question timed out after ${String(PENDING_REQUEST_TIMEOUT_MINUTES)} minutes with no answer; continuing with empty answers.`,
              },
            });
            resolve({});
          }
        }, PENDING_REQUEST_TIMEOUT_MS);
        timer.unref();
        this.pendingAsks.set(id, (answers) => {
          clearTimeout(timer);
          resolve(answers);
        });
      });
    };
  }

  /** Creates the onPermissionRequest callback for agent runs. */
  private createPermissionCallback(): RunCallbacks["onPermissionRequest"] {
    return async (
      toolName: string,
      args: Record<string, unknown>,
      decision: Decision,
    ): Promise<"allow" | "deny" | "allowAlways"> => {
      const id = nextRequestId("perm");
      const desc = formatPermissionDesc(toolName, args, decision);
      this.broadcast({
        type: "permission_request",
        data: { id, toolName, description: desc },
      });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.pendingPermissions.delete(id)) {
            this.broadcast({
              type: "system",
              data: {
                message: `Permission request timed out after ${String(PENDING_REQUEST_TIMEOUT_MINUTES)} minutes with no response; denying automatically.`,
              },
            });
            resolve("deny");
          }
        }, PENDING_REQUEST_TIMEOUT_MS);
        timer.unref();
        this.pendingPermissions.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
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
   * Starts the Koa HTTP + WebSocket server and blocks until stop() is called.
   * Initializing the agent handle happens eagerly; failures fall back to lazy
   * init on first message. Blocking here (instead of resolving once listening)
   * keeps the caller's exit bookkeeping after the server is actually down.
   */
  async run(): Promise<void> {
    const { host, port } = parseRemoteAddress(this.opts.addr);
    try {
      const factory = this.opts.agentFactory ?? createRemoteAgent;
      this.agentHandle = await factory({
        provider: this.startProvider(),
        workDir: cwd(),
        hooks: this.opts.hookConfigs,
        mcpServers: this.opts.mcpServers,
        askUser: this.createAskUserCallback(),
        enableCoordinatorMode: this.opts.enableCoordinatorMode,
        forkDisabled: this.opts.forkDisabled,
        memoryEnabled: this.opts.memoryEnabled !== false,
      });
    } catch (err) {
      log.warn({ err }, "agent init deferred -- will retry on first message");
      this.agentHandle = null;
    }

    const stopped = new Promise<void>((resolve) => {
      this.stoppedResolve = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(port, host, () => {
        this.startHeartbeat();
        resolve();
      });
    });
    await stopped;
  }

  /**
   * Stops the server and cleans up every child resource: closes WS/HTTP,
   * cancels the active run, and — unlike the fire-and-forget abort() — awaits
   * the background-task and team stopAlls plus the MCP disconnects, so
   * detached shells, teammates, and stdio server children do not outlive the
   * process.
   */
  async stop(): Promise<void> {
    this.cancelActiveRun();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
      try {
        await this.agentHandle.backgroundTaskManager.stopAll();
      } catch {
        // best-effort
      }
      try {
        await this.agentHandle.teamManager.stopAll();
      } catch {
        // best-effort
      }
      const mcp = this.agentHandle.mcpManager;
      if (mcp) {
        try {
          await mcp.disconnectAll();
        } catch {
          // best-effort
        }
      }
    }
    const resolveStopped = this.stoppedResolve;
    this.stoppedResolve = null;
    resolveStopped?.();
  }

  private cancelActiveRun(): void {
    this.runCanceled = true;
    this.planApprovalPending = false;
    this.agentHandle?.abort();
    this.compactController?.abort();
    this.reviewController?.abort();
    // Aborting a provider cannot settle promises owned by the WebSocket UI.
    for (const resolve of this.pendingPermissions.values()) {
      resolve("deny");
    }
    this.pendingPermissions.clear();
    for (const resolve of this.pendingAsks.values()) {
      resolve({});
    }
    this.pendingAsks.clear();
  }
}
