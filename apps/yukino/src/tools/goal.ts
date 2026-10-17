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
    "Get the user-set persistent goal, or report complete or blocked with a reason. These are the only statuses the model can set. A goal is active automatically when the user sets it; do not mark it in progress. Only the user can set, replace, pause, resume, or clear goals. Complete only when all requirements are achieved and verified. Record the same blocker on three consecutive continuation turns before stopping; multiple calls in one turn count once.";
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
          action: {
            type: "string",
            enum: ["get", "update"],
            description: "Read goal status, or report completion/blockage.",
          },
          status: {
            type: "string",
            enum: ["complete", "blocked"],
            description:
              "Required for update. Only complete or blocked are accepted; a set goal is already active.",
          },
          reason: {
            type: "string",
            description:
              "Required for update. Evidence of completion or the specific blocker.",
          },
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
      const message =
        error instanceof z.ZodError
          ? error.issues.some((issue) => issue.path[0] === "status")
            ? "Goal update accepts only 'complete' or 'blocked'. A goal is active as soon as the user sets it; there is no in_progress transition. Only the user can pause or resume a goal."
            : "Goal expects action 'get' or 'update'. Updating requires status 'complete' or 'blocked' and a non-empty reason; no other fields are accepted."
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        output: `Error: ${message}`,
        isError: true,
      };
    }
  }
}
