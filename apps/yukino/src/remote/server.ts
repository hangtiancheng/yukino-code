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
import {
  parse as parseCommand,
  createDefaultRegistry as createCommandRegistry,
  type CommandRegistry,
  type CommandContext,
} from "@/commands/commands.js";
import { loadUserCommands } from "@/commands/loader.js";
import { forceCompact } from "@/compact/compact.js";
import { RecoveryState } from "@/compact/recovery.js";
import {
  DEFAULT_THINKING_LEVEL,
  getContextWindow,
  getMaxOutputTokens,
  getSupportedThinkingLevels,
} from "@/config/index.js";
import type {
  HookConfig,
  MCPServerConfig,
  ProviderConfig,
} from "@/config/index.js";
import { persistThinkingLevel } from "@/config/provider-login.js";
import { ConversationManager } from "@/conversation/index.js";
import { FileHistory } from "@/file-history/index.js";
import { HookEngine, validate as validateHooks } from "@/hooks/index.js";
import { createClient, type LLMClient } from "@/llm/client.js";
import { resolveModelId } from "@/llm/model-resolver.js";
import { createChildLogger } from "@/logger/index.js";
import { syncMcpInstructions as announceMcpInstructions } from "@/mcp/instructions.js";
import { MCPManager } from "@/mcp/manager.js";
import { decideAndApply } from "@/mcp/strategy.js";
import { MCPToolWrapper } from "@/mcp/tool-wrapper.js";
import { MemoryConsolidator } from "@/memory/consolidation.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { loadInstructions } from "@/memory/instructions.js";
import { MemoryManager } from "@/memory/manager.js";
import { PermissionChecker, type Decision } from "@/permissions/index.js";
import { getOrCreatePlanPath } from "@/plan-file/index.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import {
  newSessionId,
  saveMessage,
  saveCompactBoundary,
  listSessions,
  loadSession,
  getSessionFilePath,
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
import { filterToolsForAgent } from "@/subagent/tool-filter.js";
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

// -- Static file serving -------------------------------------------------------

const FE_DIST = join(import.meta.dirname, "fe", "dist");

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

/** Callbacks injected into each agent run for permission and user-interaction flows. */
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
  contextWindow: number;
  longTermMemoryInstructions: string;
  longTermMemoryMemoryContent: string;
  provider: ProviderConfig;
  workDir: string;

  /** Runs the agent loop: adds the user message, creates Agent, and yields events. */
  run(text: string, callbacks: RunCallbacks): AsyncGenerator<AgentEvent>;

  /** Aborts the currently running agent loop (if any). */
  abort(): void;
}

// -- Agent handle implementation -----------------------------------------------

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
  contextWindow: number;
  longTermMemoryInstructions: string;
  longTermMemoryMemoryContent: string;
  provider: ProviderConfig;
  workDir: string;

  // Servers whose instructions this conversation has already been told about. The
  // remote handle connects MCP once and never reloads it, so nothing is ever
  // retracted here; the record keeps later runs from repeating the guidance, and
  // history decides whether it has to be replayed (compaction, session restore).
  private mcpAnnounced = new Set<string>();

  private abortController: AbortController | null = null;

  constructor(
    agentHandleImpl: Omit<AgentHandleImpl, "abortController" | "run" | "abort">,
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
    this.contextWindow = agentHandleImpl.contextWindow;
    this.longTermMemoryInstructions =
      agentHandleImpl.longTermMemoryInstructions;
    this.longTermMemoryMemoryContent =
      agentHandleImpl.longTermMemoryMemoryContent;
    this.provider = agentHandleImpl.provider;
    this.workDir = agentHandleImpl.workDir;
    this.abortController = null;
  }

  async *run(
    text: string,
    callbacks: RunCallbacks,
  ): AsyncGenerator<AgentEvent> {
    // Add user message to conversation
    this.conv.addUserMessage(text);

    // Announce the instructions of every connected MCP server this conversation has
    // not seen yet. Nothing goes out while the announcement is still in history, and
    // it is replayed once that history no longer holds it.
    if (this.mcpManager) {
      announceMcpInstructions(this.conv, this.mcpAnnounced, this.mcpManager);
    }

    // Create abort controller for this run
    this.abortController = new AbortController();

    try {
      const checker = new PermissionChecker(this.workDir, "default");
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
        toolFilter: (name: string) => {
          // Skill filtering and coordinator narrowing must both pass; either one blocking is sufficient to deny
          if (!coordinatorToolFilter(this.enableCoordinatorMode)(name)) {
            return false;
          }
          return this.toolFilter ? this.toolFilter(name) : true;
        },
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
          ...this.teamManager.drainLeads(),
          ...this.backgroundTaskManager
            .drainNotifications()
            .map(formatAgentTaskNotification),
        ],
        onPermissionRequest: callbacks.onPermissionRequest,
        onLoopComplete: (conv) => {
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
          new MemoryConsolidator(this.client, this.workDir, {
            appendSystem: (msg) => {
              conv.addSystemReminder(msg);
            },
          })
            .maybeRun()
            .catch(() => {
              /* non-fatal */
            });
        },
      });

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
}

