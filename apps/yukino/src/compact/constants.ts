// Auto-compact uses a token-budget formula rather than a fixed usage ratio:
// reserve room for the summary output in the next response turn, then leave a
// safety margin before the window fills.

export const MAX_CONSECUTIVE_FAILURES = 3;
export const MAX_PTL_RETRIES = 3;
export const CHARS_PER_TOKEN = 3.5;

// Recent-history retention budget for compaction. When we compact we keep the tail of
// the transcript verbatim instead of collapsing everything into a summary, so
// the model still sees the literal recent exchange (not just a paraphrase).
//   KEEP_RECENT_TOKENS — lower bound: walk back from the tail until the kept
//     tail reaches at least this many tokens (one of two "good enough" stops).
//   MIN_KEEP_MESSAGES — floor: keep at least this many recent messages even if
//     they are short (the other "good enough" stop).
//   KEEP_MAX_TOKENS — upper bound: stop walking back once adding the next
//     message would cross it. The most recent message is always kept, even
//     when it alone exceeds the cap, so the tail can still overshoot.
export const KEEP_RECENT_TOKENS = 10000;
export const MIN_KEEP_MESSAGES = 5;
export const KEEP_MAX_TOKENS = 40000;

// If fewer than this many messages would be summarized (everything else is in
// the kept tail), skip compaction entirely — the savings aren't worth the
// summary round-trip and the lost cache. Degenerate-case guard.
export const MIN_COMPACT_PREFIX = 2;

export const SUMMARY_OUTPUT_RESERVE = 20000;
export const AUTO_COMPACT_SAFETY_MARGIN = 13000;
export const MANUAL_COMPACT_SAFETY_MARGIN = 3000;
// Reserve enough answer space for a full compaction summary so a fixed thinking
// budget cannot squeeze the summary down to the 1024-token answer floor.
export const SUMMARY_ANSWER_RESERVE_TOKENS = 16_000;

// effectiveWindow = contextWindow − min(model maxOutput, SUMMARY_OUTPUT_RESERVE).
// Auto-compact triggers at effectiveWindow − AUTO margin; once token usage crosses
// effectiveWindow − MANUAL margin (the hard block line) we must force a compaction.
//
// The fixed margins assume a large window. On a small window they can exceed the
// available space and drive the threshold to zero or below, which would force a
// compaction every turn and keep the hard-block line permanently crossed. The
// margin is therefore capped to a fraction of the effective window so the
// threshold stays a meaningful positive headroom, while large windows keep the
// original fixed-margin behaviour exactly.
export const AUTO_MARGIN_RATIO = 0.25;
export const MANUAL_MARGIN_RATIO = 0.1;

// Each image block counts as a fixed char-equivalent (~2000 tokens at
// CHARS_PER_TOKEN, the order of magnitude of Anthropic's per-image token
// cost). Without this, image-heavy conversations systematically
// under-estimate and compaction fires too late.
export const IMAGE_CHAR_EQUIV = 7000;

// Recovery budgets for the attachment block appended to the summary
// message. Compaction collapses the working conversation into a summary;
// without these snapshots the model would forget which files it just read.
// Active skill SOPs are re-injected after compaction by Agent.restoreContext →
// ConversationManager.injectLongTermMemory (agent/index.ts), not through
// this attachment.
export const RECOVERY_FILE_LIMIT = 5;
export const RECOVERY_TOKENS_PER_FILE = 5_000;
export const RECOVERY_CHARS_PER_TOKEN = 3.5;
