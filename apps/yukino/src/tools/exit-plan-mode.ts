import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";

import { loadPlan, planExists } from "@/plan-file/index.js";

export class ExitPlanModeTool implements Tool {
  // Use a hardcoded string instead of ExitPlanModeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "ExitPlanMode";
  description = `
  Exit plan mode and present the plan for user approval.
  Call this when your plan is complete and written to the plan file.
  `;
  category: ToolCategory = "read";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {},
    };

    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  execute(
    ctx: ToolContext,
    _args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (ctx.permissionChecker?.mode !== "plan") {
      if (ctx.permissionChecker && planExists(ctx.permissionChecker)) {
        return Promise.resolve({
          output:
            "You are not in plan mode. Continue within the user's requested scope and current permissions. Only the user can enter plan mode with /plan; AskUserQuestion is for clarification, not approval.",
          isError: true,
        });
      }
      return Promise.resolve({
        output:
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.",
        isError: true,
      });
    }

    if (
      !planExists(ctx.permissionChecker) ||
      !loadPlan(ctx.permissionChecker)?.trim()
    ) {
      return Promise.resolve({
        output:
          "No non-empty plan file found. Write your plan to the declared plan file before calling ExitPlanMode.",
        isError: true,
      });
    }

    return Promise.resolve({
      output:
        "Plan mode will be exited after this turn. The user will be shown the plan approval dialog. Do not call any more tools — end your turn now.",
      isError: false,
    });
  }
}
