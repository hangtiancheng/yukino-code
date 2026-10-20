import { savePlan } from "@/plan-file/index.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import {
  EMPTY_PLAN_ERROR,
  PLAN_AGENT_UNAVAILABLE_ERROR,
  SUBAGENT_INTERRUPTED_MARKER,
} from "@/subagent/constants.js";
import {
  PLAN_MODE_DELEGATED_ERROR,
  PLAN_MODE_UNAVAILABLE_ERROR,
} from "@/tools/constants.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { ToolContext, ToolResult } from "@/tools/types.js";

export async function runPlanAgent(
  registry: ToolRegistry,
  ctx: ToolContext,
  prompt: string,
): Promise<ToolResult> {
  const checker = ctx.permissionChecker;
  if (!checker) {
    return { output: PLAN_MODE_UNAVAILABLE_ERROR, isError: true };
  }
  if (ctx.subagentSessionId || checker.isSubagent || checker.teammate) {
    return { output: PLAN_MODE_DELEGATED_ERROR, isError: true };
  }
  const agent = registry.get("Agent");
  if (!(agent instanceof AgentTool)) {
    return { output: PLAN_AGENT_UNAVAILABLE_ERROR, isError: true };
  }
  ctx.abortSignal?.throwIfAborted();
  checker.enterPlanMode();
  const result = await agent.runBuiltin("plan", ctx, prompt);
  if (result.isError) {
    return result;
  }
  if (
    ctx.abortSignal?.aborted ||
    result.output.includes(SUBAGENT_INTERRUPTED_MARKER)
  ) {
    return { ...result, isError: true };
  }
  if (!result.output.trim() || result.output === "[No output]") {
    return { output: EMPTY_PLAN_ERROR, isError: true };
  }
  savePlan(checker, result.output);
  return result;
}
