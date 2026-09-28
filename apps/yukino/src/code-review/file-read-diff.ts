import type { FileDiff } from "./types.js";

import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { strArg } from "@/utils/index.js";

/**
 * The diff-inspection tool, ported from OCR's file_read_diff. The main prompt
 * only embeds the current group's diffs; this lets the agent read the diff of
 * any other changed file (including ones selection filtered out) without
 * misreading the workspace copy — critical in range/commit mode where the
 * on-disk file can differ from the reviewed ref.
 */
export class FileReadDiffTool implements Tool {
  name = "FileReadDiff";
  category = "read" as const;
  description =
    "Read the full unified diff of a changed file from the changeset under review, including files outside the current review group. Use it to check how related files changed before claiming an inconsistency or a broken contract.";

  constructor(private readonly diffByPath: Map<string, FileDiff>) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Repository-relative path of a changed file (old or new side).",
          },
        },
        required: ["path"],
      },
    };
  }

  async execute(
    _ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const path = strArg(args, "path").trim();
    if (!path) {
      return { output: "Error: path is required", isError: true };
    }
    const diff = this.diffByPath.get(path);
    if (!diff) {
      return {
        output: `Error: "${path}" is not part of this changeset. FileReadDiff only serves changed files; use ReadFile for anything else.`,
        isError: true,
      };
    }
    return Promise.resolve({ output: diff.diffText, isError: false });
  }
}
