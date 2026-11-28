import type { z } from "zod";

import { createToolSchema } from "@/tools/schema.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";

export abstract class ValidatedTool<
  Input extends Record<string, unknown>,
> implements Tool {
  abstract name: string;
  abstract description: string;
  abstract category: ToolCategory;
  abstract parameters(): z.ZodType<Input>;

  schema(): ToolSchema {
    return createToolSchema(this.name, this.description, this.parameters());
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const input = this.parameters().safeParse(args);
    return input.success
      ? this.executeValidated(ctx, input.data)
      : { output: input.error.message, isError: true };
  }

  protected abstract executeValidated(
    ctx: ToolContext,
    args: Input,
  ): Promise<ToolResult>;
}
