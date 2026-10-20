import { constants } from "fs";

import type { CommentCategory, CommentSeverity } from "@/review/types.js";

export const CATEGORIES: CommentCategory[] = [
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
];

export const SEVERITIES: CommentSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

export const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Cap on confirmed findings: the round loop stops once this many accumulate. */
export const CONFIRMED_CAP = 30;
export const CONFIRMED_MAX_EXISTING_CODE = 200;
export const CONFIRMED_MAX_CONTENT = 300;

/** Below this file count, grouping adds no value. */
export const GROUPING_MIN_FILES = 4;
/** Hard cap per group. */
export const MAX_FILES_PER_GROUP = 10;
/**
 * Fallback combined diff token budget per group when the caller does not
 * derive one from the provider context window.
 */
export const GROUP_TOKEN_BUDGET = 60_000;

/**
 * Fallback per-file diff size ceiling when the caller does not derive one
 * from the provider context window.
 */
export const FILE_TOKEN_LIMIT = 160_000;

/**
 * Fraction of the context window a single review prompt may occupy.
 * Feeds both the per-file gate and the group token budget.
 */
export const PROMPT_TOKEN_RATIO = 0.8;

export const MATCH_OPTS = { dot: true, nocase: false };

/** Context lines per hunk. */
export const DIFF_CONTEXT_LINES = 3;
/** Untracked files above this size are reported as binary. */
export const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024;
/** Leading bytes sniffed for NUL to decide binary-ness, matching git's heuristic. */
export const BINARY_SNIFF_WINDOW = 8000;
// O_NOFOLLOW is undefined on Windows; falling back to 0 keeps the flag a no-op
// there while POSIX refuses to open a symlink swapped in after lstat.
export const OPEN_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export const DIFF_FLAGS = [
  "-c",
  "core.quotepath=false",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-color",
  `-U${String(DIFF_CONTEXT_LINES)}`,
];

export const SEVERITY_ICON: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

/** Plan phase thresholds. */
export const PLAN_MODE_LINE_THRESHOLD = 50;
export const PLAN_MODE_GROUP_LINE_THRESHOLD = 100;
/** Turn cap for one agent run (each round builds a fresh Agent). */
export const MAX_AGENT_ITERATIONS = 50;
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_MAX_ROUNDS = 2;

export const CODE_COMMENT_SUCCESS =
  "Comments recorded. Continue reviewing; when finished, end your turn without calling tools.";

// When an optional section has no content, drop its header + placeholder
// together instead of leaving a dangling "### Review Plan" with nothing
// under it.
export const PLAN_BLOCK_RE =
  /^### [^\n]*Review Plan[^\n]*\n\{\{plan_guidance\}\}\n\n?/m;
export const CONFIRMED_BLOCK_RE =
  /^### [^\n]*Confirmed Findings[^\n]*\n\{\{confirmed_comments\}\}\n\n?/m;
