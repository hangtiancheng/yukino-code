import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "./types.js";

import { createChildLogger } from "@/logger/index.js";
import { asErrorString } from "@/utils/index.js";
import { strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "tools" });
export class ExitWorktreeTool implements Tool {
  // Use a hardcoded string instead of ExitWorktreeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "ExitWorktree";
  description =
    "Clean up a git worktree previously created by EnterWorktree, identified by " +
    "its path. Does not change the working directory. A worktree with " +
    "uncommitted changes is retained for explicit integration, not deleted.";

  category: ToolCategory = "write";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Worktree path" },
      },
      required: ["path"],
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
    const path = strArg(args, "path");
    if (!path || !ctx.permissionChecker) {
      return {
        output: "Error: path and runtime worktree ownership are required",
        isError: true,
      };
    }
    try {
      return {
        output: await ctx.permissionChecker.worktrees.cleanup(path),
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "tool operation failed");
      return {
        output: `Error cleaning up worktree: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}
