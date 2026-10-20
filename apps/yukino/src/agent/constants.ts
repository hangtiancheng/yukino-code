// When the model stops on max_tokens, escalate its output ceiling once toward
// this value (capped at the context window), then attempt a bounded number of
// multi-turn recoveries.
export const MAX_TOKENS_CEILING = 64000;
export const MAX_TOKENS_RECOVERIES = 3;

// Per-result spill threshold before entering conversation history: once a
// tool result's character count exceeds this value the full content is written
// to disk (rather than truncated outright, to avoid losing critical
// information) and only a preview plus the file path is retained in history.
// Set to 50000 (rather than a smaller value) so the model can see enough
// content in one pass without needing an extra ReadFile round-trip to view the
// full result.
export const MAX_OUTPUT_CHARS = 50000;

export const WORKING_DIRECTORY_MARKER = "<working-directory>";
