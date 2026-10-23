import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@yukino.js/tools/types.js";
import { asErrorString } from "@yukino.js/utils";
import { z } from "zod";

import { WORKFLOW_TOOL_NAME } from "./constants.js";
import { WORKFLOW_TOOL_PROMPT, formatWorkflowLaunch } from "./prompts.js";
import { workflowInputSchema } from "./schema.js";
import type { WorkflowService } from "./service.js";

const ToolInputSchema = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string(), z.looseObject({})),
  required: z.array(z.string()).optional(),
});

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
  schema(): ToolSchema {
    const { $schema: _schema, ...input } = z.toJSONSchema(workflowInputSchema, {
      target: "draft-7",
      io: "input",
    });
    return {
      name: this.name,
      description: this.description,
      input_schema: ToolInputSchema.parse(input),
    };
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
