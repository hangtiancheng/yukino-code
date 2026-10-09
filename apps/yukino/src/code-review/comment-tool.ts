import { posix } from "node:path";

import type {
  CommentCategory,
  CommentSeverity,
  FileDiff,
  ReviewComment,
} from "./types.js";

import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { isRecord, safeJSONParse, strArg } from "@/utils/index.js";

/**
 * The comment intake. Comments flow through a dedicated tool rather than
 * free text: the schema forces path + existing_code anchors, which the
 * positioning pipeline then turns into exact line numbers.
 */

const CATEGORIES: CommentCategory[] = [
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
];

const SEVERITIES: CommentSeverity[] = ["critical", "high", "medium", "low"];

function normalizeCategory(raw: unknown): CommentCategory {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return CATEGORIES.find((c) => c === s) ?? "other";
}

function normalizeSeverity(raw: unknown): CommentSeverity {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return SEVERITIES.find((c) => c === s) ?? "low";
}

/** Normalize a model-supplied path: backslashes → slashes, collapse `.`/`..`
 * and duplicate separators, strip `./` and leading `/`. */
export function normalizeCommentPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) {
    return "";
  }
  let out = trimmed.replace(/\\/g, "/");
  out = posix.normalize(out);
  while (out.startsWith("./")) {
    out = out.slice(2);
  }
  while (out.startsWith("/")) {
    out = out.slice(1);
  }
  return out;
}

export interface ParsedComments {
  comments: ReviewComment[];
  /** Paths the model omitted, defaulted to the group's primary file. */
  defaultedPaths: number;
  /** Entries dropped for being unusable (not objects or missing content). */
  droppedEntries: number;
  error?: string;
}

/**
 * Parse and normalize the CodeComment tool arguments. Tolerates the common
 * schema violations (a single object instead of an array, JSON-string
 * payloads). Unusable entries are dropped individually — one bad comment
 * must not destroy the batch.
 */
export function parseComments(
  args: Record<string, unknown>,
  defaultPath: string,
): ParsedComments {
  let raw = args.comments;
  if (typeof raw === "string") {
    const parsed: unknown = safeJSONParse(raw);
    if (parsed === undefined) {
      return {
        comments: [],
        defaultedPaths: 0,
        droppedEntries: 0,
        error: "comments is not valid JSON",
      };
    }
    raw = parsed;
  }
  if (raw && !Array.isArray(raw) && typeof raw === "object") {
    raw = [raw];
  }
  if (!Array.isArray(raw)) {
    return {
      comments: [],
      defaultedPaths: 0,
      droppedEntries: 0,
      error: "comments must be an array of comment objects",
    };
  }

  const comments: ReviewComment[] = [];
  let defaultedPaths = 0;
  let droppedEntries = 0;
  for (const item of raw) {
    if (!isRecord(item)) {
      droppedEntries++;
      continue;
    }
    const content = strArg(item, "content").trim();
    const existingCode = strArg(item, "existing_code").trim();
    if (!content || !existingCode) {
      droppedEntries++;
      continue;
    }
    let path = normalizeCommentPath(strArg(item, "path"));
    if (!path) {
      path = defaultPath;
      defaultedPaths++;
    }
    const suggestionCode = strArg(item, "suggestion_code");
    comments.push({
      path,
      content,
      existingCode,
      suggestionCode: suggestionCode ? suggestionCode : undefined,
      startLine: 0,
      endLine: 0,
      category: normalizeCategory(item.category),
      severity: normalizeSeverity(item.severity),
      resolution: "unresolved",
    });
  }
  if (comments.length === 0) {
    return {
      comments: [],
      defaultedPaths,
      droppedEntries,
      error:
        "no valid comments: every entry needs non-empty 'content' (and 'existing_code' to anchor a line)",
    };
  }
  return { comments, defaultedPaths, droppedEntries };
}

/**
 * Collects comments produced by one group subagent (the runner creates one
 * collector per group). Insertion order is load-bearing: the review filter
 * removes by index, and rounds compute deltas from snapshot offsets.
 */
export class CommentCollector {
  private comments: ReviewComment[] = [];

