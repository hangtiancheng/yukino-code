import { randomUUID } from "node:crypto";

import type { AgentEvent } from "@yukino.js/agent/events.js";
import type { ConversationManager } from "@yukino.js/conversation";
import { recordInput, type InputEntry } from "@yukino.js/history";
import { saveMessage, saveUserMessage } from "@yukino.js/session";
import { PLAN_AGENT_NAME } from "@yukino.js/subagent/constants.js";
import { runPlanAgent } from "@yukino.js/subagent/plan.js";
import type { ToolRegistry } from "@yukino.js/tools/registry.js";
import type { ToolContext, ToolResult } from "@yukino.js/tools/types.js";

import { SUBAGENT_COMMAND_UNAVAILABLE } from "./constants.js";

interface SubagentCommandContext extends ToolContext {
  registry: ToolRegistry;
  conversation: ConversationManager;
  sessionId: string;
  onEvent: (event: AgentEvent) => void;
  inputEntry?: InputEntry;
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
    if (role === "user") {
      const entry =
        context.inputEntry ??
        recordInput({
          cwd: context.cwd,
          sessionId: context.sessionId,
          source: "sdk",
          text: input,
        });
      saveUserMessage(context.cwd, context.sessionId, entry, { content });
      context.conversation.addUserMessage(content, entry);
    } else {
      saveMessage(context.cwd, context.sessionId, {
        role,
        content,
        timestamp: Math.floor(Date.now() / 1000),
      });
      context.conversation.addAssistantFull(content, [], []);
    }
  };
  record("user", input);
  const toolId = randomUUID();
  const args = {
    kind: "subagent",
    subagent_type: agentName,
    fork: agentName === PLAN_AGENT_NAME,
    description: input,
    prompt,
    run_in_background: false,
  };
  const start = Date.now();
  context.onEvent({ type: "tool_use", toolName: "Agent", toolId, args });
  const toolContext = { ...context, toolCallId: toolId };
  const result =
    agentName === PLAN_AGENT_NAME
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
