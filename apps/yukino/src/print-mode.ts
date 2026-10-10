import type { AgentEvent } from "./agent/events.js";
import { Agent } from "./agent/index.js";
import { configureBashSandbox } from "./bootstrap/sandbox.js";
import { createToolRegistry } from "./bootstrap/tool-registry.js";
import { parse as parseCommand } from "./commands/commands.js";
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
import { GoalManager, handleGoalCommand } from "./goal/index.js";
import { createClient } from "./llm/client.js";
import { MCPManager } from "./mcp/manager.js";
import { decideAndApply } from "./mcp/strategy.js";
import { MCPToolWrapper } from "./mcp/tool-wrapper.js";
import { loadInstructions } from "./memory/instructions.js";
import { PermissionChecker } from "./permissions/index.js";
import { buildSystemPrompt, detectEnvironment } from "./prompt/builder.js";
import {
  newSessionId,
  saveMessage,
  messageToKeptRecord,
} from "./session/index.js";
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
import { TaskList } from "./todo/index.js";
import { FileStateCache } from "./tools/file-state-cache.js";
import { attachBackgroundTaskManager } from "./tools/shell-background.js";
import { SyntheticOutputTool } from "./tools/synthetic-output.js";

type OutputFormat = "text" | "stream-json";

export interface PrintArgs {
  prompt: string;
  outputFormat: OutputFormat;
}

