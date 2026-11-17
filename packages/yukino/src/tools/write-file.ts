import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createChildLogger } from "@/logger/index.js";
import { writeFileAtomically } from "@/tools/atomic-write.js";
import {
  CONTENT_REQUIRED_ERROR,
  FILE_PATH_REQUIRED_ERROR,
  OPERATION_INTERRUPTED_ERROR,
} from "@/tools/constants.js";
import { withWorkspaceMutation } from "@/tools/execution-coordinator.js";
import { withFileMutationQueue } from "@/tools/file-mutation-queue.js";
import {
  WRITE_FILE_CONTENT_DESCRIPTION,
  WRITE_FILE_DESCRIPTION,
  WRITE_FILE_FILE_PATH_DESCRIPTION,
} from "@/tools/prompts.js";
import {
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "@/tools/types.js";
import { asErrorString, strArg } from "@/utils/index.js";
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
          description: WRITE_FILE_FILE_PATH_DESCRIPTION,
        },
        content: {
          type: "string" as const,
          description: WRITE_FILE_CONTENT_DESCRIPTION,
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
        output: FILE_PATH_REQUIRED_ERROR,
        isError: true,
      });
    }
    if (typeof args.content !== "string") {
      return Promise.resolve({
        output: CONTENT_REQUIRED_ERROR,
        isError: true,
      });
    }
    const content = args.content;

    const filePath = resolveToolPath(ctx.cwd, requestedPath);
    return withFileMutationQueue<ToolResult>(filePath, async () => {
      if (ctx.abortSignal?.aborted) {
        return {
          output: OPERATION_INTERRUPTED_ERROR,
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
          return { output: OPERATION_INTERRUPTED_ERROR, isError: true };
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
        await writeFileAtomically(filePath, content, ctx.abortSignal);
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
          output: ctx.abortSignal?.aborted
            ? OPERATION_INTERRUPTED_ERROR
            : `Error writing file: ${asErrorString(err)}`,
          isError: true,
        };
      }
    });
  }
}