  addAll(cms: ReviewComment[]): void {
    this.comments.push(...cms);
  }

  all(): ReviewComment[] {
    return [...this.comments];
  }

  /** Total count, usable as a cursor for since(). */
  snapshot(): number {
    return this.comments.length;
  }

  since(start: number): ReviewComment[] {
    return this.comments.slice(start);
  }

  removeAt(indices: number[]): void {
    const drop = new Set(indices);
    this.comments = this.comments.filter((_, i) => !drop.has(i));
  }
}

export interface CodeCommentToolDeps {
  collector: CommentCollector;
  /** Diffs of the group this tool instance serves (default-path source). */
  groupDiffs: FileDiff[];
  /**
   * Positioning pipeline applied to each parsed comment before collection:
   * hunk match → file content → cross-file → LLM re-location. Injected by
   * the runner so the tool stays free of LLM dependencies. The runner's
   * resolve closure owns the cross-file pool; the tool itself never reads
   * all diffs directly.
   */
  resolve: (comments: ReviewComment[]) => Promise<void>;
  groupLabel: string;
}

export const CODE_COMMENT_SUCCESS =
  "Comments recorded. Continue reviewing; when finished, end your turn without calling tools.";

/**
 * The review agent's only output channel. Category is "read" — it mutates no
 * file; it feeds the group-local collector.
 */
export class CodeCommentTool implements Tool {
  name = "CodeComment";
  category = "read" as const;
  description =
    "Report a confirmed code issue found in the changes under review. The tool pinpoints your feedback to the exact code line (or block) by matching 'existing_code' against the diff, so the snippet must be copied VERBATIM from the changed lines.";

  constructor(private readonly deps: CodeCommentToolDeps) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          comments: {
            type: "array",
            description:
              "A list of comments. Each item should contain 'content' and 'existing_code'.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description:
                    "The relative file path this comment applies to. Must be one of the files in <review_files>.",
                },
                content: {
                  type: "string",
                  description:
                    "Comment content: a brief description of the code issue and the corresponding suggestion.",
                },
                existing_code: {
                  type: "string",
                  description:
                    "Code snippet used to locate the comment position. Copy one or several consecutive lines VERBATIM from the newly added/modified code in the diff — do not include deleted-only or unchanged lines, and do not rewrite the code.",
                },
                suggestion_code: {
                  type: "string",
                  description:
                    "Corresponding suggested code snippet, maintaining consistent code style.",
                },
                category: {
                  type: "string",
                  enum: [
                    "bug",
                    "security",
                    "performance",
                    "maintainability",
                    "test",
                    "style",
                    "documentation",
                    "other",
                  ],
                  description: "The category the issue belongs to.",
                },
                severity: {
                  type: "string",
                  enum: ["critical", "high", "medium", "low"],
                  description: "The severity of the issue.",
                },
              },
              required: [
                "path",
                "content",
                "existing_code",
                "category",
                "severity",
              ],
            },
          },
        },
        required: ["comments"],
      },
    };
  }

  async execute(
    _ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const defaultPath =
      this.deps.groupDiffs[0]?.newPath !== "/dev/null"
        ? (this.deps.groupDiffs[0]?.newPath ?? "")
        : (this.deps.groupDiffs[0]?.oldPath ?? "");
    const parsed = parseComments(args, defaultPath);
    if (parsed.error) {
      return { output: `Error: ${parsed.error}`, isError: true };
    }
    for (const cm of parsed.comments) {
      cm.groupLabel = this.deps.groupLabel;
    }
    await this.deps.resolve(parsed.comments);
    this.deps.collector.addAll(parsed.comments);
    const located = parsed.comments.filter(
      (c) => c.resolution !== "unresolved",
    ).length;
    const dropped =
      parsed.droppedEntries > 0
        ? ` ${String(parsed.droppedEntries)} invalid entr${parsed.droppedEntries === 1 ? "y" : "ies"} dropped.`
        : "";
    return {
      output: `${CODE_COMMENT_SUCCESS} (${String(parsed.comments.length)} recorded, ${String(located)} precisely located.${dropped})`,
      isError: false,
    };
  }
}
