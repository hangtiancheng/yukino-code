import { randomUUID } from "node:crypto";

import { z } from "zod";

import { createChildLogger } from "@/logger/index.js";
import {
  SLUG_INVALID_ERROR,
  WORKTREE_RUNTIME_REQUIRED_ERROR,
} from "@/tools/constants.js";
import {
  ENTER_WORKTREE_DESCRIPTION,
  WORKTREE_SLUG_DESCRIPTION,
} from "@/tools/prompts.js";
import { createToolSchema } from "@/tools/schema.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";
import {
  WORKTREE_ALREADY_ACTIVE_ERROR,
  WORKTREE_SLUG_PATTERN,
} from "@/worktree/constants.js";
import { createAgentWorktree } from "@/worktree/index.js";

const log = createChildLogger({ module: "tools" });

const inputSchema = z.strictObject({
  slug: z
    .string()
    .regex(WORKTREE_SLUG_PATTERN, SLUG_INVALID_ERROR)
    .optional()
    .describe(WORKTREE_SLUG_DESCRIPTION),
});

export class EnterWorktreeTool implements Tool {
  // Use a hardcoded string instead of EnterWorktreeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "EnterWorktree";

  description = ENTER_WORKTREE_DESCRIPTION;

  category: ToolCategory = "write";

  parameters() {
    return inputSchema;
  }

  schema(): ToolSchema {
    return createToolSchema(this.name, this.description, this.parameters());
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
    if (!checker) {
      return { output: WORKTREE_RUNTIME_REQUIRED_ERROR, isError: true };
    }
    if (checker.worktreeSession) {
      return {
        output: WORKTREE_ALREADY_ACTIVE_ERROR,
        isError: true,
      };
    }

    try {
      const slug = input.data.slug ?? randomUUID();
      const result = await createAgentWorktree(slug, undefined, ctx.cwd);
      await checker.enterWorktree(result, ctx.cwd);
      ctx.fileStateCache?.clear();
      return {
        output: `Entered worktree at ${result.path}\nBranch: ${result.branch}\nHead: ${result.headCommit}\nThe session is now working in the worktree. Use ExitWorktree with action: "keep" or "remove" to return to ${ctx.cwd}.`,
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "tool operation failed");
      return {
        output: `Error creating worktree: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}
