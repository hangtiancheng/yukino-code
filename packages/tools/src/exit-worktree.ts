import { stat } from "node:fs/promises";

import { createChildLogger } from "@yukino.js/logger";
import { asErrorString } from "@yukino.js/utils";
import { NO_WORKTREE_SESSION_MESSAGE } from "@yukino.js/worktree/constants.js";
import { z } from "zod";

import {
  EXIT_WORKTREE_DESCRIPTION,
  WORKTREE_ACTION_DESCRIPTION,
  WORKTREE_DISCARD_CHANGES_DESCRIPTION,
} from "./prompts.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "./types.js";

const log = createChildLogger({ module: "tools" });

const inputSchema = z.strictObject({
  action: z.enum(["keep", "remove"]),
  discard_changes: z.boolean().optional(),
});
export class ExitWorktreeTool implements Tool {
  // Use a hardcoded string instead of ExitWorktreeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "ExitWorktree";
  description = EXIT_WORKTREE_DESCRIPTION;

  category: ToolCategory = "write";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["keep", "remove"],
          description: WORKTREE_ACTION_DESCRIPTION,
        },
        discard_changes: {
          type: "boolean" as const,
          description: WORKTREE_DISCARD_CHANGES_DESCRIPTION,
        },
      },
      required: ["action"],
      additionalProperties: false,
    };
    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const input = inputSchema.safeParse(args);
    if (!input.success) {
      return {
        output: `Error: ${input.error.message}`,
        isError: true,
      };
    }
    const checker = ctx.permissionChecker;
    const session = checker?.worktreeSession;
    if (!checker || !session) {
      return { output: NO_WORKTREE_SESSION_MESSAGE, isError: true };
    }
    try {
      if (!(await stat(session.originalCwd)).isDirectory()) {
        throw new Error(
          `Original working directory is unavailable: ${session.originalCwd}`,
        );
      }
      const changes =
        input.data.action === "remove"
          ? await checker.worktrees.remove(
              session.path,
              input.data.discard_changes ?? false,
            )
          : null;
      checker.leaveWorktree();
      ctx.fileStateCache?.clear();
      const result =
        input.data.action === "keep"
          ? `Your work is preserved at ${session.path} on branch ${session.branch}.`
          : `Removed worktree at ${session.path} and branch ${session.branch}.${changes ? ` Discarded ${changes.changedFiles} uncommitted files and ${changes.commits} commits.` : ""}`;
      return {
        output: `Exited worktree. ${result} Session is now back in ${session.originalCwd}.`,
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "tool operation failed");
      const missing = await stat(session.path).then(
        () => false,
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ENOENT",
      );
      if (missing) {
        checker.leaveWorktree();
        ctx.fileStateCache?.clear();
      }
      return {
        output: `Error exiting worktree: ${asErrorString(err)}${missing ? ` The worktree directory no longer exists. Session restored to ${session.originalCwd}; the branch may remain.` : ""}`,
        isError: true,
      };
    }
  }
}
