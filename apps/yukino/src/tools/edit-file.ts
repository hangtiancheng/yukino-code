import { readFile, writeFile } from "node:fs/promises";

import { EDIT_FILE_DESCRIPTION } from "./descriptions.js";
import { buildEditDiff, type TextReplacement } from "./diff.js";
import { describeEditMismatch } from "./edit-file-diagnostics.js";
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
import { asErrorString, boolArg, isRecord, strArg } from "@/utils/index.js";
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

export class EditFileTool implements Tool {
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
        edits: {
          type: "array" as const,
          minItems: 1,
          description:
            "Targeted replacements matched against the original file. Batch disjoint changes in one call; overlapping edits are rejected before writing.",
          items: {
            type: "object" as const,
            properties: {
              old_string: {
                type: "string" as const,
                minLength: 1,
                description:
                  "Non-empty text from the original file, without ReadFile line-number prefixes. LF and CRLF line endings match equivalently; all other whitespace must match exactly. If matching fails, stray carriage returns in the edit strings are removed and matching is retried. Must be unique unless replace_all is true.",
              },
              new_string: {
                type: "string" as const,
                description:
                  "Replacement text. An empty string deletes the match. The file's line endings are preserved.",
              },
              replace_all: {
                type: "boolean" as const,
                description: "Replace all occurrences (default false)",
                default: false,
              },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["file_path", "edits"],
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
      return {
        output: "Error: file_path is required",
        isError: true,
      };
    }

    const filePath = resolveToolPath(ctx.cwd, requestedPath);
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return {
        output: "Error: edits must contain at least one replacement",
        isError: true,
      };
    }
    const edits: Edit[] = [];
    for (const [index, raw] of args.edits.entries()) {
      if (!isRecord(raw) || !strArg(raw, "old_string")) {
        return {
          output: `Error: edits[${String(index)}].old_string is required`,
          isError: true,
        };
      }
      if (typeof raw.new_string !== "string") {
        return {
          output: `Error: edits[${String(index)}].new_string is required`,
          isError: true,
        };
      }
      edits.push({
        oldString: strArg(raw, "old_string"),
        newString: raw.new_string,
        replaceAll: boolArg(raw, "replace_all"),
      });
    }

    return withFileMutationQueue(filePath, async () => {
      if (ctx.abortSignal?.aborted) {
        return { output: "Error: operation interrupted", isError: true };
      }
      if (ctx.fileStateCache) {
        const gate = ctx.fileStateCache.check(filePath);
        if (!gate.ok) {
          return { output: gate.error, isError: true };
        }
      }

      let content: string;
      try {
        content = await readFile(filePath, {
          encoding: "utf-8",
          signal: ctx.abortSignal,
        });
      } catch (err) {
        log.error({ err }, "tool operation failed");
        return {
          output: ctx.abortSignal?.aborted
            ? "Error: operation interrupted"
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
        return { output: "Error: operation interrupted", isError: true };
      }
      if (ctx.fileStateCache) {
        const gate = ctx.fileStateCache.check(filePath);
        if (!gate.ok) {
          return { output: gate.error, isError: true };
        }
      }

      try {
        ctx.fileHistory?.trackEdit(filePath);
        await writeFile(filePath, applied.content, "utf-8");
        ctx.fileStateCache?.update(filePath);
        // Include the concrete diff rather than just saying "updated": both the model and UI need to know which lines changed
        const {
          text: diffText,
          additions,
          removals,
        } = buildEditDiff(content, applied.replacements);
        const count = applied.replacements.length;
        const summary = `Updated ${filePath} with ${String(additions)} addition${additions === 1 ? "" : "s"} and ${String(removals)} removal${removals === 1 ? "" : "s"} (${String(count)} replacement${count === 1 ? "" : "s"})`;
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
