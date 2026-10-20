import { createChildLogger } from "@/logger/index.js";
import {
  SLUG_INVALID_ERROR,
  SLUG_REQUIRED_ERROR,
  WORKTREE_SLUG_PATTERN,
} from "@/tools/constants.js";
import { ENTER_WORKTREE_DESCRIPTION } from "@/tools/prompts.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";
import { strArg } from "@/utils/index.js";
import { createAgentWorktree } from "@/worktree/index.js";

const log = createChildLogger({ module: "tools" });

export class EnterWorktreeTool implements Tool {
  // Use a hardcoded string instead of EnterWorktreeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "EnterWorktree";

  description = ENTER_WORKTREE_DESCRIPTION;

  category: ToolCategory = "write";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        slug: {
          type: "string" as const,
          description:
            "Short identifier for the worktree (branch name suffix).",
        },
      },
      required: ["slug"],
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
    const slug = strArg(args, "slug");
    if (!slug) {
      return Promise.resolve({
        output: SLUG_REQUIRED_ERROR,
        isError: true,
      });
    }

    if (!WORKTREE_SLUG_PATTERN.test(slug)) {
      return Promise.resolve({
        output: SLUG_INVALID_ERROR,
        isError: true,
      });
    }

    try {
      const result = await createAgentWorktree(slug, undefined, ctx.cwd);
      await ctx.permissionChecker?.registerWorktree(result);
      return {
        output: `Worktree created at ${result.path}\nBranch: ${result.branch}\nHead: ${result.headCommit}`,
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