/** Returns null when -p mode is not active. */
export function parsePrintFlags(args: string[]): PrintArgs | null {
  const endOfOptions = args.indexOf("--");
  const options = args.slice(0, endOfOptions === -1 ? undefined : endOfOptions);
  const idx = options.indexOf("-p");
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
  const fmtIdx = options.findIndex(
    (arg, index) => arg === "--output-format" && index !== idx + 1,
  );
  if (fmtIdx !== -1) {
    const fmt = options[fmtIdx + 1];
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
 * - stream-json mode: emits incremental text/thinking, tool lifecycle, usage,
 *   recovery and completion events, plus task notifications and a final result
 */
export async function runPrintMode(args: PrintArgs): Promise<void> {
  const startTime = Date.now();
  const cwd = process.cwd();
  const sessionId = newSessionId();
  const abortController = new AbortController();
  const onInterrupt = (code: number) => {
    process.exitCode = code;
    abortController.abort();
    for (const task of backgroundTaskManager.list()) {
      backgroundTaskManager.stop(task.id);
    }
  };
  const onSigint = () => {
    onInterrupt(130);
  };
  const onSigterm = () => {
    onInterrupt(143);
  };

  const cfg = withProjectMcpServers(loadConfig(), cwd);
  const provider = resolveDefaultProvider(cfg.providers, cfg.default_provider);
  let prompt = args.prompt;
  const goalManager = new GoalManager(cwd, sessionId);
  const command = parseCommand(prompt);
  if (command?.name === "goal") {
    const result = handleGoalCommand(goalManager, command.args);
    if (args.outputFormat === "stream-json") {
      console.log(
        JSON.stringify({
          type: "goal",
          message: result.message,
          goal: goalManager.get(),
        }),
      );
    } else {
      console.log(result.message);
    }
    if (!result.prompt) {
      if (result.isError) {
        process.exitCode = 1;
      }
      if (args.outputFormat === "stream-json") {
        console.log(
          JSON.stringify({
            type: "result",
            result: result.message,
            duration_ms: Date.now() - startTime,
            num_turns: 0,
            tool_calls: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          }),
        );
      }
      return;
    }
    prompt = result.prompt;
  }

  const env = detectEnvironment(cwd);
  env.model = provider.model;
  const systemPrompt = buildSystemPrompt(env);

  const client = await createClient(provider, systemPrompt);

  const conv = new ConversationManager();
  conv.addUserMessage(prompt);
  saveMessage(cwd, sessionId, {
    role: "user",
    content: prompt,
    timestamp: Math.floor(Date.now() / 1000),
  });

  // Print mode intentionally bypasses permission prompts.
  const checker = new PermissionChecker(cwd, "bypassPermissions");

  const taskList = new TaskList();
  const teamManager = new TeamManager(cwd);
  const registry = createToolRegistry(cwd, taskList, {
    interactionMode: "non-interactive",
    teamManager,
    lspServers: cfg.lsp_servers,
  });
  await configureBashSandbox(registry, cwd, cfg.sandbox, checker);

  // Team tools are also available in -p mode, allowing the Leader to assemble
  // a team and delegate tasks within a single non-interactive execution.
  // Teams are not restored here; print mode manages only its own team runtimes.
  teamManager.setPermissionChecker(checker);
  const backgroundTaskManager = new TaskManager(sessionId);
  // Share the background task registry with the command tools registered here
  // (Bash/PowerShell) so run_in_background and timeout auto-background deliver
  // results through the same notification drain as background agents.
  attachBackgroundTaskManager(registry, backgroundTaskManager);
  registry.register(new TeamCreateTool(teamManager));
  registry.register(new SendMessageTool(teamManager));
  registry.register(new TeamDeleteTool(teamManager));
  registry.register(new TaskStopTool(teamManager, backgroundTaskManager));
  registry.register(new SyntheticOutputTool());

  const agentTool = new AgentTool(
    cwd,
    registry,
    (def, prompt, background, modelOverride, cwdOverride, context) =>
      spawnSubagent(
        def,
        prompt,
        client,
        registry,
        provider,
        cwdOverride ?? cwd,
        undefined,
        undefined,
        modelOverride,
        cwdOverride
          ? context?.permissionChecker?.forCwd(cwdOverride)
          : context?.permissionChecker,
        {
          sessionId: context?.subagentSessionId,
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
        context?.cwd ?? cwd,
        undefined,
        undefined,
        modelOverride,
        context?.permissionChecker,
        {
          agentName: "fork",
          conversation,
          sessionId: context?.subagentSessionId,
          abortSignal: context?.abortSignal,
          onPermissionRequest: context?.onPermissionRequest,
        },
      ),
    backgroundTaskManager,
  );
  agentTool.forkDisabled = !forkEnabled(cfg);
  agentTool.setTeamManager(
    teamManager,
    (teamRegistry, teamChecker, memberCwd = cwd, options) => {
      const conversation = new ConversationManager();
      return (task, onEvent, abortSignal) =>
        spawnSubagent(
          options?.definition ?? BUILTIN_AGENTS[0],
          task,
          client,
          teamRegistry,
          provider,
          memberCwd,
          undefined,
          onEvent,
          options?.modelOverride,
          teamChecker,
          // Teammates stay purely foreground: see SubagentRunOptions.backgroundTasks.
          {
            abortSignal,
            backgroundTasks: false,
            conversation,
            agentName: options?.agentName,
            onPermissionRequest: options?.onPermissionRequest,
          },
        );
    },
  );
  registry.register(agentTool);

  // Connect to MCP. Done after all built-in tools are registered: the MCP tool
  // load mode compares total schema size against the context window, so it only
  // computes accurately once all tools are in place.
  let mcpManager: MCPManager | undefined;
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
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
      cwd,
      sessionId,
      goalManager,
      abortSignal: abortController.signal,
      fileStateCache: new FileStateCache(),
      contextWindow: getContextWindow(provider),
      maxOutput: getMaxOutputTokens(provider),
      instructions: loadInstructions(cwd),
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
    const toolCalls: { tool: string; tool_id: string; elapsed: number }[] = [];
    const callsById = new Map<string, (typeof toolCalls)[number]>();
    const totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };

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
        case "tool_use": {
          const call = {
            tool: event.toolName,
            tool_id: event.toolId,
            elapsed: 0,
          };
          toolCalls.push(call);
          callsById.set(event.toolId, call);
          break;
        }
        case "tool_result": {
          const call = callsById.get(event.toolId);
          if (call) {
            call.elapsed = event.elapsed;
          }
          break;
        }
        case "turn_complete":
          numTurns++;
          break;
        case "usage":
          totalUsage.inputTokens += event.usage.inputTokens;
          totalUsage.outputTokens += event.usage.outputTokens;
          totalUsage.cacheReadInputTokens += event.usage.cacheReadInputTokens;
          totalUsage.cacheCreationInputTokens +=
            event.usage.cacheCreationInputTokens;
          break;
        case "error":
          if (!abortController.signal.aborted) {
            process.exitCode = 1;
          }
          if (args.outputFormat === "text") {
            console.error(`\nError: ${event.error.message}`);
          }
          break;
        case "loop_complete":
          if (
            event.stopReason === "interrupted" &&
            !abortController.signal.aborted
          ) {
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
      conv.addSystemReminder(notification);
      saveMessage(cwd, sessionId, {
        ...messageToKeptRecord(conv.getMessages()[conv.len() - 1]),
        timestamp: Math.floor(Date.now() / 1000),
      });
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
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    // Child agents otherwise outlive the single-shot Leader and shared MCP connections.
    await Promise.allSettled([
      backgroundTaskManager.stopAll(),
      teamManager.dispose(),
    ]);
    await Promise.allSettled([registry.dispose()]);
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
          tool_id: event.toolId,
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
          cache_read_input_tokens: event.usage.cacheReadInputTokens,
          cache_creation_input_tokens: event.usage.cacheCreationInputTokens,
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

    case "stream_text":
    case "thinking_text":
    case "turn_complete":
    case "loop_complete":
    case "steering_delivered":
    case "retry":
      console.log(JSON.stringify(event));
      break;

    case "compact":
      console.log(JSON.stringify({ type: "compact", message: event.message }));
      break;

    default:
      break;
  }
}
