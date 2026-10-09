import z from "zod";

import type { Tool, ToolContext, ToolResult, ToolSchema } from "./types.js";

const Args = z
  .object({
    action: z.enum(["get", "update"]),
    status: z.enum(["complete", "blocked"]).optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export class GoalTool implements Tool {
  name = "Goal";
  category = "read" as const;
  description =
    "Get the user-set persistent goal, or update it to complete or blocked with a reason. Never set or replace goals. Complete only when all work is achieved and verified. Record the same blocker on three consecutive continuation turns before stopping; multiple calls in one turn count once.";
  isConcurrencySafe(): boolean {
    return false;
  }
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "update"] },
          status: { type: "string", enum: ["complete", "blocked"] },
          reason: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    };
  }
  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return Promise.resolve(this.apply(ctx, args));
  }
  private apply(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
    try {
      ctx.abortSignal?.throwIfAborted();
      const input = Args.parse(args);
      if (!ctx.goalManager) {
        throw new Error(
          "Goals belong to the main session and are unavailable to delegated agents.",
        );
      }
      if (input.action === "get") {
        return { output: ctx.goalManager.format(), isError: false };
      }
      if (!input.status || !input.reason) {
        throw new Error("Updating a goal requires status and reason.");
      }
      return {
        output: ctx.goalManager.update(input.status, input.reason),
        isError: false,
      };
    } catch (error) {
      return {
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
