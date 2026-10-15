import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";

import { getOrCreatePlanPath } from "@/plan-file/index.js";

export class EnterPlanModeTool implements Tool {
  name = "EnterPlanMode";
  description = `Use this tool proactively before a non-trivial implementation when the right approach is genuinely unclear and user review would prevent significant rework. It enters a read-only exploration phase where you inspect the codebase, compare approaches, write a concrete plan, and then call ExitPlanMode for approval.

Use it for significant architectural ambiguity, unclear requirements that require exploration, or high-impact restructuring. Skip it when the task is straightforward, the user has already specified the implementation, the fix is obvious after diagnosis, or the request is pure research. Do not use it from delegated agents. This tool takes no parameters.`;
  category: ToolCategory = "read";

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      strict: true,
      input_schema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
  }

  execute(
    ctx: ToolContext,
    _args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const checker = ctx.permissionChecker;
    if (!checker) {
      return Promise.resolve({
        output:
          "Plan mode is unavailable because no permission context exists.",
        isError: true,
      });
    }
    if (ctx.subagentSessionId || checker.isSubagent || checker.teammate) {
      return Promise.resolve({
        output: "EnterPlanMode cannot be used from delegated agents.",
        isError: true,
      });
    }
    if (checker.mode === "plan") {
      return Promise.resolve({
        output:
          "Already in plan mode. Continue exploring and update the plan file before calling ExitPlanMode.",
        isError: false,
      });
    }

    checker.enterPlanMode();
    const planPath = getOrCreatePlanPath(checker);
    return Promise.resolve({
      output:
        `Entered plan mode. Plan file: ${planPath}\n\n` +
        "Focus on read-only exploration and design. Do not modify project files. Write the final plan to the plan file, then call ExitPlanMode for user approval.",
      isError: false,
    });
  }
}
