import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

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

import {
  isImagePath,
  loadImageAttachment,
  sniffFileMediaType,
} from "@/images/index.js";
import { createChildLogger } from "@/logger/index.js";
import { asErrorString, isRecord } from "@/utils/index.js";
import { intArg, strArg } from "@/utils/index.js";
import { resolveToolPath } from "@/utils/paths.js";

const log = createChildLogger({ module: "tools" });
const DEFAULT_LIMIT = 2000;
const MAX_READ_BYTES = 50 * 1024;
// Whole-file read admission cap (memory bound; see the fileStat.size check).
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

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

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const requestedPath = strArg(args, "file_path");
    if (!requestedPath) {
      return {
        output: "Error: file_path is required",
        isError: true,
      };
    }

    const filePath = resolveToolPath(ctx.cwd, requestedPath);
    if (ctx.abortSignal?.aborted) {
      return { output: "Error: operation interrupted", isError: true };
    }
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(filePath);
    } catch (err) {
      return {
        output:
          isRecord(err) && err.code === "ENOENT"
            ? `Error: file not found: ${filePath}`
            : `Error reading file: ${asErrorString(err)}`,
        isError: true,
      };
    }
    if (fileStat.isDirectory()) {
      return {
        output: `Error: ${filePath} is a directory, not a file. Use Glob to list directory contents.`,
        isError: true,
      };
    }

    if (!fileStat.isFile()) {
      return {
        output: `Error: ${filePath} is not a regular file`,
        isError: true,
      };
    }

    let image: boolean;
    try {
      image =
        isImagePath(filePath) ||
        (await sniffFileMediaType(filePath, ctx.abortSignal)) !== null;
    } catch (error) {
      return {
        output: ctx.abortSignal?.aborted
          ? "Error: operation interrupted"
          : `Error reading file: ${asErrorString(error)}`,
        isError: true,
      };
    }
    if (image) {
      return this.readImage(ctx, filePath, fileStat.mtimeMs, fileStat.size);
    }

    // Admission check before buffering: the read below loads the whole file
    // into a string, so a multi-hundred-MB file would spike memory and stall
    // the loop long before the 50KB output cap could matter.
    if (fileStat.size > MAX_READ_FILE_BYTES) {
      return {
        output: `Error: ${filePath} is ${String(fileStat.size)} bytes, over the ${String(MAX_READ_FILE_BYTES)}-byte read limit. Use Grep with a pattern, or Bash with head/tail/sed, to inspect parts of it.`,
        isError: true,
      };
    }

    const offset = intArg(args, "offset", 0);
    const limit = intArg(args, "limit", DEFAULT_LIMIT);
    if (offset < 0 || limit < 1) {
      return {
        output: "Error: offset must be >= 0 and limit must be >= 1",
        isError: true,
      };
    }

    try {
      const content = await readFile(filePath, {
        encoding: "utf-8",
        signal: ctx.abortSignal,
      });
      const lines = content.split("\n");
      if (offset >= lines.length) {
        return {
          output: `Error: offset ${String(offset)} is beyond end of file (${String(lines.length)} lines total)`,
          isError: true,
        };
      }

      const slice = lines.slice(offset, offset + limit);
      const numbered: string[] = [];
      let outputBytes = 0;
      for (const [index, line] of slice.entries()) {
        const numberedLine = `${String(offset + index + 1)}\t${line}`;
        const lineBytes =
          utf8ByteLength(numberedLine) + (numbered.length > 0 ? 1 : 0);
        if (outputBytes + lineBytes > MAX_READ_BYTES) {
          if (numbered.length === 0) {
            return {
              output: `Error: line ${String(offset + index + 1)} exceeds the 50KB read limit; use Bash to inspect it in smaller chunks.`,
              isError: true,
            };
          }
          break;
        }
        numbered.push(numberedLine);
        outputBytes += lineBytes;
      }

      // Re-stat and compare against the pre-read stat: if the file changed
      // mid-read, refuse to register it so later edits work from fresh
      // content. Otherwise register the file as "read" in the state cache so
      // subsequent EditFile / WriteFile calls are allowed.
      const afterRead = await stat(filePath);
      if (
        afterRead.mtimeMs !== fileStat.mtimeMs ||
        afterRead.size !== fileStat.size
      ) {
        return {
          output: `Error: ${filePath} changed while it was being read; read it again before editing.`,
          isError: true,
        };
      }
      if (ctx.abortSignal?.aborted) {
        return { output: "Error: operation interrupted", isError: true };
      }
      ctx.fileStateCache?.record(filePath, fileStat.mtimeMs);

      const nextOffset = offset + numbered.length;
      const remaining = lines.length - nextOffset;
      if (remaining > 0) {
        numbered.push(
          `[${String(remaining)} more lines in file. Use offset=${String(nextOffset)} to continue.]`,
        );
      }
      return {
        output: numbered.join("\n"),
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "tool operation failed");
      return {
        output: ctx.abortSignal?.aborted
          ? "Error: operation interrupted"
          : `Error reading file: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }

  private async readImage(
    ctx: ToolContext,
    filePath: string,
    mtimeMs: number,
    size: number,
  ): Promise<ToolResult> {
    try {
      const attachment = await loadImageAttachment(filePath, ctx.abortSignal);
      const afterRead = await stat(filePath);
      if (afterRead.mtimeMs !== mtimeMs || afterRead.size !== size) {
        return {
          output: `Error: ${filePath} changed while it was being read; read it again before editing.`,
          isError: true,
        };
      }
      if (ctx.abortSignal?.aborted) {
        return { output: "Error: operation interrupted", isError: true };
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
        output: ctx.abortSignal?.aborted
          ? "Error: operation interrupted"
          : `Error reading image ${basename(filePath)}: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}
