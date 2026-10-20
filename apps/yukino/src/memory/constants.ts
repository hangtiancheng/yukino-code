export const DEFAULT_MIN_HOURS = 24;
export const DEFAULT_MIN_SESSIONS = 5;
export const SCAN_THROTTLE_MS = 10 * 60 * 1000;
export const LOCK_FILE = ".consolidate-lock";

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
