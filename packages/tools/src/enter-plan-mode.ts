import { runPlanAgent } from "@yukino.js/subagent/plan.js";
import { PLAN_AGENT_PROMPT } from "@yukino.js/subagent/prompts.js";
import { ENTER_PLAN_MODE_DESCRIPTION } from "./prompts.js";
import type { ToolRegistry } from "./registry.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";

export class EnterPlanModeTool implements Tool {
  name = "EnterPlanMode";
  description = ENTER_PLAN_MODE_DESCRIPTION;
  category: ToolCategory = "read";

  constructor(private registry: ToolRegistry) {}

  isConcurrencySafe(): boolean {
    return false;
  }

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
    return runPlanAgent(this.registry, ctx, PLAN_AGENT_PROMPT);
  }
}