// -- createRemoteAgent factory -------------------------------------------------

export interface CreateRemoteAgentOptions {
  provider: ProviderConfig;
  workDir: string;
  hooks?: HookConfig[];
  mcpServers?: MCPServerConfig[];
  enableCoordinatorMode: boolean;
  forkDisabled: boolean;
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
    askUser,
    sessionId = newSessionId(),
  } = opts;

  // 1. Create session and file history
  const fileHistory = new FileHistory(workDir, sessionId);
  const fileStateCache = new FileStateCache();

  // 2. Build tool registry with all built-in tools
  const registry = buildToolRegistry(workDir, sessionId);

  // 3. Build system prompt
  const env = detectEnvironment(workDir);
  env.model = provider.model;
  const systemPrompt = buildSystemPrompt(env);

  // 4. Create LLM client
  const client = await createClient(provider, systemPrompt);

  // 5. Create conversation manager
  const conv = new ConversationManager();

  const contextWindow = getContextWindow(provider);

  // 7. Load instructions and memory, inject into conversation
  const instructions = loadInstructions(workDir);
  const memoryManager = new MemoryManager(workDir);
  const memReminder = memoryManager.buildSystemReminder();
  conv.injectLongTermMemory(instructions, memReminder);

  // 9. Initialize hooks
  const hookErr = validateHooks(hookConfigs ?? []);
  if (hookErr) {
    log.warn({ message: hookErr.message }, "hook validation warning");
  }
  const hookEngine = new HookEngine(hookConfigs ?? []);

  // 10. Load skills
  const catalog = new SkillCatalog();
  catalog.load(workDir);

  // 11. SkillHost interface
  const activeSkills = new Map<string, string>();
  const skillHost: SkillHost = {
    activateSkill: (name, body) => {
      activeSkills.set(name, body);
    },
  };

  // Fork-mode host: Skills declaring mode: fork run in an isolated sub-agent;
  // the SOP body only appears in the sub-agent's conversation — the main conversation receives the final result
  const skillForkHost: SkillForkHost = {
    // TODO: determine whether bind is needed
    activateSkill: skillHost.activateSkill.bind(skillHost),
    snapshotParentMessages: (count: number) => {
      const msgs = conv?.getMessages() ?? [];
      return msgs
        .slice(-count)
        .map((m) => `${m.role}: ${contentToText(m.content)}`)
        .join("\n");
    },
    runSubagent: async (prompt: string) => {
      if (!client) {
        throw new Error("no llm client (provider not initialized)");
      }
      const { PermissionChecker: PC } = await import("../permissions/index.js");
      const { Agent: AgentClass } = await import("../agent/index.js");

      // Sub-agent uses an independent conversation to avoid polluting the main context
      const subConv = new ConversationManager();
      subConv.addUserMessage(prompt);

      // Per-run background task registry (parity with subagent/spawn.ts): the
      // forked registry shares tool instances with the host, so without this
      // the fork's backgrounded commands would register in the host-level
      // manager — the fork would never see their notifications, the main
      // thread would be notified for commands it never issued, and nothing
      // would kill the fork's shells when it exits.
      const taskManager = new TaskManager();

      const subAgent = new AgentClass({
        client,
        registry: filterToolsForAgent(registry, undefined, undefined, false),
        checker: new PC(workDir, "acceptEdits"),
        conversation: subConv,
        workDir,
        maxIterations: 200,
        taskManager,
        notificationFn: () =>
          taskManager.drainNotifications().map(formatAgentTaskNotification),
      });

      let output = "";
      try {
        for await (const event of subAgent.run()) {
          switch (event.type) {
            case "stream_text":
              output += event.text;
              break;
            case "loop_complete":
              return output || "[No output]";
            case "error":
              throw event.error;
          }
        }
        return output || "[No output]";
      } finally {
        await taskManager.stopAll();
      }
    },
  };

  // 12. Register LoadSkill tool
  registry.register(new LoadSkillTool(catalog, skillHost, skillForkHost));

  // 13. Register AskUserQuestion tool when the host supports interactive questions
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
  // 14. Register Team tools
  const teamManager = new TeamManager(workDir);
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

  // 15. Register AgentTool (with both spawn and fork paths)
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
      const resolvedModel = modelOverride
        ? resolveModelId(modelOverride)
        : provider.model;
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
  // Wire the team manager into AgentTool so the team_name teammate path takes effect (teammates receive shared team task-board tools)
  agentTool.forkDisabled = forkDisabled ?? false;
  agentTool.setTeamManager(teamManager, teamRunAgentFactory, provider.base_url);
  registry.register(agentTool);

  // 16. Load user-defined slash commands
  const cmdRegistry = createCommandRegistry();
  for (const cmd of loadUserCommands(workDir)) {
    try {
      cmdRegistry.register(cmd);
    } catch {
      // Name conflict: keep built-in command
    }
  }

  // 17. Wire skills to slash commands
  wireSkillsToCommands(catalog, skillHost, cmdRegistry);

  // 18. Initialize MCP servers
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

    // Log errors
    for (const { serverName, error } of result.errors) {
      log.error({ serverName, error }, "MCP server connection error");
    }

    // Only decide the load mode after all tools are registered: it compares total schema size against the context window
    if (result.tools.length > 0) {
      decideAndApply(registry, provider.base_url, getContextWindow(provider));
    }
  }

  // 19. Construct the handle
  return new AgentHandleImpl({
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
    contextWindow,
    longTermMemoryInstructions: instructions,
    longTermMemoryMemoryContent: memReminder,
    provider,
    workDir,
  });
}

