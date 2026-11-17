import z from "zod";

import {
  GOAL_INVALID_ARGS_ERROR,
  GOAL_INVALID_STATUS_ERROR,
  GOAL_MAIN_SESSION_ONLY,
  GOAL_UPDATE_REQUIRES_STATUS_REASON,
} from "@/tools/constants.js";
import {
  GOAL_ACTION_DESCRIPTION,
  GOAL_DESCRIPTION,
  GOAL_REASON_DESCRIPTION,
  GOAL_STATUS_DESCRIPTION,
} from "@/tools/prompts.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";

const Args = z
  .object({
    action: z.enum(["get", "update"]),
    status: z.enum(["in_progress", "complete", "blocked"]).optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export class GoalTool implements Tool {
  name = "Goal";
  category = "read" as const;
  description = GOAL_DESCRIPTION;
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
            description: GOAL_ACTION_DESCRIPTION,
          },
          status: {
            type: "string",
            enum: ["in_progress", "complete", "blocked"],
            description: GOAL_STATUS_DESCRIPTION,
          },
          reason: {
            type: "string",
            description: GOAL_REASON_DESCRIPTION,
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
        throw new Error(GOAL_MAIN_SESSION_ONLY);
      }
      if (input.action === "get") {
        return { output: ctx.goalManager.format(), isError: false };
      }
      if (!input.status || !input.reason) {
        throw new Error(GOAL_UPDATE_REQUIRES_STATUS_REASON);
      }
      return {
        output: ctx.goalManager.update(input.status, input.reason),
        isError: false,
      };
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? error.issues.some((issue) => issue.path[0] === "status")
            ? GOAL_INVALID_STATUS_ERROR
            : GOAL_INVALID_ARGS_ERROR
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
