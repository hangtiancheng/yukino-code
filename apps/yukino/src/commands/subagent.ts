import { randomUUID } from "node:crypto";

import type { AgentEvent } from "@/agent/events.js";
import { SUBAGENT_COMMAND_UNAVAILABLE } from "@/commands/constants.js";
import type { ConversationManager } from "@/conversation/index.js";
import { saveMessage } from "@/session/index.js";
import { runPlanAgent } from "@/subagent/plan.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { ToolContext, ToolResult } from "@/tools/types.js";

interface SubagentCommandContext extends ToolContext {
  registry: ToolRegistry;
  conversation: ConversationManager;
  sessionId: string;
  onEvent: (event: AgentEvent) => void;
}

export async function runSubagentCommand(
  agentName: string,
  prompt: string,
  input: string,
  context: SubagentCommandContext,
): Promise<ToolResult> {
  context.abortSignal?.throwIfAborted();
  const agent = context.registry.get("Agent");
  if (!agent) {
    throw new Error(SUBAGENT_COMMAND_UNAVAILABLE);
  }

  const record = (role: "user" | "assistant", content: string) => {
    saveMessage(context.cwd, context.sessionId, {
      role,
      content,
      timestamp: Math.floor(Date.now() / 1000),
    });
    if (role === "user") {
      context.conversation.addUserMessage(content);
    } else {
      context.conversation.addAssistantFull(content, [], []);
    }
  };
  record("user", input);
  const toolId = randomUUID();
  const args = {
    subagent_type: agentName,
    fork: agentName === "plan",
    description: input,
    prompt,
    run_in_background: false,
  };
  const start = Date.now();
  context.onEvent({ type: "tool_use", toolName: "Agent", toolId, args });
  const toolContext = { ...context, toolCallId: toolId };
  const result =
    agentName === "plan"
      ? await runPlanAgent(context.registry, toolContext, prompt)
      : await agent.execute(toolContext, args);
  record("assistant", result.output);
  context.onEvent({
    type: "tool_result",
    toolName: "Agent",
    toolId,
    ...result,
    elapsed: (Date.now() - start) / 1000,
  });
  context.onEvent({ type: "stream_text", text: result.output });
  context.onEvent({ type: "turn_complete" });
  context.onEvent({
    type: "loop_complete",
    stopReason: context.abortSignal?.aborted
      ? "interrupted"
      : result.isError
        ? "error"
        : "end_turn",
  });
  return result;
}