// -- Helper functions for agent initialization ---------------------------------

/** Creates the tool registry and registers all 17 built-in tools. */
function buildToolRegistry(workDir: string, sessionId: string): ToolRegistry {
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
  return registry;
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
        aliases: [],
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

/** Formats a permission request description for the WS client popup. */
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
  mcpServers?: MCPServerConfig[];
  hookConfigs?: HookConfig[];
  addr: string;
  enableCoordinatorMode: boolean;
  forkDisabled: boolean;
}

export class RemoteServer {
  private app: Koa;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private opts: RemoteServerOptions;

  // Agent handle
  private agentHandle: RemoteAgentHandle | null = null;
  private streaming = false;
  private compactController: AbortController | null = null;
  private turnCount = 0;
  private readonly eventLogger = new AgentEventLogger(log);

  // Pending permission/ask-user requests waiting for WS client responses
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
    // Health check
    this.app.use(async (ctx, next) => {
      if (ctx.path === "/health") {
        ctx.body = { status: "ok", remote: true, clients: this.clients.size };
        return;
      }
      await next();
    });

    // Static file serving for fe/dist/
    this.app.use((ctx) => {
      // Root path -> index.html
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

      // Send initial connected message to the newly connected client only.
      // Deferred until the agent exists so the session id is never empty;
      // ensureAgent() broadcasts it once initialization completes.
      if (this.agentHandle) {
        this.send(ws, {
          type: "connected",
          data: { session: this.agentHandle.sessionId, cwd: cwd() },
        });
      }

      // Send available slash commands
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
        void this.handleWsMessage(parsed.data);
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });

