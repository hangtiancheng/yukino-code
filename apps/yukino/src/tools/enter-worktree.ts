/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
import { createAgentWorktree } from "@/worktree/index.js";

const log = createChildLogger({ module: "tools" });

export class EnterWorktreeTool implements Tool {
  // Use a hardcoded string instead of EnterWorktreeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "EnterWorktree";

  description = "Create and enter a git worktree for isolated work.";

  category: ToolCategory = "write";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        slug: {
          type: "string" as const,
          description: "Short identifier for the worktree (branch name suffix).",
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

  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const slug = strArg(args, "slug");
    if (!slug) {
      return Promise.resolve({
        output: "Error: slug is required",
        isError: true,
      });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return Promise.resolve({
        output: "Error: slug must contain only alphanumeric, hyphen, underscore",
        isError: true,
      });
    }

    try {
      const result = await createAgentWorktree(slug);
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
