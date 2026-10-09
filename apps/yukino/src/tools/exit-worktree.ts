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
import { hasWorktreeChanges, removeAgentWorktree } from "@/worktree/index.js";

const log = createChildLogger({ module: "tools" });
export class ExitWorktreeTool implements Tool {
  // Use a hardcoded string instead of ExitWorktreeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "ExitWorktree";
  description = "Exit and optionally cleanup a git worktree";

  category: ToolCategory = "write";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Worktree path" },
        branch: {
          type: "string" as const,
          description: "Worktree branch name",
        },
        git_root: {
          type: "string" as const,
          description: "Git root directory",
        },
        head_commit: {
          type: "string" as const,
          description: "Original HEAD commit for change detection",
        },
      },
      required: ["path", "branch", "git_root"],
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
    const branch = strArg(args, "branch");
    const gitRoot = strArg(args, "git_root");
    const headCommit = strArg(args, "head_commit");

    if (!path || !branch || !gitRoot) {
      return {
        output: "Error: path, branch and git_root are required",
        isError: true,
      };
    }

    if (!headCommit) {
      return {
        output: `Original head_commit was not provided; worktree kept at: ${path}\nBranch: ${branch}`,
        isError: false,
      };
    }

    const hasChanges = await hasWorktreeChanges(path, headCommit);

    if (!hasChanges) {
      try {
        await removeAgentWorktree(path, branch, gitRoot);
        return {
          output: `Worktree cleaned up (no changes): ${path}`,
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

    return {
      output: `Worktree has changes, kept at: ${path}\nBranch: ${branch}`,
      isError: false,
    };
  }
}