      ws.on("error", () => {
        this.clients.delete(ws);
      });
    });
  }

  /** Handles incoming WebSocket messages from the Web UI. */
  private async handleWsMessage(
    msg: z.infer<typeof WsInboundSchema>,
  ): Promise<void> {
    switch (msg.type) {
      case "user_message": {
        const parsed = UserMessageSchema.safeParse(msg.data);
        if (parsed.success) {
          await this.handleUserMessage(parsed.data.content);
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
        this.broadcast({ type: "pong", data: null });
        break;
      }
      default:
        log.warn({ type: msg.type }, "unknown WS message type");
    }
  }

  /**
   * Returns the agent handle, initializing it on first use. On success the
   * real session id is broadcast so clients can show the greeting line.
   */
  private async ensureAgent(): Promise<RemoteAgentHandle | null> {
    if (this.agentHandle) {
      return this.agentHandle;
    }
    try {
      this.agentHandle = await createRemoteAgent({
        provider: this.opts.providers[0],
        workDir: cwd(),
        hooks: this.opts.hookConfigs,
        mcpServers: this.opts.mcpServers,
        askUser: this.createAskUserCallback(),
        enableCoordinatorMode: this.opts.enableCoordinatorMode,
        forkDisabled: this.opts.forkDisabled,
      });
      this.broadcast({
        type: "connected",
        data: { session: this.agentHandle.sessionId, cwd: cwd() },
      });
      return this.agentHandle;
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
  }

  /** Handles a user message: creates agent (if needed) and streams events. */
  private async handleUserMessage(content: string): Promise<void> {
    const text = content.trim();
    if (!text || this.streaming) {
      return;
    }

    const handle = await this.ensureAgent();
    if (!handle) {
      return;
    }

    this.broadcast({ type: "replay_user", data: { content: text } });

    // Slash command handling. Path-like inputs (e.g. /path/to/somewhere) are
    // not commands and fall through as normal user messages.
    if (text.startsWith("/") && parseCommand(text) !== null) {
      await this.handleSlashCommand(text);
      return;
    }

    this.streaming = true;
    const startTime = Date.now();
    const workDir = handle.workDir;
    const sessionId = handle.sessionId;

    // Persist user message to session
    saveMessage(workDir, sessionId, {
      role: "user",
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
    });

    try {
      const callbacks: RunCallbacks = {
        onPermissionRequest: async (
          toolName: string,
          args: Record<string, unknown>,
          decision: Decision,
        ): Promise<"allow" | "deny" | "allowAlways"> => {
          const id = `perm_${Date.now().toString(36)}`;
          const desc = formatPermissionDesc(toolName, args, decision);
          this.broadcast({
            type: "permission_request",
            data: { id, toolName, description: desc },
          });
          return new Promise((resolve) => {
            this.pendingPermissions.set(id, resolve);
          });
        },
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
    } catch (err) {
      log.error({ err }, "agent stream error");
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      this.streaming = false;
    }
  }

  /** Bridges an AgentEvent to the corresponding WS message and session persistence. */
  private bridgeEvent(
    ev: AgentEvent,
    startTime: number,
    workDir: string,
    sessionId: string,
    appendStream: (text: string) => void,
  ): void {
    // Unified structured event log (one JSONL line per discrete event).
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
        // Persist compact boundary
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
        const result = cmd.handler(ctx);
        this.broadcast({ type: "system", data: { message: result } });
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
            message: "Fork-mode skills are not yet supported in remote mode.",
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
        this.agentHandle.conv = new ConversationManager();
        this.agentHandle.activeSkills.clear();
        this.agentHandle.toolFilter = null;
        this.broadcast({ type: "clear", data: null });
        this.broadcast({ type: "command_done", data: null });
        break;

      case "compact":
        await this.handleCompact(args);
        break;

      case "plan":
        await this.handlePlan(args);
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
      memoryList: () => handle.memoryManager.getMemories().map((m) => m.name),
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
      const toolNames = handle.registry.listTools().map((t) => t.name);
      const toolSchemas = handle.registry.getAllSchemas();
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

    this.broadcast({
      type: "system",
      data: {
        message: `Entered Plan mode. Plan file: ${planPath}\nExplore the codebase and design your approach.`,
      },
    });

    if (args) {
      // With arguments: send to agent loop
      this.streaming = true;
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

  /** Handles /resume command: resume a previous session. */
  private handleResume(args: string): void {
    if (!this.agentHandle) {
      return;
    }
    const handle = this.agentHandle;
    const workDir = handle.workDir;
    const sessions = listSessions(workDir);

    if (!args) {
      // No arguments: list available sessions
      if (sessions.length === 0) {
        this.broadcast({
          type: "system",
          data: { message: "No previous sessions found." },
        });
        this.broadcast({ type: "command_done", data: null });
        return;
      }

      const lines: string[] = [
        `Available sessions (${String(sessions.length)}):\n`,
      ];
      for (let i = 0; i < Math.min(sessions.length, 20); i++) {
        const sess = sessions[i];
        let first = sess.firstMessage;
        if (first.length > 60) {
          first = first.slice(0, 60) + "...";
        }
        lines.push(
          `  ${String(i + 1)}. [${sess.id}] ${first} (${String(sess.messageCount)} msgs)`,
        );
      }
      if (sessions.length > 20) {
        lines.push(`  ... and ${String(sessions.length - 20)} more`);
      }
      lines.push("\nUsage: /resume <number> or /resume <sess-id>");
      this.broadcast({ type: "system", data: { message: lines.join("\n") } });
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

    // Clear UI and replay messages
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
      const id = `ask_${Date.now().toString(36)}`;
      this.broadcast({ type: "ask_user", data: { id, questions } });
      return new Promise((resolve) => {
        this.pendingAsks.set(id, resolve);
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
      const id = `perm_${Date.now().toString(36)}`;
      const desc = formatPermissionDesc(toolName, args, decision);
      this.broadcast({
        type: "permission_request",
        data: { id, toolName, description: desc },
      });
      return new Promise((resolve) => {
        this.pendingPermissions.set(id, resolve);
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
   * Starts the Koa HTTP + WebSocket server.
   * Initializes the agent handle eagerly; falls back to lazy init on first message.
   */
  async run(): Promise<void> {
    const { host, port } = parseRemoteAddress(this.opts.addr);
    // Attempt eager agent initialization
    try {
      this.agentHandle = await createRemoteAgent({
        provider: this.opts.providers[0],
        workDir: cwd(),
        hooks: this.opts.hookConfigs,
        mcpServers: this.opts.mcpServers,
        askUser: this.createAskUserCallback(),
        enableCoordinatorMode: this.opts.enableCoordinatorMode,
        forkDisabled: this.opts.forkDisabled,
      });
    } catch (err) {
      log.warn({ err }, "agent init deferred -- will retry on first message");
      this.agentHandle = null;
    }

    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(port, host, () => {
        resolve();
      });
    });
  }

  /** Stops the server and cleans up all connections. */
  stop(): void {
    this.cancelActiveRun();
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
    this.wss.close();
    this.server.close();
  }

  private cancelActiveRun(): void {
    this.agentHandle?.abort();
    this.compactController?.abort();
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
