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

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { EDIT_FILE_DESCRIPTION } from "./descriptions.js";
import { buildDiff } from "./diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "./types.js";

import { createChildLogger } from "@/logger/index.js";
import { boolArg, strArg } from "@/utils/index.js";
import { asErrorString } from "@/utils/index.js";

const log = createChildLogger({ module: "tools" });

export class EditFileTool implements Tool {
  // Use a hardcoded string instead of EditFileTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "EditFile";

  description = EDIT_FILE_DESCRIPTION;

  category: ToolCategory = "write";

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string" as const,
          description:
            "Path to the existing file, absolute or relative to the Agent's working directory. Read it first with ReadFile.",
        },
        old_string: {
          type: "string" as const,
          description:
            "Non-empty exact text to replace, including whitespace but excluding ReadFile line-number prefixes. Must match once unless replace_all is true.",
        },
        new_string: {
          type: "string" as const,
          description:
            "Replacement text. May be empty to delete the matched text; must differ from old_string.",
        },
        replace_all: {
          type: "boolean" as const,
          description: "Replace all occurrences of old_string (default false)",
          default: false,
        },
      },
      required: ["file_path", "old_string", "new_string"],
    };
    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const requestedPath = strArg(args, "file_path");
    const oldString = strArg(args, "old_string");
    const replaceAll = boolArg(args, "replace_all");

    if (!requestedPath) {
      return {
        output: "Error: file_path is required",
        isError: true,
      };
    }

    const filePath = resolve(ctx.workDir, requestedPath);
    if (!oldString) {
      return {
        output: "Error: old_string is required",
        isError: true,
      };
    }
    if (typeof args.new_string !== "string") {
      return {
        output: "Error: new_string is required",
        isError: true,
      };
    }
    const newString = args.new_string;

    if (oldString === newString) {
      return {
        output: "Error: old_string and new_string MUST be different",
        isError: true,
      };
    }

    return withFileMutationQueue(filePath, async () => {
      if (ctx.abortSignal?.aborted) {
        return { output: "Error: operation interrupted", isError: true };
      }
      // Gate: read-before-edit enforcement.
      if (ctx.fileStateCache) {
        const gate = ctx.fileStateCache.check(filePath);
        if (!gate.ok) {
          return { output: gate.error, isError: true };
        }
      }

      ctx.fileHistory?.trackEdit(filePath);

      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch (err) {
        log.error({ err }, "tool operation failed");
        return {
          output: `Error reading file: ${asErrorString(err)}`,
          isError: true,
        };
      }

      const count = content.split(oldString).length - 1;
      if (count === 0) {
        return {
          output: "Error: old_string not found in file",
          isError: true,
        };
      }

      if (!replaceAll && count > 1) {
        return {
          output: `Error: old_string found ${String(count)} times in file. It must be unique. Add more surrounding context, or set replace_all to true`,
          isError: true,
        };
      }

      // Function form inserts new_string verbatim: a string replacement
      // argument would interpret the JS special replacement patterns
      // (dollar-dollar, dollar-ampersand, dollar-backtick, dollar-quote) in it.
      const literal = (): string => newString;
      const newContent = replaceAll
        ? content.replaceAll(oldString, literal)
        : content.replace(oldString, literal);

      try {
        await writeFile(filePath, newContent, "utf-8");
        ctx.fileStateCache?.update(filePath);
        // Include the concrete diff rather than just saying "updated": both the model and UI need to know which lines changed
        const { text: diffText, additions, removals } = buildDiff(content, newContent);
        const summary =
          replaceAll && count > 1
            ? `Updated ${filePath} with ${String(additions)} addition${additions === 1 ? "" : "s"} and ${String(removals)} removal${removals === 1 ? "" : "s"} (${String(count)} replacements)`
            : `Updated ${filePath} with ${String(additions)} addition${additions === 1 ? "" : "s"} and ${String(removals)} removal${removals === 1 ? "" : "s"}`;
        return { output: `${summary}\n${diffText}`, isError: false };
      } catch (err) {
        log.error({ err }, "tool operation failed");
        return {
          output: `Error writing file: ${asErrorString(err)}`,
          isError: true,
        };
      }
    });
  }
}
