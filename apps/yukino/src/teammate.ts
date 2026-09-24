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

import { basename, dirname, join } from "node:path";

import { Agent } from "./agent/index.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  loadConfig,
  withProjectMcpServers,
} from "./config/index.js";
import type { MCPServerConfig } from "./config/index.js";
import { ConversationManager } from "./conversation/index.js";
import { createClient } from "./llm/client.js";
import {
  initLogger,
  closeLogger,
  createChildLogger,
  sanitizeNameSegment,
} from "./logger/index.js";
import { MCPManager } from "./mcp/manager.js";
import { decideAndApply } from "./mcp/strategy.js";
import { MCPToolWrapper } from "./mcp/tool-wrapper.js";
import { loadInstructions } from "./memory/instructions.js";
import { PermissionChecker } from "./permissions/index.js";
import { buildSystemPrompt, detectEnvironment } from "./prompt/builder.js";
import { buildTeammatePrompt } from "./prompt/delegation.js";
import { SkillCatalog } from "./skills/catalog.js";
import { buildSkillSection } from "./skills/catalog.js";
import type { SkillHost } from "./skills/index.js";
import { InstallSkillTool } from "./skills/install-tool.js";
import { LoadSkillTool } from "./skills/load-skill-tool.js";
import type { FileMailMessage } from "./teams/file-mailbox.js";
import { FileMailbox } from "./teams/file-mailbox.js";
import { TeamManager } from "./teams/index.js";
import {
  TeamTaskCreateTool,
  TeamTaskGetTool,
  TeamTaskListTool,
  TeamTaskUpdateTool,
} from "./teams/task-tools.js";
import { SendMessageTool } from "./teams/tools.js";
import { BashTool } from "./tools/bash.js";
import { EditFileTool } from "./tools/edit-file.js";
import { EnterWorktreeTool } from "./tools/enter-worktree.js";
import { ExitWorktreeTool } from "./tools/exit-worktree.js";
import { FileStateCache } from "./tools/file-state-cache.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { McpCallTool } from "./tools/mcp-call.js";
import { PowerShellTool } from "./tools/powershell.js";
import { ReadFileTool } from "./tools/read-file.js";
import { ToolRegistry } from "./tools/registry.js";
import { SyntheticOutputTool } from "./tools/synthetic-output.js";
import { ToolSearchTool } from "./tools/tool-search.js";
import { WriteFileTool } from "./tools/write-file.js";

interface TeammateArgs {
  teamDir: string;
  teamName: string;
  memberName: string;
  initialTask: string;
  providerBaseUrl?: string;
}

export function parseTeammateFlags(args: string[]): TeammateArgs | null {
  if (!args.includes("--teammate")) {
    return null;
  }

  let teamDir = "";
  let teamName = "";
  let memberName = "";
  let initialTask = "";
  let providerBaseUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--team-dir" && args[i + 1]) {
      teamDir = args[++i];
    }
    if (args[i] === "--team-name" && args[i + 1]) {
      teamName = args[++i];
    }

    if (args[i] === "--member-name" && args[i + 1]) {
      memberName = args[++i];
    }
    if (args[i] === "--task" && args[i + 1]) {
      initialTask = args[++i];
    }
    if (args[i] === "--provider-base-url" && args[i + 1]) {
      providerBaseUrl = args[++i];
    }
  }

  // The team name resolves the shared task board. When the flag is absent,
  // derive it from the mailbox directory path: the mailbox dir is
  // <team-dir>/inboxes, so the team name is one level up.
  if (!teamName) {
    const leaf = basename(teamDir);
    teamName = leaf === "inboxes" ? basename(dirname(teamDir)) : leaf;
  }
  return { teamDir, teamName, memberName, initialTask, providerBaseUrl };
}

// ShutdownPrefix marks a mailbox message as a request to terminate the teammate.
const ShutdownPrefix = "[shutdown]";

// LeadName is the conventional mailbox recipient for the coordinator.
const LeadName = "lead";

// Module-level child logger for teammate process.
const log = createChildLogger({ module: "teammate" });

