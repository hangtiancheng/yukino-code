import { getOrCreatePlanPath } from "@/plan-file/index.js";
import {
  PLAN_MODE_DELEGATED_ERROR,
  PLAN_MODE_UNAVAILABLE_ERROR,
} from "@/tools/constants.js";
import { ENTER_PLAN_MODE_DESCRIPTION } from "@/tools/prompts.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";

export class EnterPlanModeTool implements Tool {
  name = "EnterPlanMode";
  description = ENTER_PLAN_MODE_DESCRIPTION;
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
        output: PLAN_MODE_UNAVAILABLE_ERROR,
        isError: true,
      });
    }
    if (ctx.subagentSessionId || checker.isSubagent || checker.teammate) {
      return Promise.resolve({
        output: PLAN_MODE_DELEGATED_ERROR,
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
