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

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { WRITE_FILE_DESCRIPTION } from "./descriptions.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
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

export class WriteFileTool implements Tool {
  // Use a hardcoded string instead of WriteFileTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "WriteFile";

  description = WRITE_FILE_DESCRIPTION;

  category: ToolCategory = "write";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string" as const,
          description:
            "File path, absolute or relative to the Agent's working directory. Missing parent directories are created; existing files must be read first.",
        },
        content: {
          type: "string" as const,
          description:
            "Complete UTF-8 file contents. Replaces all existing content; an empty string creates or truncates an empty file.",
        },
      },
      required: ["file_path", "content"],
    };

    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const requestedPath = strArg(args, "file_path");
    if (!requestedPath) {
      return Promise.resolve({
        output: "Error: file_path is required",
        isError: true,
      });
    }
    if (typeof args.content !== "string") {
      return Promise.resolve({
        output: "Error: content is required",
        isError: true,
      });
    }
    const content = args.content;

    const filePath = resolve(ctx.workDir, requestedPath);
    return withFileMutationQueue<ToolResult>(filePath, () => {
      if (ctx.abortSignal?.aborted) {
        return Promise.resolve({
          output: "Error: operation interrupted",
          isError: true,
        });
      }
      // Gate: read-before-write enforcement (skip for genuinely new files).
      if (
        ctx.fileStateCache &&
        (existsSync(filePath) || ctx.fileStateCache.has(filePath))
      ) {
        const gate = ctx.fileStateCache.check(filePath);
        if (!gate.ok) {
          return Promise.resolve({ output: gate.error, isError: true });
        }
      }

      try {
        ctx.fileHistory?.trackEdit(filePath);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content, "utf-8");
        ctx.fileStateCache?.update(filePath);
        const lineCount = content.split("\n").length;
        return Promise.resolve({
          output: `Successfully wrote to ${filePath} (${String(lineCount)} lines)`,
          isError: false,
        });
      } catch (err) {
        log.error({ err }, "tool operation failed");
        return Promise.resolve({
          output: `Error writing file: ${asErrorString(err)}`,
          isError: true,
        });
      }
    });
  }
}
