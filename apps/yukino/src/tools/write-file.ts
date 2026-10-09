import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { WRITE_FILE_DESCRIPTION } from "./descriptions.js";
import { withWorkspaceMutation } from "./execution-coordinator.js";
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
import { resolveToolPath } from "@/utils/paths.js";

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
    return withWorkspaceMutation(ctx, this.name, args, () =>
      this.executeMutation(ctx, args),
    );
  }

  private async executeMutation(
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

    const filePath = resolveToolPath(ctx.cwd, requestedPath);
    return withFileMutationQueue<ToolResult>(filePath, async () => {
      if (ctx.abortSignal?.aborted) {
        return {
          output: "Error: operation interrupted",
          isError: true,
        };
      }
      // Gate: read-before-write enforcement (skip for genuinely new files).
      if (
        ctx.fileStateCache &&
        (existsSync(filePath) || ctx.fileStateCache.has(filePath))
      ) {
        const gate = ctx.fileStateCache.check(filePath);
        if (!gate.ok) {
          return { output: gate.error, isError: true };
        }
      }

      try {
        await mkdir(dirname(filePath), { recursive: true });
        if (ctx.abortSignal?.aborted) {
          return { output: "Error: operation interrupted", isError: true };
        }
        if (
          ctx.fileStateCache &&
          (existsSync(filePath) || ctx.fileStateCache.has(filePath))
        ) {
          const gate = ctx.fileStateCache.check(filePath);
          if (!gate.ok) {
            return { output: gate.error, isError: true };
          }
        }
        ctx.fileHistory?.trackEdit(filePath);
        await writeFile(filePath, content, "utf-8");
        ctx.fileStateCache?.update(filePath);
        const lineCount =
          content.length === 0
            ? 0
            : content.endsWith("\n")
              ? content.slice(0, -1).split("\n").length
              : content.split("\n").length;
        return {
          output: `Successfully wrote to ${filePath} (${String(lineCount)} lines)`,
          isError: false,
        };
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
