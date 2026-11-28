export const DEFAULT_MIN_HOURS = 24;
export const DEFAULT_MIN_SESSIONS = 5;
export const SCAN_THROTTLE_MS = 10 * 60 * 1000;
export const LOCK_FILE = ".consolidate-lock";
export const RUNNING_LOCK_FILE = ".consolidate-running";

/**
 * Caps for memory index content (MEMORY.md and the injected reminder):
 * 200 lines or 25KB, whichever is hit first. The line cap also bounds the
 * headers retained per directory (newest first, see scanMemoryHeaders).
 */
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
export const MEMORY_INDEX_NAME = "MEMORY.md";
// Answer space reserved for the memory selector's structured JSON reply.
export const SELECTOR_ANSWER_RESERVE_TOKENS = 4_000;
export const MAX_SELECTED_MEMORIES = 5;

export const MEMORY_DIR_NAME = "memory";
export const AGENTS_FILE_NAME = "AGENTS.md";
export const AGENTS_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
] as const;

export const MILLISECONDS_PER_HOUR = 3_600_000;
export const MEMORY_MILLISECONDS_PER_DAY = 86_400_000;

export const CONSOLIDATION_MAX_ITERATIONS = 15;
export const EXTRACTION_MAX_ITERATIONS = 5;

// Background extraction drain gates.
export const MIN_EXTRACT_MESSAGES = 2;
export const EXTRACT_SUMMARY_WINDOW = 40;
export const MIN_SUMMARY_LINE_CHARS = 12;

// The extraction sub-agent emits NONE when nothing is worth saving; the text
// fallback treats it as an empty result.
export const NONE_SENTINEL = "NONE";
export const DEFAULT_MEMORY_TYPE = "reference";

export const MEMORY_TASK_TOOLS: ReadonlySet<string> = new Set([
  "ReadFile",
  "Grep",
  "Glob",
  "WriteFile",
  "EditFile",
]);

export const GLOB_ESCAPE_RE = /\\|[{(][^})]*\/|(?:^|\/)\.\.(?:\/|$)/u;
export const GLOB_MAGIC_RE = /[*?{[(]/u;

// Splits fallback text blocks on standalone --- lines (m flag lets ^/$ match
// line start/end).
export const TEXT_BLOCK_SEPARATOR_RE = /^---\s*$/m;
export const MEMORY_NAME_RE = /^MEMORY_NAME:\s*(.*)$/i;
export const MEMORY_TYPE_RE = /^MEMORY_TYPE:\s*(.*)$/i;
export const MEMORY_DESC_RE = /^MEMORY_DESC:\s*(.*)$/i;
export const MEMORY_BODY_RE = /^MEMORY_BODY:\s?(.*)$/i;
export const MEMORY_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
