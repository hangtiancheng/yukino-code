package bootstrap

import (
	"math"
	"strconv"
	"strings"
)

// InteractionSummary mirrors the reference InteractionSummary interface.
type InteractionSummary struct {
	AgentActiveMs float64
	// Prompt tokens written to the provider's cache.
	CacheCreationTokens float64
	// Prompt tokens served from the provider's cache.
	CacheReadTokens float64
	FailedToolCalls float64
	// Uncached prompt tokens; the cached prefix is counted separately.
	InputTokens         float64
	LatestVersion       string
	OutputTokens        float64
	SessionID           string
	StartedAt           float64
	SuccessfulToolCalls float64
	ToolTimeMs          float64
}

// toFixed mirrors JavaScript's Number.prototype.toFixed (half away from zero).
func toFixed(value float64, digits int) string {
	shift := math.Pow(10, float64(digits))
	rounded := math.Floor(math.Abs(value)*shift+0.5) / shift
	if value < 0 {
		rounded = -rounded
	}
	return strconv.FormatFloat(rounded, 'f', digits, 64)
}

func formatDuration(milliseconds float64) string {
	seconds := int(math.Max(0, math.Round(milliseconds/1000)))
	if seconds < 60 {
		return strconv.Itoa(seconds) + "s"
	}
	minutes := seconds / 60
	remainder := seconds % 60
	return strconv.Itoa(minutes) + "m " + strconv.Itoa(remainder) + "s"
}

func formatTokens(value float64) string {
	tokens := int(math.Max(0, math.Round(value)))
	if tokens < 1000 {
		return strconv.Itoa(tokens)
	}
	if tokens < 1_000_000 {
		digits := 1
		if tokens >= 10_000 {
			digits = 0
		}
		return toFixed(float64(tokens)/1000, digits) + "k"
	}
	return toFixed(float64(tokens)/1_000_000, 1) + "M"
}

func percentage(value, total float64) string {
	ratio := 0.0
	if total > 0 {
		ratio = value / total * 100
	}
	return toFixed(ratio, 1) + "%"
}

// FormatInteractionSummary mirrors the reference formatInteractionSummary;
// endedAtMs is the caller's Date.now() equivalent.
func FormatInteractionSummary(summary InteractionSummary, endedAtMs float64) string {
	totalToolCalls := summary.SuccessfulToolCalls + summary.FailedToolCalls
	apiTimeMs := math.Max(0, summary.AgentActiveMs-summary.ToolTimeMs)
	successRate := 0.0
	if totalToolCalls > 0 {
		successRate = summary.SuccessfulToolCalls / totalToolCalls * 100
	}
	promptTokens := summary.InputTokens + summary.CacheReadTokens + summary.CacheCreationTokens
	cacheHitRate := percentage(summary.CacheReadTokens, promptTokens)

	lines := []string{
		"**Tools** " + strconv.FormatFloat(totalToolCalls, 'f', -1, 64) + " calls · ✓ " + strconv.FormatFloat(summary.SuccessfulToolCalls, 'f', -1, 64) + " · ✗ " + strconv.FormatFloat(summary.FailedToolCalls, 'f', -1, 64) + " · " + toFixed(successRate, 1) + "% success",
		"**Time** " + formatDuration(endedAtMs-summary.StartedAt) + " wall · " + formatDuration(summary.AgentActiveMs) + " active",
		"**Breakdown** API " + formatDuration(apiTimeMs) + " (" + percentage(apiTimeMs, summary.AgentActiveMs) + ") · Tools " + formatDuration(summary.ToolTimeMs) + " (" + percentage(summary.ToolTimeMs, summary.AgentActiveMs) + ")",
		"**Tokens** ↑ " + formatTokens(summary.InputTokens) + " input · ↓ " + formatTokens(summary.OutputTokens) + " output",
		"**Cache** " + formatTokens(summary.CacheReadTokens) + " read · " + formatTokens(summary.CacheCreationTokens) + " write",
		"**Cache hit** " + cacheHitRate + " (" + formatTokens(summary.CacheReadTokens) + " of " + formatTokens(promptTokens) + " prompt)",
		"`yukino --resume " + summary.SessionID + "`",
	}
	return "### Session `" + summary.SessionID + "`\n" + strings.Join(lines, "  \n")
}
