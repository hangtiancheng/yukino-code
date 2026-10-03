/* eslint-disable no-console -- non-interactive output mode: console.log is the program output channel */

import { rmSync } from "node:fs";

import type { AgentEvent } from "./agent/events.js";
import { Agent } from "./agent/index.js";
import {
  forkEnabled,
  loadConfig,
  withProjectMcpServers,
} from "./config/index.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  resolveDefaultProvider,
} from "./config/provider-config.js";
import { ConversationManager } from "./conversation/index.js";
import { createClient } from "./llm/client.js";
import { MCPManager } from "./mcp/manager.js";
import { decideAndApply } from "./mcp/strategy.js";
import { MCPToolWrapper } from "./mcp/tool-wrapper.js";
import { loadInstructions } from "./memory/instructions.js";
import { PermissionChecker } from "./permissions/index.js";
import { buildSystemPrompt, detectEnvironment } from "./prompt/builder.js";
import { getSessionArtifactsDir, newSessionId } from "./session/index.js";
import { AgentTool } from "./subagent/agent-tool.js";
import { BUILTIN_AGENTS } from "./subagent/definition.js";
import { spawnSubagent } from "./subagent/spawn.js";
import {
  TaskManager,
  formatAgentTaskNotification,
} from "./subagent/task-manager.js";
import {
  coordinatorToolFilter,
  coordinatorActive,
} from "./teams/coordinator.js";
import { TeamManager } from "./teams/index.js";
import { TaskStopTool } from "./teams/task-stop.js";
import {
  TeamCreateTool,
  SendMessageTool,
  TeamDeleteTool,
} from "./teams/tools.js";
import { BashTool } from "./tools/bash.js";
import { ComputerUseTool } from "./tools/computer-use.js";
import { EditFileTool } from "./tools/edit-file.js";
import { FileStateCache } from "./tools/file-state-cache.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { McpCallTool } from "./tools/mcp-call.js";
import { PowerShellTool } from "./tools/powershell.js";
import { ReadFileTool } from "./tools/read-file.js";
import { ToolRegistry } from "./tools/registry.js";
import { attachBackgroundTaskManager } from "./tools/shell-background.js";
import { SyntheticOutputTool } from "./tools/synthetic-output.js";
import { ToolSearchTool } from "./tools/tool-search.js";
import { WriteFileTool } from "./tools/write-file.js";

type OutputFormat = "text" | "stream-json";

export interface PrintArgs {
  prompt: string;
  outputFormat: OutputFormat;
}

/** Returns null when -p mode is not active. */
export function parsePrintFlags(args: string[]): PrintArgs | null {
  const idx = args.indexOf("-p");
  if (idx === -1) {
    return null;
  }

  const separator = args[idx + 1] === "--";
  const prompt = args[idx + (separator ? 2 : 1)];
  if (!prompt || (!separator && prompt.startsWith("-"))) {
    console.error(
      "Error: -p requires a prompt argument immediately after it; use '-p -- <prompt>' when the prompt starts with '-'",
    );
    process.exit(1);
  }

  let outputFormat: OutputFormat = "text";
  const fmtIdx = args.indexOf("--output-format");
  if (fmtIdx !== -1) {
    const fmt = args[fmtIdx + 1];
    if (fmt !== "text" && fmt !== "stream-json") {
      // Also catches a missing value at the end of the argument list.
      console.error(
        `Error: --output-format requires 'text' or 'stream-json' (got '${fmt ?? "nothing"}')`,
      );
      process.exit(1);
    }
    outputFormat = fmt;
  }

  return { prompt, outputFormat };
}

/**
 * Runs the Agent non-interactively and writes the result to stdout.
 * - text mode: emits the model's streamed text, followed by background
 *   task notifications
 * - stream-json mode: emits one JSON line per supported event (tool_use,
 *   tool_result, usage, error), plus task notifications and a final result
 *   summary
 */
