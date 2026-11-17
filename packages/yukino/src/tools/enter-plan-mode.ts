import { runPlanAgent } from "@/subagent/plan.js";
import { PLAN_AGENT_PROMPT } from "@/subagent/prompts.js";
import { ENTER_PLAN_MODE_DESCRIPTION } from "@/tools/prompts.js";
import type { ToolRegistry } from "@/tools/registry.js";
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
