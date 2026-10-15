import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";

import { loadPlan, planExists } from "@/plan-file/index.js";
import { asErrorString } from "@/utils/index.js";

export class ExitPlanModeTool implements Tool {
  // Use a hardcoded string instead of ExitPlanModeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "ExitPlanMode";
  description =
    "Submit the completed plan from the plan file. The main agent presents it for user approval; a teammate follows the host's team approval policy (leader review in coordinator mode, automatic approval otherwise); a one-shot subagent returns it to the parent. Do not implement until the host approves execution.";
  category: ToolCategory = "read";

  constructor(
    private submitTeammatePlan?: (plan: string) => string,
    private requiresLeaderApproval = false,
  ) {}

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
            "You are not in plan mode. Continue within the user's requested scope and current permissions, or call EnterPlanMode first when the task genuinely needs planning. AskUserQuestion is for clarification, not approval.",
          isError: true,
        });
      }
      return Promise.resolve({
        output:
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.",
        isError: true,
      });
    }

    const plan = loadPlan(ctx.permissionChecker);
    if (!planExists(ctx.permissionChecker) || !plan?.trim()) {
      return Promise.resolve({
        output:
          "No non-empty plan file found. Write your plan to the declared plan file before calling ExitPlanMode.",
        isError: true,
      });
    }

    if (ctx.permissionChecker.teammate) {
      if (!this.submitTeammatePlan) {
        return Promise.resolve({
          output:
            "No leader plan approval handler is available for this teammate.",
          isError: true,
        });
      }
      try {
        const requestId = this.submitTeammatePlan(plan);
        return Promise.resolve({
          output: `Plan submitted. Request ID: ${requestId}. ${this.requiresLeaderApproval ? "Stay in plan mode until the leader reviews it and responds. The host will resume you with approval or revision feedback." : "The host will automatically approve the plan and resume execution under current tool permissions."} End this turn now.`,
          isError: false,
        });
      } catch (error) {
        return Promise.resolve({ output: asErrorString(error), isError: true });
      }
    }

    if (ctx.permissionChecker.isSubagent || ctx.subagentSessionId) {
      return Promise.resolve({
        output: `Plan ready for the parent agent:\n\n${plan}\n\nEnd this turn now. This subagent remains read-only; the parent decides how to proceed.`,
        isError: false,
      });
    }

    return Promise.resolve({
      output:
        "Plan mode will be exited after this turn. The user will be shown the plan approval dialog. Do not call any more tools — end your turn now.",
      isError: false,
    });
  }
}
