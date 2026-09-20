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

/* eslint-disable no-console -- non-interactive output mode: console.log is the program output channel */

import type { AgentEvent } from "./agent/events.js";
import { Agent } from "./agent/index.js";
import {
  forkEnabled,
  loadConfig,
  withProjectMcpServers,
} from "./config/index.js";
import { getContextWindow, getMaxOutputTokens } from "./config/index.js";
import { ConversationManager } from "./conversation/index.js";
import { createClient } from "./llm/client.js";
import { MCPManager } from "./mcp/manager.js";
import { decideAndApply } from "./mcp/strategy.js";
import { MCPToolWrapper } from "./mcp/tool-wrapper.js";
import { loadInstructions } from "./memory/instructions.js";
import { PermissionChecker } from "./permissions/index.js";
import { buildSystemPrompt, detectEnvironment } from "./prompt/builder.js";
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

/** Supported output formats for -p (print) mode. */
type OutputFormat = "text" | "stream-json";

/** Parsed arguments for -p mode. */
export interface PrintArgs {
  prompt: string;
  outputFormat: OutputFormat;
}

/**
 * Parses -p related command-line flags.
 * Returns null when -p mode is not active.
 */
export function parsePrintFlags(args: string[]): PrintArgs | null {
  const idx = args.indexOf("-p");
  if (idx === -1) {
    return null;
  }

  const prompt = args[idx + 1];
  if (!prompt) {
    console.error("Error: -p requires a prompt argument");
    process.exit(1);
  }

  // Parse --output-format (defaults to "text")
  let outputFormat: OutputFormat = "text";
  const fmtIdx = args.indexOf("--output-format");
  if (fmtIdx !== -1 && args[fmtIdx + 1]) {
    const fmt = args[fmtIdx + 1];
    if (fmt === "stream-json") {
      outputFormat = "stream-json";
    } else if (fmt !== "text") {
      console.error(
        `Error: unknown output format '${fmt}', expected 'text' or 'stream-json'`,
      );
      process.exit(1);
    }
  }

  return { prompt, outputFormat };
}

/**
 * Runs the Agent non-interactively and writes the result to stdout.
 * - text mode: emits only the model's text response
 * - stream-json mode: emits one JSON line per event
 */
export async function runPrintMode(args: PrintArgs): Promise<void> {
  const startTime = Date.now();
  const workDir = process.cwd();

  // Load configuration
  const cfg = withProjectMcpServers(loadConfig(), workDir);
  const provider = cfg.providers[0];

  // Build system prompt
  const env = detectEnvironment(workDir);
  env.model = provider.model;
  const systemPrompt = buildSystemPrompt(env);

  // Create LLM client
  const client = await createClient(provider, systemPrompt);

  const conv = new ConversationManager();
  conv.addUserMessage(args.prompt);

  // Print mode intentionally bypasses permission prompts.
  const checker = new PermissionChecker(workDir, "bypassPermissions");

  // Create tool registry and register core tools
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

  // Team tools are also available in -p mode, allowing the Lead to assemble a team and delegate
  // tasks within a single non-interactive execution
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
    provider.base_url,
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
      decideAndApply(registry, provider.base_url, getContextWindow(provider));
    }

    // Create Agent
    const agent = new Agent({
      client,
      registry,
      checker,
      conversation: conv,
      workDir,
      fileStateCache: new FileStateCache(),
      contextWindow: getContextWindow(provider),
      maxOutput: getMaxOutputTokens(provider),
      instructions: loadInstructions(workDir),
      // Completion reports are drained each turn as system reminders delivered to the Lead.
      notificationFn: () => [
        ...teamManager.drainLeads(),
        ...backgroundTaskManager
          .drainNotifications()
          .map(formatAgentTaskNotification),
      ],
      toolFilter: coordinatorToolFilter(cfg.enable_coordinator_mode ?? false),
      coordinatorActiveFn: () =>
        coordinatorActive(cfg.enable_coordinator_mode ?? false),
    });

    // Statistics
    let resultText = "";
    let numTurns = 0;
    const toolCalls: { tool: string; elapsed: number }[] = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0 };

    // Consume the Agent event stream
    for await (const event of agent.run()) {
      if (args.outputFormat === "stream-json") {
        emitStreamJson(event);
      } else {
        // text mode: emit only streamed text
        if (event.type === "stream_text") {
          process.stdout.write(event.text);
        }
      }

      // Collect statistics
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
    // answer. Shell/JS tasks can run indefinitely (dev servers, auto-backgrounded
    // timeouts) and would hang -p mode forever — whatever finished by now is
    // drained below, and the finally block's stopAll() kills the rest.
    await backgroundTaskManager.waitAll(
      (task) => (task.kind ?? "agent") === "agent",
    );
    const backgroundNotifications = backgroundTaskManager.drainNotifications();
    const durationMs = Date.now() - startTime;

    // text mode: ensure trailing newline
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
    // Child agents otherwise outlive the single-shot Lead and shared MCP connections.
    await backgroundTaskManager.stopAll();
    await teamManager.stopAll();
    if (mcpManager) {
      try {
        await mcpManager.disconnectAll();
      } catch {
        // Cleanup must not mask an execution error or change the printed result.
      }
    }
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
