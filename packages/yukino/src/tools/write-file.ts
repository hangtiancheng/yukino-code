import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { createChildLogger } from "@/logger/index.js";
import { writeFileAtomically } from "@/tools/atomic-write.js";
import { OPERATION_INTERRUPTED_ERROR } from "@/tools/constants.js";
import { withWorkspaceMutation } from "@/tools/execution-coordinator.js";
import { withFileMutationQueue } from "@/tools/file-mutation-queue.js";
import {
  WRITE_FILE_CONTENT_DESCRIPTION,
  WRITE_FILE_DESCRIPTION,
  WRITE_FILE_FILE_PATH_DESCRIPTION,
} from "@/tools/prompts.js";
import {
  type ToolCategory,
  type ToolContext,
  type ToolResult,
} from "@/tools/types.js";
import { ValidatedTool } from "@/tools/validated-tool.js";
import { asErrorString } from "@/utils/index.js";
import { resolveToolPath } from "@/utils/paths.js";

const log = createChildLogger({ module: "tools" });

const WriteFileToolInputSchema = z.strictObject({
  file_path: z.string().describe(WRITE_FILE_FILE_PATH_DESCRIPTION),
  content: z.string().describe(WRITE_FILE_CONTENT_DESCRIPTION),
});

export class WriteFileTool extends ValidatedTool<
  z.output<typeof WriteFileToolInputSchema>
> {
  // Use a hardcoded string instead of WriteFileTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "WriteFile";

  description = WRITE_FILE_DESCRIPTION;

  category: ToolCategory = "write";

  parameters() {
    return WriteFileToolInputSchema;
  }

  protected executeValidated(
    ctx: ToolContext,
    args: z.output<typeof WriteFileToolInputSchema>,
  ): Promise<ToolResult> {
    return withWorkspaceMutation(ctx, this.name, args, () =>
      this.executeMutation(ctx, args),
    );
  }

  private async executeMutation(
    ctx: ToolContext,
    args: z.output<typeof WriteFileToolInputSchema>,
  ): Promise<ToolResult> {
    const { content } = args;
    const filePath = resolveToolPath(ctx.cwd, args.file_path);
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
          structuredContent: {
            fileOperations: { readFiles: [], modifiedFiles: [filePath] },
          },
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