export async function runPrintMode(args: PrintArgs): Promise<void> {
  const startTime = Date.now();
  const workDir = process.cwd();
  const sessionId = newSessionId();
  const abortController = new AbortController();
  const onInterrupt = (signal: NodeJS.Signals) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    abortController.abort();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  const cfg = withProjectMcpServers(loadConfig(), workDir);
  const provider = resolveDefaultProvider(cfg.providers, cfg.default_provider);

  const env = detectEnvironment(workDir);
  env.model = provider.model;
  const systemPrompt = buildSystemPrompt(env);

  const client = await createClient(provider, systemPrompt);

  const conv = new ConversationManager();
  conv.addUserMessage(args.prompt);

  // Print mode intentionally bypasses permission prompts.
  const checker = new PermissionChecker(workDir, "bypassPermissions");

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

  // Team tools are also available in -p mode, allowing the Leader to assemble
  // a team and delegate tasks within a single non-interactive execution.
  // Teams are NOT restored from disk here: the finally block stopAll()s every
  // team at exit, which would kill external teammates left running by an
  // interactive session.
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
  registry.register(new McpCallTool(registry));

  const agentTool = new AgentTool(
    workDir,
    registry,
    (def, prompt, background, modelOverride, workDirOverride, context) =>
      spawnSubagent(
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
      ),
    conv,
    (prompt, conversation, forkRegistry, modelOverride, context) =>
      spawnSubagent(
        BUILTIN_AGENTS[0],
        prompt,
        client,
        forkRegistry,
        provider,
        context?.workDir ?? workDir,
        undefined,
        undefined,
        modelOverride,
        context?.permissionChecker,
        {
          conversation,
          abortSignal: context?.abortSignal,
          onPermissionRequest: context?.onPermissionRequest,
        },
      ),
    backgroundTaskManager,
  );
  agentTool.forkDisabled = !forkEnabled(cfg);
  // No provider index: external teammates resolve `default_provider` from
  // the config — the same provider print mode runs with.
  agentTool.setTeamManager(
    teamManager,
    (teamRegistry, teamChecker, memberWorkDir = workDir) =>
      (task, onEvent, abortSignal) =>
        spawnSubagent(
          BUILTIN_AGENTS[0],
          task,
          client,
          teamRegistry,
          provider,
          memberWorkDir,
          undefined,
          onEvent,
          undefined,
          teamChecker,
          // Teammates stay purely foreground: see SubagentRunOptions.backgroundTasks.
          { abortSignal, backgroundTasks: false },
        ),
  );
  registry.register(agentTool);

  // Connect to MCP. Done after all built-in tools are registered: the MCP tool
  // load mode compares total schema size against the context window, so it only
  // computes accurately once all tools are in place.
  let mcpManager: MCPManager | undefined;
  try {
    if (cfg.mcp_servers && cfg.mcp_servers.length > 0) {
      mcpManager = new MCPManager();
      const result = await mcpManager.connectAll(cfg.mcp_servers);
      for (const { serverName, tool } of result.tools) {
        const client = mcpManager.getClient(serverName);
        if (client) {
          registry.register(new MCPToolWrapper(client, serverName, tool));
        }
      }
      for (const e of result.errors) {
        process.stderr.write(`MCP warning: ${e.serverName}: ${e.error}
`);
      }
      decideAndApply(
        registry,
        provider.base_url,
        provider.protocol,
        getContextWindow(provider),
      );
    }

    const agent = new Agent({
      client,
      registry,
      checker,
      conversation: conv,
      workDir,
      sessionId,
      abortSignal: abortController.signal,
      fileStateCache: new FileStateCache(),
      contextWindow: getContextWindow(provider),
      maxOutput: getMaxOutputTokens(provider),
      instructions: loadInstructions(workDir),
      // Completion reports are drained each turn as system reminders delivered to the Leader.
      notificationFn: () => [
        ...teamManager.drainLeaderMailbox(),
        ...backgroundTaskManager
          .drainNotifications()
          .map(formatAgentTaskNotification),
      ],
      toolFilter: coordinatorToolFilter(cfg.enable_coordinator_mode ?? false),
      coordinatorActiveFn: () =>
        coordinatorActive(cfg.enable_coordinator_mode ?? false),
    });

    let resultText = "";
    let numTurns = 0;
    const toolCalls: { tool: string; elapsed: number }[] = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of agent.run()) {
      if (args.outputFormat === "stream-json") {
        emitStreamJson(event);
      } else {
        if (event.type === "stream_text") {
          process.stdout.write(event.text);
        }
      }

      // Collect statistics; error and interrupted events also set the exit code.
      switch (event.type) {
        case "stream_text":
          resultText += event.text;
          break;
        case "tool_use":
          toolCalls.push({ tool: event.toolName, elapsed: 0 });
          break;
        case "tool_result":
          // Update elapsed time for the most recent matching tool call
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (
              toolCalls[i].tool === event.toolName &&
              toolCalls[i].elapsed === 0
            ) {
              toolCalls[i].elapsed = event.elapsed;
              break;
            }
          }
          break;
        case "turn_complete":
          numTurns++;
          break;
        case "usage":
          totalUsage.inputTokens += event.usage.inputTokens;
          totalUsage.outputTokens += event.usage.outputTokens;
          break;
        case "error":
          process.exitCode = 1;
          if (args.outputFormat === "text") {
            console.error(`\nError: ${event.error.message}`);
          }
          break;
        case "loop_complete":
          if (event.stopReason === "interrupted") {
            process.exitCode = 1;
          }
          break;
      }
    }

    // Wait only for background Agent tasks: their results feed the final
    // answer. Shell tasks (backgrounded Bash/PowerShell commands) can run
    // indefinitely (dev servers, auto-backgrounded timeouts) and would hang
    // -p mode forever — whatever finished by now is drained below, and the
    // finally block's stopAll() kills the rest.
    await backgroundTaskManager.waitAll(
      (task) => (task.kind ?? "agent") === "agent",
    );
    const backgroundNotifications = backgroundTaskManager.drainNotifications();
    const durationMs = Date.now() - startTime;

    if (
      args.outputFormat === "text" &&
      resultText &&
      !resultText.endsWith("\n")
    ) {
      process.stdout.write("\n");
    }
    for (const task of backgroundNotifications) {
      const notification = formatAgentTaskNotification(task);
      if (args.outputFormat === "stream-json") {
        console.log(
          JSON.stringify({ type: "task_notification", notification }),
        );
      } else {
        process.stdout.write(`${notification}\n`);
      }
    }

    // stream-json mode: emit final summary
    if (args.outputFormat === "stream-json") {
      const resultLine = {
        type: "result",
        result: resultText,
        duration_ms: durationMs,
        num_turns: numTurns,
        tool_calls: toolCalls,
        usage: totalUsage,
      };
      console.log(JSON.stringify(resultLine));
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    // Child agents otherwise outlive the single-shot Leader and shared MCP connections.
    await backgroundTaskManager.stopAll();
    await teamManager.stopAll();
    if (mcpManager) {
      try {
        await mcpManager.disconnectAll();
      } catch {
        // Cleanup must not mask an execution error or change the printed result.
      }
    }
    rmSync(getSessionArtifactsDir(workDir, sessionId), {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Emits an Agent event as a single JSON line to stdout (stream-json format).
 */
function emitStreamJson(event: AgentEvent): void {
  switch (event.type) {
    case "tool_use":
      console.log(
        JSON.stringify({
          type: "tool_use",
          tool_name: event.toolName,
          tool_id: event.toolId,
          args: event.args,
        }),
      );
      break;

    case "tool_result":
      console.log(
        JSON.stringify({
          type: "tool_result",
          tool_name: event.toolName,
          output: event.output,
          is_error: event.isError,
          elapsed: event.elapsed,
        }),
      );
      break;

    case "usage":
      console.log(
        JSON.stringify({
          type: "usage",
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
        }),
      );
      break;

    case "error":
      console.log(
        JSON.stringify({
          type: "error",
          message: event.error.message,
        }),
      );
      break;

    // stream_text, thinking_text, etc. are not emitted in stream-json mode
    // (text content is aggregated into the final result summary)
    default:
      break;
  }
}