function isShutdownRequest(msg: FileMailMessage): boolean {
  return msg.text.trimStart().startsWith(ShutdownPrefix);
}

function createIdleNotification(memberName: string): FileMailMessage {
  return {
    from: memberName,
    text: `[idle] ${memberName} has completed their task and is waiting for new instructions.`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Assemble the teammate tool registry: file/command tools, tool search,
 * worktree switching, Skills, and MCP extensions, plus team collaboration
 * tools (SendMessage under the member's own name, and the shared task board).
 * The task board resolves to a single tasks.json by team name, so all
 * teammates operate on the same board.
 *
 * Agent is intentionally excluded — the call tree terminates at the teammate
 * level. TeamCreate and TeamDelete are also excluded; team lifecycle
 * management is the Lead's responsibility.
 */
export async function buildTeammateRegistry(opts: {
  workDir: string;
  teamName: string;
  memberName: string;
  catalog: SkillCatalog;
  skillHost: SkillHost;
  mcpServers?: MCPServerConfig[];
  /** The running teammate retains this manager and disconnects it on exit. */
  mcpManager?: MCPManager;
  /** Used to decide the MCP loading mode: total schema volume is weighed against the context window */
  baseUrl?: string;
  contextWindow?: number;
}): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new BashTool());
  registry.register(new PowerShellTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());

  registry.register(new ToolSearchTool(registry));
  registry.register(new McpCallTool(registry));
  registry.register(new SyntheticOutputTool());
  registry.register(new EnterWorktreeTool());
  registry.register(new ExitWorktreeTool());

  // No forkHost is provided; skills declaring fork mode fall back to inline execution
  registry.register(new LoadSkillTool(opts.catalog, opts.skillHost));
  registry.register(new InstallSkillTool(opts.workDir, opts.catalog));

  const teamManager = new TeamManager(opts.workDir);
  registry.register(new SendMessageTool(teamManager, opts.memberName));
  registry.register(
    new TeamTaskCreateTool(teamManager, opts.teamName, opts.memberName),
  );
  registry.register(new TeamTaskGetTool(teamManager, opts.teamName));
  registry.register(new TeamTaskListTool(teamManager, opts.teamName));
  registry.register(new TeamTaskUpdateTool(teamManager, opts.teamName));

  const mcpServers = opts.mcpServers ?? [];
  if (mcpServers.length > 0) {
    try {
      const mgr = opts.mcpManager ?? new MCPManager();
      const result = await mgr.connectAll(mcpServers);
      for (const { serverName, tool } of result.tools) {
        const client = mgr.getClient(serverName);
        if (client) {
          registry.register(new MCPToolWrapper(client, serverName, tool));
        }
      }
      for (const { serverName, error } of result.errors) {
        log.error({ serverName, error }, "MCP connection error");
      }
      // Decide the loading mode only after all tools have been registered
      if (result.tools.length > 0 && opts.contextWindow) {
        decideAndApply(registry, opts.baseUrl ?? "", opts.contextWindow);
      }
    } catch (err) {
      // MCP connectivity failures should not crash the teammate process
      log.error({ err }, "MCP setup failed");
    }
  }

  return registry;
}

export async function runTeammate(args: TeammateArgs): Promise<void> {
  // Initialize logger for this teammate subprocess. Subprocess skips cleanup
  // to avoid multi-process races on unlinkSync.
  // args.teamDir is the mailbox dir (~/.yukino/teams/<team>/inboxes); logs
  // live in the sibling logs/ dir, which cleanExpiredLogs scans.
  const safeMemberName = sanitizeNameSegment(args.memberName);
  initLogger({
    sessionId: `teammate-${safeMemberName}-${Date.now().toString(36)}`,
    mode: "teammate",
    logDir: join(dirname(args.teamDir), "logs"),
    skipCleanup: true,
  });
  process.on("exit", closeLogger);

  let mcpManager: MCPManager | undefined;
  try {
    const workDir = process.cwd();
    const cfg = withProjectMcpServers(loadConfig(), workDir);
    const provider = args.providerBaseUrl
      ? cfg.providers.find((p) => p.base_url === args.providerBaseUrl)
      : cfg.providers[0];
    if (!provider) {
      throw new Error(
        `Provider with base URL "${args.providerBaseUrl ?? ""}" is not configured.`,
      );
    }
    const conversation = new ConversationManager();

    // The skill catalog feeds both the system prompt (so the model knows which
    // skills are available) and the LoadSkill tool (for on-demand activation)
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    const skillHost: SkillHost = {
      activateSkill: (name, body) => {
        conversation.addSystemReminder(
          `<skill-name>${name}</skill-name>\n${body}`,
        );
      },
    };

    const env = detectEnvironment(workDir);
    env.model = provider.model;
    // The system prompt contains only project-agnostic product definitions; the skill
    // listing is project-scoped and injected via the first system-reminder message
    const systemPrompt = buildSystemPrompt(env);
    const client = await createClient(provider, systemPrompt);

    if (cfg.mcp_servers?.length) {
      mcpManager = new MCPManager();
    }
    const registry = await buildTeammateRegistry({
      workDir,
      teamName: args.teamName,
      memberName: args.memberName,
      catalog,
      skillHost,
      mcpServers: cfg.mcp_servers,
      mcpManager,
      baseUrl: provider.base_url,
      contextWindow: getContextWindow(provider),
    });

    const checker = new PermissionChecker(workDir, "acceptEdits");

    const agent = new Agent({
      client,
      registry,
      checker,
      conversation,
      workDir,
      fileStateCache: new FileStateCache(),
      skillSection: buildSkillSection(catalog, workDir),
      instructions: loadInstructions(workDir),
      contextWindow: getContextWindow(provider),
      maxOutput: getMaxOutputTokens(provider),
    });

    conversation.addUserMessage(
      buildTeammatePrompt(args.teamName, args.memberName, args.initialTask),
    );

    for await (const event of agent.run()) {
      switch (event.type) {
        case "stream_text":
          process.stdout.write(event.text);
          break;
        case "tool_result":
          // eslint-disable-next-line no-console -- teammate stdout output
          console.log(
            `[${event.toolName}] ${event.isError ? "ERROR" : "OK"} (${event.elapsed.toFixed(1)}s)`,
          );
          break;
        case "loop_complete":
          // eslint-disable-next-line no-console -- teammate stdout output
          console.log("--- Task complete ---");
          break;
        case "error":
          log.error({ err: event.error }, "agent error");
          throw event.error;
      }
    }

    // Notify the lead that this teammate finished its initial task.
    const mailbox = new FileMailbox(args.teamDir, args.memberName);
    const leadMailbox = new FileMailbox(args.teamDir, LeadName);
    await leadMailbox.send(
      args.memberName,
      createIdleNotification(args.memberName).text,
    );

    // Poll mailbox for follow-up messages
    for await (const msg of mailbox.poll(2000)) {
      // Graceful shutdown: stop polling and exit when the lead requests it.
      if (isShutdownRequest(msg)) {
        // eslint-disable-next-line no-console -- teammate stdout output
        console.log(`Shutdown requested, ${args.memberName} exiting.`);
        break;
      }

      // eslint-disable-next-line no-console -- teammate stdout output
      console.log(`Message from ${msg.from}: ${msg.text}`);
      conversation.addUserMessage(msg.text);
      for await (const event of agent.run()) {
        if (event.type === "stream_text") {
          process.stdout.write(event.text);
        } else if (event.type === "error") {
          log.error({ err: event.error }, "agent error");
          throw event.error;
        }
      }

      // Notify the lead after completing each follow-up task.
      await leadMailbox.send(
        args.memberName,
        createIdleNotification(args.memberName).text,
      );
    }
  } finally {
    if (mcpManager) {
      try {
        await mcpManager.disconnectAll();
      } catch (err) {
        log.error({ err }, "MCP cleanup failed");
      }
    }
    process.off("exit", closeLogger);
    closeLogger();
  }
}
