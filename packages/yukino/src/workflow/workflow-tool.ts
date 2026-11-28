import { createToolSchema } from "@/tools/schema.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";
import { WORKFLOW_TOOL_NAME } from "@/workflow/constants.js";
import {
  WORKFLOW_TOOL_PROMPT,
  formatWorkflowLaunch,
} from "@/workflow/prompts.js";
import { workflowInputSchema } from "@/workflow/schema.js";
import type { WorkflowService } from "@/workflow/service.js";

export class WorkflowTool implements Tool {
  name = WORKFLOW_TOOL_NAME;
  description = WORKFLOW_TOOL_PROMPT;
  category = "command" as const;
  constructor(readonly service: WorkflowService) {}
  dispose(): Promise<void> {
    return this.service.shutdown();
  }
  isConcurrencySafe(): boolean {
    return true;
  }
  parameters() {
    return workflowInputSchema;
  }

  schema(): ToolSchema {
    return createToolSchema(this.name, this.description, this.parameters());
  }
  async execute(
    context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      const input = workflowInputSchema.parse(args);
      context.abortSignal?.throwIfAborted();
      const run = await this.service.launch(input, context);
      return { output: formatWorkflowLaunch(run), isError: false };
    } catch (error) {
      return { output: asErrorString(error), isError: true };
    }
  }
}
