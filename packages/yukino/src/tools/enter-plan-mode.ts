import { z } from "zod";

import { runPlanAgent } from "@/subagent/plan.js";
import { PLAN_AGENT_PROMPT } from "@/subagent/prompts.js";
import { ENTER_PLAN_MODE_DESCRIPTION } from "@/tools/prompts.js";
import type { ToolRegistry } from "@/tools/registry.js";
import { createToolSchema } from "@/tools/schema.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";

const EnterPlanModeToolInputSchema = z.strictObject({});

export class EnterPlanModeTool implements Tool {
  name = "EnterPlanMode";
  description = ENTER_PLAN_MODE_DESCRIPTION;
  category: ToolCategory = "read";

  constructor(private registry: ToolRegistry) {}

  isConcurrencySafe(): boolean {
    return false;
  }

  parameters() {
    return EnterPlanModeToolInputSchema;
  }

  schema(): ToolSchema {
    return createToolSchema(this.name, this.description, this.parameters(), {
      strict: true,
    });
  }

  execute(
    ctx: ToolContext,
    _args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const validated = this.parameters().safeParse(_args);
    if (!validated.success) {
      return Promise.resolve({
        output: validated.error.message,
        isError: true,
      });
    }
    _args = validated.data;

    return runPlanAgent(this.registry, ctx, PLAN_AGENT_PROMPT);
  }
}
