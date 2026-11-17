package memory

import "regexp"

const (
	DefaultMinHours    = 24
	DefaultMinSessions = 5
	ScanThrottleMS     = 10 * 60 * 1000
	LockFile           = ".consolidate-lock"
	RunningLockFile    = ".consolidate-running"
)

// Caps for memory index content (MEMORY.md and the injected reminder): 200
// lines or 25KB, whichever is hit first. The line cap also bounds the headers
// retained per directory (newest first, see scanMemoryHeaders).
const (
	MaxEntrypointLines = 200
	MaxEntrypointBytes = 25_000
	MemoryIndexName    = "MEMORY.md"
	// Answer space reserved for the memory selector's structured JSON reply.
	SelectorAnswerReserveTokens = 4_000
	MaxSelectedMemories         = 5

	MemoryDirName  = "memory"
	AgentsFileName = "AGENTS.md"

	MillisecondsPerHour = 3_600_000
	MillisecondsPerDay  = 86_400_000

	ConsolidationMaxIterations = 15
	ExtractionMaxIterations    = 5

	// Background extraction drain gates.
	MinExtractMessages   = 2
	ExtractSummaryWindow = 40
	MinSummaryLineChars  = 12

	// The extraction sub-agent emits NONE when nothing is worth saving; the
	// text fallback treats it as an empty result.
	NoneSentinel      = "NONE"
	DefaultMemoryType = "reference"
)

var MemoryTaskTools = map[string]bool{
	"ReadFile":  true,
	"Grep":      true,
	"Glob":      true,
	"WriteFile": true,
	"EditFile":  true,
}

var (
	GlobEscapeRe = regexp.MustCompile(`\\|[{(][^})]*/|(?:^|/)\.\.(?:/|$)`)
	GlobMagicRe  = regexp.MustCompile(`[*?{[(]`)

	// Splits fallback text blocks on standalone --- lines.
	TextBlockSeparatorRe = regexp.MustCompile(`(?m)^---\s*$`)
	MemoryNameRe         = regexp.MustCompile(`(?i)^MEMORY_NAME:\s*(.*)$`)
	MemoryTypeRe         = regexp.MustCompile(`(?i)^MEMORY_TYPE:\s*(.*)$`)
	MemoryDescRe         = regexp.MustCompile(`(?i)^MEMORY_DESC:\s*(.*)$`)
	MemoryBodyRe         = regexp.MustCompile(`(?i)^MEMORY_BODY:\s?(.*)$`)
	MemoryNamePattern    = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N}._-]*$`)

	// Line-anchored with optional indent: matches both top-level `type:` and
	// nested `  type:` without matching words like "prototype:" in body text.
	FrontmatterTypeRe        = regexp.MustCompile(`(?m)^\s*type:\s*"?([^"\n]+?)"?\s*$`)
	FrontmatterDescriptionRe = regexp.MustCompile(`(?m)^\s*description:\s*"?([^"\n]+?)"?\s*$`)
)
