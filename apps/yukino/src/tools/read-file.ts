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

import { existsSync, readFileSync, statSync } from "fs";
import { basename, resolve } from "path";

import { READ_FILE_DESCRIPTION } from "./descriptions.js";
import { utf8ByteLength } from "./shell-output.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolResultContentBlock,
  type ToolSchema,
} from "./types.js";

import { isImagePath, loadImageAttachment } from "@/images/index.js";
import { createChildLogger } from "@/logger/index.js";
import { asErrorString } from "@/utils/index.js";
import { intArg, strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "tools" });
const DEFAULT_LIMIT = 2000;
const MAX_READ_BYTES = 50 * 1024;

export class ReadFileTool implements Tool {
  // Use a hardcoded string instead of ReadFileTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "ReadFile";

  description = READ_FILE_DESCRIPTION;

  category: ToolCategory = "read";
  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string" as const,
          description:
            "File path, absolute or relative to the Agent's working directory. Supports text and image files.",
        },
        offset: {
          type: "integer" as const,
          description:
            "Number of text lines to skip (0-based). Use 0 for the first line, 100 for displayed line 101. Ignored for images.",
          minimum: 0,
          default: 0,
        },
        limit: {
          type: "integer" as const,
          description:
            "Maximum number of text lines to return (default 2000), subject to a 50KB output limit. Ignored for images.",
          minimum: 1,
          default: DEFAULT_LIMIT,
        },
      },
      required: ["file_path"],
    };

    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const requestedPath = strArg(args, "file_path");
    if (!requestedPath) {
      return Promise.resolve({
        output: "Error: file_path is required",
        isError: true,
      });
    }

    const filePath = resolve(ctx.workDir, requestedPath);
    if (!existsSync(filePath)) {
      return Promise.resolve({
        output: `Error: file not found: ${filePath}`,
        isError: true,
      });
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch (err) {
      return Promise.resolve({
        output: `Error reading file: ${asErrorString(err)}`,
        isError: true,
      });
    }
    if (stat.isDirectory()) {
      return Promise.resolve({
        output: `Error: ${filePath} is a directory, not a file. Use Glob to list directory contents.`,
        isError: true,
      });
    }

    if (isImagePath(filePath)) {
      return this.readImage(ctx, filePath, stat.mtimeMs, stat.size);
    }

    const offset = intArg(args, "offset", 0);
    const limit = intArg(args, "limit", DEFAULT_LIMIT);
    if (offset < 0 || limit < 1) {
      return Promise.resolve({
        output: "Error: offset must be >= 0 and limit must be >= 1",
        isError: true,
      });
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      if (offset >= lines.length) {
        return Promise.resolve({
          output: `Error: offset ${String(offset)} is beyond end of file (${String(lines.length)} lines total)`,
          isError: true,
        });
      }

      const slice = lines.slice(offset, offset + limit);
      const numbered: string[] = [];
      let outputBytes = 0;
      for (const [index, line] of slice.entries()) {
        const numberedLine = `${String(offset + index + 1)}\t${line}`;
        const lineBytes = utf8ByteLength(numberedLine) + (numbered.length > 0 ? 1 : 0);
        if (outputBytes + lineBytes > MAX_READ_BYTES) {
          if (numbered.length === 0) {
            return Promise.resolve({
              output: `Error: line ${String(offset + index + 1)} exceeds the 50KB read limit; use Bash to inspect it in smaller chunks.`,
              isError: true,
            });
          }
          break;
        }
        numbered.push(numberedLine);
        outputBytes += lineBytes;
      }

      // Register the file as "read" in the state cache so subsequent
      // EditFile / WriteFile calls are allowed.
      const afterRead = statSync(filePath);
      if (afterRead.mtimeMs !== stat.mtimeMs || afterRead.size !== stat.size) {
        return Promise.resolve({
          output: `Error: ${filePath} changed while it was being read; read it again before editing.`,
          isError: true,
        });
      }
      ctx.fileStateCache?.record(filePath, stat.mtimeMs);

      const nextOffset = offset + numbered.length;
      const remaining = lines.length - nextOffset;
      if (remaining > 0) {
        numbered.push(
          `[${String(remaining)} more lines in file. Use offset=${String(nextOffset)} to continue.]`,
        );
      }
      return Promise.resolve({
        output: numbered.join("\n"),
        isError: false,
      });
    } catch (err) {
      log.error({ err }, "tool operation failed");
      return Promise.resolve({
        output: `Error reading file: ${asErrorString(err)}`,
        isError: true,
      });
    }
  }

  private async readImage(
    ctx: ToolContext,
    filePath: string,
    mtimeMs: number,
    size: number,
  ): Promise<ToolResult> {
    try {
      const attachment = await loadImageAttachment(filePath);
      const afterRead = statSync(filePath);
      if (afterRead.mtimeMs !== mtimeMs || afterRead.size !== size) {
        return {
          output: `Error: ${filePath} changed while it was being read; read it again before editing.`,
          isError: true,
        };
      }
      ctx.fileStateCache?.record(filePath, mtimeMs);
      const imageBlock = {
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mediaType,
          data: attachment.data,
        },
      } satisfies ToolResultContentBlock;
      return {
        output: `[Image: ${attachment.mediaType}]`,
        contentBlocks: [imageBlock],
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "image read failed");
      return {
        output: `Error reading image ${basename(filePath)}: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}
