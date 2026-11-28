import { readFile } from "node:fs/promises";

import { z } from "zod";

import { createChildLogger } from "@/logger/index.js";
import {
  isPrivateStatePath,
  protectPrivateFileSync,
} from "@/storage/private.js";
import { writeFileAtomically } from "@/tools/atomic-write.js";
import { OPERATION_INTERRUPTED_ERROR } from "@/tools/constants.js";
import { buildEditDiff, type TextReplacement } from "@/tools/diff.js";
import { describeEditMismatch } from "@/tools/edit-file-diagnostics.js";
import { withWorkspaceMutation } from "@/tools/execution-coordinator.js";
import { withFileMutationQueue } from "@/tools/file-mutation-queue.js";
import {
  EDIT_FILE_DESCRIPTION,
  EDIT_FILE_EDITS_DESCRIPTION,
  EDIT_FILE_FILE_PATH_DESCRIPTION,
  EDIT_FILE_NEW_STRING_DESCRIPTION,
  EDIT_FILE_OLD_STRING_DESCRIPTION,
  EDIT_FILE_REPLACE_ALL_DESCRIPTION,
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

interface Edit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

interface Replacement extends TextReplacement {
  editIndex: number;
}

function withLineEnding(text: string, ending: string): string {
  return text.replace(/\r?\n/g, ending);
}

function withoutStrayCarriageReturns(text: string): string {
  return text.replace(/\r(?!\n)/g, "");
}

function editPattern(text: string): RegExp {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  // A leading LF snippet must consume the whole CRLF, including its CR.
  return new RegExp(lines.join("(?:\\r\\n|(?<!\\r)\\n)"), "gu");
}

function applyEdits(
  content: string,
  edits: Edit[],
): {
  content: string;
  replacements: Replacement[];
} {
  const ending = /\r?\n/u.exec(content)?.[0] ?? "\n";
  const replacements: Replacement[] = [];

  for (const [editIndex, edit] of edits.entries()) {
    let oldString = edit.oldString;
    let pattern = editPattern(oldString);
    let match = pattern.exec(content);
    let newString = edit.newString;
    if (!match) {
      const cleanedOldString = withoutStrayCarriageReturns(edit.oldString);
      if (cleanedOldString && cleanedOldString !== edit.oldString) {
        oldString = cleanedOldString;
        pattern = editPattern(cleanedOldString);
        match = pattern.exec(content);
        newString = withoutStrayCarriageReturns(newString);
      }
    }
    let count = 0;
    while (match) {
      if (count > 0 && !edit.replaceAll) {
        throw new Error(
          `edits[${String(editIndex)}].old_string occurs more than once in file. It must be unique. Add more surrounding context, or set replace_all to true`,
        );
      }
      const matchedEnding = /\r?\n/u.exec(match[0])?.[0] ?? ending;
      const text = withLineEnding(newString, matchedEnding);
      if (match[0] === text) {
        throw new Error(
          `edits[${String(editIndex)}] would not change the file`,
        );
      }
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        text,
        editIndex,
      });
      count++;
      match = pattern.exec(content);
    }
    if (count === 0) {
      throw new Error(
        `edits[${String(editIndex)}].old_string not found in file\n${describeEditMismatch(content, oldString)}`,
      );
    }
  }

  replacements.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < cursor) {
      throw new Error(
        `edits[${String(replacement.editIndex)}] overlaps another edit. Merge overlapping changes into one edit`,
      );
    }
    parts.push(content.slice(cursor, replacement.start), replacement.text);
    cursor = replacement.end;
  }
  parts.push(content.slice(cursor));
  return { content: parts.join(""), replacements };
}

const EditFileToolInputSchema = z.strictObject({
  file_path: z.string().describe(EDIT_FILE_FILE_PATH_DESCRIPTION),
  edits: z
    .array(
      z.strictObject({
        old_string: z
          .string()
          .min(1)
          .describe(EDIT_FILE_OLD_STRING_DESCRIPTION),
        new_string: z.string().describe(EDIT_FILE_NEW_STRING_DESCRIPTION),
        replace_all: z
          .boolean()
          .describe(EDIT_FILE_REPLACE_ALL_DESCRIPTION)
          .default(false),
      }),
    )
    .min(1)
    .describe(EDIT_FILE_EDITS_DESCRIPTION),
});

export class EditFileTool extends ValidatedTool<
  z.output<typeof EditFileToolInputSchema>
> {
  name = "EditFile";

  description = EDIT_FILE_DESCRIPTION;

  category: ToolCategory = "write";

  parameters() {
    return EditFileToolInputSchema;
  }

  protected executeValidated(
    ctx: ToolContext,
    args: z.output<typeof EditFileToolInputSchema>,
  ): Promise<ToolResult> {
    return withWorkspaceMutation(ctx, this.name, args, () =>
      this.executeMutation(ctx, args),
    );
  }

  private async executeMutation(
    ctx: ToolContext,
    args: z.output<typeof EditFileToolInputSchema>,
  ): Promise<ToolResult> {
    const filePath = resolveToolPath(ctx.cwd, args.file_path);
    const edits: Edit[] = args.edits.map((edit) => ({
      oldString: edit.old_string,
      newString: edit.new_string,
      replaceAll: edit.replace_all,
    }));

    return withFileMutationQueue(filePath, async () => {
      if (ctx.abortSignal?.aborted) {
        return { output: OPERATION_INTERRUPTED_ERROR, isError: true };
      }
      if (ctx.fileStateCache) {
        const gate = ctx.fileStateCache.check(filePath);
        if (!gate.ok) {
          return { output: gate.error, isError: true };
        }
      }

      let content: string;
      try {
        if (isPrivateStatePath(filePath)) {
          protectPrivateFileSync(filePath);
        }
        content = await readFile(filePath, {
          encoding: "utf-8",
          signal: ctx.abortSignal,
        });
      } catch (err) {
        log.error({ err }, "tool operation failed");
        return {
          output: ctx.abortSignal?.aborted
            ? OPERATION_INTERRUPTED_ERROR
            : `Error reading file: ${asErrorString(err)}`,
          isError: true,
        };
      }

      let applied: ReturnType<typeof applyEdits>;
      try {
        applied = applyEdits(content, edits);
      } catch (err) {
        return { output: `Error: ${asErrorString(err)}`, isError: true };
      }
      if (ctx.abortSignal?.aborted) {
        return { output: OPERATION_INTERRUPTED_ERROR, isError: true };
      }
      if (ctx.fileStateCache) {
        const gate = ctx.fileStateCache.check(filePath);
        if (!gate.ok) {
          return { output: gate.error, isError: true };
        }
      }

      try {
        ctx.fileHistory?.trackEdit(filePath);
        await writeFileAtomically(filePath, applied.content, ctx.abortSignal);
        ctx.fileStateCache?.update(filePath);
        // Include the concrete diff rather than just saying "updated": both the model and UI need to know which lines changed
        const {
          text: diffText,
          additions,
          removals,
        } = buildEditDiff(content, applied.replacements);
        const count = applied.replacements.length;
        const summary =
          additions === null || removals === null
            ? `Updated ${filePath} (${String(count)} replacements; diff line counts unavailable)`
            : `Updated ${filePath} with ${String(additions)} addition${additions === 1 ? "" : "s"} and ${String(removals)} removal${removals === 1 ? "" : "s"} (${String(count)} replacement${count === 1 ? "" : "s"})`;
        return {
          output: `${summary}\n${diffText}`,
          isError: false,
          structuredContent: {
            fileOperations: { readFiles: [], modifiedFiles: [filePath] },
          },
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
