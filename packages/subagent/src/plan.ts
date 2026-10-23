import { savePlan } from "@yukino.js/plan-file";
import {
  PLAN_MODE_DELEGATED_ERROR,
  PLAN_MODE_UNAVAILABLE_ERROR,
} from "@yukino.js/tools/constants.js";
import type { ToolRegistry } from "@yukino.js/tools/registry.js";
import type { ToolContext, ToolResult } from "@yukino.js/tools/types.js";

import { AgentTool } from "./agent-tool.js";
import {
  EMPTY_PLAN_ERROR,
  NO_OUTPUT_MARKER,
  PLAN_AGENT_NAME,
  PLAN_AGENT_UNAVAILABLE_ERROR,
  SUBAGENT_INTERRUPTED_MARKER,
} from "./constants.js";

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
  const result = await agent.runBuiltin(PLAN_AGENT_NAME, ctx, prompt);
  if (result.isError) {
    return result;
  }
  if (
    ctx.abortSignal?.aborted ||
    result.output.includes(SUBAGENT_INTERRUPTED_MARKER)
  ) {
    return { ...result, isError: true };
  }
  if (!result.output.trim() || result.output === NO_OUTPUT_MARKER) {
    return { output: EMPTY_PLAN_ERROR, isError: true };
  }
  savePlan(checker, result.output);
  return result;
}
