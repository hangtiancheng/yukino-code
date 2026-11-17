package compact

import "regexp"

// Auto-compact uses a token-budget formula rather than a fixed usage ratio:
// reserve room for the summary output in the next response turn, then leave a
// safety margin before the window fills.

const (
	MaxConsecutiveFailures = 3
	MaxPTLRetries          = 3
	// Prompt-too-long retries truncate roughly one fifth of the summarized
	// prefix: the token gap is estimated as prefixTokens / PTLTruncateDivisor,
	// and when the provider reports no usable gap, that fraction of API round
	// groups is dropped instead.
	PTLTruncateDivisor = 5
	CharsPerToken      = 3.5

	// Recent-history retention budget for compaction. When we compact we keep
	// the tail of the transcript verbatim instead of collapsing everything
	// into a summary, so the model still sees the literal recent exchange.
	//   KeepRecentTokens — lower bound: walk back from the tail until the kept
	//     tail reaches at least this many tokens (one of two "good enough"
	//     stops).
	//   MinKeepMessages — floor: keep at least this many recent messages even
	//     if they are short (the other "good enough" stop).
	//   KeepMaxTokens — upper bound: stop walking back once adding the next
	//     message would cross it. The most recent message is always kept,
	//     even when it alone exceeds the cap, so the tail can still overshoot.
	KeepRecentTokens = 10000
	MinKeepMessages  = 5
	KeepMaxTokens    = 40000

	// If fewer than this many messages would be summarized (everything else
	// is in the kept tail), skip compaction entirely — the savings aren't
	// worth the summary round-trip and the lost cache. Degenerate-case guard.
	MinCompactPrefix = 2

	SummaryOutputReserve       = 20000
	AutoCompactSafetyMargin    = 13000
	ManualCompactSafetyMargin  = 3000
	SummaryAnswerReserveTokens = 16_000

	// effectiveWindow = contextWindow − min(model maxOutput,
	// SummaryOutputReserve). Auto-compact triggers at effectiveWindow − AUTO
	// margin; once token usage crosses effectiveWindow − MANUAL margin (the
	// hard block line) we must force a compaction.
	//
	// The fixed margins assume a large window. On a small window they can
	// exceed the available space and drive the threshold to zero or below,
	// which would force a compaction every turn and keep the hard-block line
	// permanently crossed. The margin is therefore capped to a fraction of
	// the effective window so the threshold stays a meaningful positive
	// headroom, while large windows keep the original fixed-margin behaviour
	// exactly.
	AutoMarginRatio   = 0.25
	ManualMarginRatio = 0.1

	// Each image block counts as a fixed char-equivalent (~2000 tokens at
	// CharsPerToken, the order of magnitude of Anthropic's per-image token
	// cost). Without this, image-heavy conversations systematically
	// under-estimate and compaction fires too late.
	ImageCharEquiv = 7000

	// Recovery budgets for the attachment block appended to the summary
	// message. Compaction collapses the working conversation into a summary;
	// without these snapshots the model would forget which files it just
	// read. Active skill SOPs are re-injected after compaction by
	// Agent.restoreContext → InjectLongTermMemory, not through this
	// attachment.
	RecoveryFileLimit     = 5
	RecoveryTokensPerFile = 5_000
	RecoveryCharsPerToken = 3.5
)

// Summary output protocol: the summarizer is instructed (see
// SummaryInstructions in prompts.go) to wrap its answer in <summary> tags; an
// unprompted <analysis> block may precede it and is stripped before use.
const (
	SummaryOpenTag   = "<summary>"
	SummaryCloseTag  = "</summary>"
	AnalysisOpenTag  = "<analysis>"
	AnalysisCloseTag = "</analysis>"
)

var (
	SummaryBlockRe  = regexp.MustCompile(`(?s)<summary>(.*?)</summary>`)
	AnalysisBlockRe = regexp.MustCompile(`(?s)<analysis>.*?</analysis>`)
)

// PTLRetryMarker is the synthetic user message left at the head of the
// summarized prefix after a prompt-too-long retry drops the oldest API
// rounds.
const PTLRetryMarker = "[earlier conversation truncated for compaction retry]"

const (
	CompactionToolCallError            = "Compaction requested a tool instead of a summary"
	CompactionStreamIncompleteError    = "Compaction summary stream ended without a completion event"
	CompactionEmptySummaryError        = "Compaction returned an empty or incomplete summary"
	CompactionConversationChangedError = "Conversation changed during compaction; keeping the current history"
)
