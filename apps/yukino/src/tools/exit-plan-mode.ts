import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";

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

  isPlanMode: (() => boolean) | null = null;
  planExists: (() => boolean) | null = null;
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
    _ctx: ToolContext,
    _args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.isPlanMode && !this.isPlanMode()) {
      if (this.planExists?.()) {
        return Promise.resolve({
          output:
            "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. You can call AskUserQuestion tool to ask the user whether to execute the plan.",
          isError: true,
        });
      }
      return Promise.resolve({
        output:
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.",
        isError: true,
      });
    }

    if (this.planExists && !this.planExists()) {
      return Promise.resolve({
        output:
          "No plan file found. Please write your plan to the plan file before calling ExitPlanMode.",
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
