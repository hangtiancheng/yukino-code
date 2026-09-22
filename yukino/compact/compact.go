// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// Package compact implements Yukino's Layer 2 context management:
// an LLM-driven full-conversation summary, gated by token ratio (default
// >80% of context window). Replaces the entire conversation with a summary
// message + a continuation acknowledgement. Also reachable via ForceCompact
// (the /compact slash command).
//
// Layer 1 (tool-result budget) lives in package toolresult: both single-result
// overruns and per-message aggregate overruns are handled at the moment a
// result enters the conversation history. Once a message is in history it is
// in its final form, so the message sizes observed here are the final sizes.

package compact

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/session"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

const (
	// maxPTLRetries limits how many times we retry the summary request after
	// a prompt-too-long error by dropping the oldest API-round groups.
	maxPTLRetries = 3
	// ptlRetryMarker is prepended after dropping old groups so the summary
	// request still starts with a user-role message.
	ptlRetryMarker = "[earlier conversation truncated for compaction retry]"

	// charsPerToken is the character-based token approximation used by every
	// token estimate in this package (TS: CHARS_PER_TOKEN).
	charsPerToken = 3.5

	// imageCharEquiv is the fixed char-equivalent each image block counts as
	// (~2000 tokens at charsPerToken, the order of magnitude of Anthropic's
	// per-image token cost). Without this, image-heavy conversations
	// systematically under-estimate and compaction fires too late (TS:
	// IMAGE_CHAR_EQUIV).
	imageCharEquiv = 7000

	// autoCompactThreshold is the legacy ratio gate (kept for reference only).
	// The live decision now uses the absolute-token formula below:
	// trigger compaction when used tokens approach the context window limit, leaving a margin for the next turn.
	autoCompactThreshold = 0.80

	// summaryOutputReserve reserves room for the summary response itself, so the
	// effective window is contextWindow − min(model maxOutput, summaryOutputReserve).
	summaryOutputReserve = 20000
	// autoCompactSafetyMargin sets the soft auto-compact trigger line below the
	// effective window.
	autoCompactSafetyMargin = 13000
	// manualCompactSafetyMargin sets the hard-block line: once used tokens cross
	// effectiveWindow − manualCompactSafetyMargin, we force a compaction rather
	// than rely on the soft trigger.
	manualCompactSafetyMargin = 3000
)

// Recent-message retention budget for compaction: instead of summarizing the
// whole transcript and discarding every original message, we keep the tail of
// recent messages verbatim and only summarize the older prefix.
const (
	// keepRecentTokens is the lower-bound token budget: walk back from the tail
	// accumulating per-message tokens until we've kept at least this many.
	keepRecentTokens = 10000
	// minKeepMessages is the minimum number of recent messages to keep regardless
	// of token count. Either keepRecentTokens or minKeepMessages satisfied is
	// enough to stop walking back (whichever comes first).
	minKeepMessages = 5
	// keepMaxTokens caps the kept tail: once accumulated tokens would exceed this,
	// stop walking back even if the lower bounds aren't met, so we never keep so
	// much that the summary saves nothing.
	keepMaxTokens = 40000
	// minCompactPrefix guards the degenerate case: if fewer than this many
	// messages would be summarized (everything else is in the kept tail), skip
	// compaction entirely — the savings aren't worth the summary round-trip and
	// the lost cache (TS: MIN_COMPACT_PREFIX).
	minCompactPrefix = 2
)

// computeCompactThreshold returns the absolute used-token line at which Layer 2
// should fire. effectiveWindow = contextWindow − min(maxOutput, summaryOutputReserve);
// the threshold is effectiveWindow minus the safety margin (manual margin for the
// hard-block line, auto margin for the soft trigger). TS: Math.min(maxOutput,
// SUMMARY_OUTPUT_RESERVE) — a pure min, no zero special-case.
func computeCompactThreshold(contextWindow, maxOutput int, manual bool) int {
	reserve := min(maxOutput, summaryOutputReserve)
	effectiveWindow := contextWindow - reserve
	margin := autoCompactSafetyMargin
	if manual {
		margin = manualCompactSafetyMargin
	}
	return effectiveWindow - margin
}

// MaxConsecutiveAutoCompactFailures stops auto-compact retries when the context is irrecoverably
// over the limit (e.g., prompt_too_long), so the agent doesn't hammer the API with doomed attempts
// on every iteration.
const MaxConsecutiveAutoCompactFailures = 3

// AutoCompactTrackingState threads circuit-breaker state across agent loop iterations. The caller
// owns the struct; ManageContext mutates it in place.
type AutoCompactTrackingState struct {
	// ConsecutiveFailures counts auto-compact attempts that returned an error since the last success.
	// Reset to zero on success.
	ConsecutiveFailures int
}

// toolUseJSON mirrors the TS ToolUseBlock wire shape as JSON.stringify sees it
// in estimateMessages: camelCase keys in declaration order, providerItemId
// present only when set (TS spreads it conditionally).
type toolUseJSON struct {
	ToolUseID      string         `json:"toolUseId"`
	ToolName       string         `json:"toolName"`
	Arguments      map[string]any `json:"arguments"`
	ProviderItemID string         `json:"providerItemId,omitempty"`
}

// marshalNoHTMLEscape serializes like JSON.stringify: <, > and & stay literal
// (encoding/json escapes them by default, which would inflate estimates and
// leak \u003c into summarizer-visible text).
func marshalNoHTMLEscape(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// EstimateTokens runs a rough character-based token estimate over an explicit
// message slice (TS: estimateMessages). It accumulates the total character cost
// of every message — content text, JSON-serialized tool uses, tool results
// (including structured content blocks) and thinking blocks — then divides
// once by charsPerToken and rounds up.
func EstimateTokens(messages []conversation.Message) int {
	totalChars := 0
	for _, m := range messages {
		totalChars += contentChars(m)
		if len(m.ToolUses) > 0 {
			tuJSON := make([]toolUseJSON, 0, len(m.ToolUses))
			for _, tu := range m.ToolUses {
				args := tu.Arguments
				if args == nil {
					args = map[string]any{}
				}
				tuJSON = append(tuJSON, toolUseJSON{
					ToolUseID:      tu.ToolUseID,
					ToolName:       tu.ToolName,
					Arguments:      args,
					ProviderItemID: tu.ProviderItemID,
				})
			}
			totalChars += utils.UTF16Len(marshalNoHTMLEscape(tuJSON))
		}
		for _, tr := range m.ToolResults {
			if len(tr.ContentBlocks) > 0 {
				textChars, richChars := toolResultBlocksChars(tr.ContentBlocks)
				totalChars += max(utils.UTF16Len(tr.Content), textChars) + richChars
			} else {
				totalChars += utils.UTF16Len(tr.Content)
			}
		}
		for _, tb := range m.ThinkingBlocks {
			totalChars += utils.UTF16Len(tb.Thinking)
		}
	}
	return int(math.Ceil(float64(totalChars) / charsPerToken))
}

// contentChars mirrors the TS contentChars for Message.Content: a plain string
// counts its UTF-16 length, and a user-message block array counts text blocks
// plus the fixed image equivalent, ignoring other block types. Without the
// block branch, image-bearing user messages would be systematically
// under-estimated (TS compact.ts:118-137).
func contentChars(m conversation.Message) int {
	if len(m.ContentBlocks) == 0 {
		return utils.UTF16Len(m.Content)
	}
	chars := 0
	for _, block := range m.ContentBlocks {
		switch block["type"] {
		case "text":
			if text, ok := block["text"].(string); ok {
				chars += utils.UTF16Len(text)
			}
		case "image":
			chars += imageCharEquiv
		}
	}
	return chars
}

// toolResultBlocksChars splits the character cost of structured tool-result
// content blocks into plain-text chars and rich (non-text) chars (TS:
// toolResultBlocksChars). Image-bearing blocks count as the fixed
// imageCharEquiv so image-heavy results aren't under-estimated.
func toolResultBlocksChars(blocks []map[string]any) (textChars, richChars int) {
	for _, block := range blocks {
		blockType, _ := block["type"].(string)
		switch blockType {
		case "text":
			text, _ := block["text"].(string)
			textChars += utils.UTF16Len(text)
		case "image":
			richChars += imageCharEquiv
		case "tool_reference":
			name, _ := block["tool_name"].(string)
			richChars += utils.UTF16Len(name)
		case "search_result":
			source, _ := block["source"].(string)
			title, _ := block["title"].(string)
			richChars += utils.UTF16Len(source) + utils.UTF16Len(title)
			if contents, ok := block["content"].([]any); ok {
				for _, c := range contents {
					if cm, ok := c.(map[string]any); ok {
						if text, ok := cm["text"].(string); ok {
							richChars += utils.UTF16Len(text)
						}
					}
				}
			}
		case "document":
			source, _ := block["source"].(map[string]any)
			sourceType, _ := source["type"].(string)
			switch sourceType {
			case "base64":
				richChars += imageCharEquiv
			case "url":
				url, _ := source["url"].(string)
				richChars += utils.UTF16Len(url)
			case "text":
				data, _ := source["data"].(string)
				richChars += utils.UTF16Len(data)
			case "content":
				if s, ok := source["content"].(string); ok {
					richChars += utils.UTF16Len(s)
				} else if contents, ok := source["content"].([]any); ok {
					for _, c := range contents {
						cm, ok := c.(map[string]any)
						if !ok {
							continue
						}
						if t, _ := cm["type"].(string); t == "text" {
							if text, ok := cm["text"].(string); ok {
								richChars += utils.UTF16Len(text)
							}
						} else {
							richChars += imageCharEquiv
						}
					}
				}
			}
		}
	}
	return textChars, richChars
}

// UsageAnchor records the last real API usage and the conversation length at the
// moment that usage was reported. baselineTokens is the total true prompt+output
// size for that turn (input + cache_read + cache_creation + output); anchorCount
// is conv.Len() right after the assistant turn settled. Anything appended past
// anchorCount (tool results, the next user message, system reminders) has no real
// usage yet, so it's estimated incrementally on top of the baseline.
//
// A zero-value anchor (HasUsage false) means no real usage has been observed yet
// — the first turn — so callers fall back to a full character estimate.
type UsageAnchor struct {
	BaselineTokens int
	AnchorCount    int
	HasUsage       bool
}

// BaselineFromUsage collapses an API usage report into the single "true tokens
// already on the wire" number used as the anchor baseline. Anthropic reports
// cache_read / cache_creation separately from input_tokens, so the real prompt
// size is the sum of all four counters.
func BaselineFromUsage(u llm.UsageInfo) int {
	return u.InputTokens + u.CacheReadTokens + u.CacheCreationTokens + u.OutputTokens
}

// ComputeUsedTokens returns the current "used tokens" figure that the compaction
// threshold is compared against. When a real-usage anchor exists, it returns
// baselineTokens + an estimate of only the messages appended after the anchor
// (incremental estimate). Without an anchor (cold start, first turn) it falls
// back to a full character estimate over every message, matching the original
// behaviour so the agent stays usable before the first usage report lands.
func ComputeUsedTokens(messages []conversation.Message, anchor UsageAnchor) int {
	if !anchor.HasUsage {
		return EstimateTokens(messages)
	}
	// TS: start = Math.min(anchorCount, messages.length) — a stale anchor past
	// the end (conversation rewound) simply estimates an empty tail on top of
	// the baseline. A negative count cannot occur in TS; clamp it to 0.
	start := min(anchor.AnchorCount, len(messages))
	if start < 0 {
		start = 0
	}
	return anchor.BaselineTokens + EstimateTokens(messages[start:])
}

// ComputeUsedTokensFromConv reads the anchor state from the ConversationManager
// to compute the current token usage. It is a convenience wrapper around
// ComputeUsedTokens that spares callers from passing the UsageAnchor manually.
func ComputeUsedTokensFromConv(conv *conversation.Manager) int {
	baseline, count, has := conv.UsageAnchorState()
	return ComputeUsedTokens(conv.GetMessages(), UsageAnchor{
		BaselineTokens: baseline,
		AnchorCount:    count,
		HasUsage:       has,
	})
}

// CompactResult mirrors the TS CompactResult: whether the conversation was
// actually rewritten, plus the model-visible message describing the outcome.
// Failure text is carried in Message rather than an error because TS
// manageContext converts every summarizer error into an "Auto-compact failed:"
// message instead of propagating it.
type CompactResult struct {
	Compacted bool
	Message   string
}

// ManageContext runs Layer 2 (autoCompact) when used tokens reach the
// auto-compact threshold (effectiveWindow − auto margin); once they cross the
// hard-block line (effectiveWindow − manual margin) it forces a compaction.
// See computeCompactThreshold. Layer 1 (tool-result budget) runs at ingest —
// tool results are already final-size by the time they enter history, so the
// estimates here need no further trimming.
//
// tracking carries the circuit-breaker state across iterations. When nil,
// the circuit breaker is disabled (useful for tests and one-shot callers).
//
// anchor carries the most recent real API usage (baseline + conversation length
// at the time it was reported). When present, the used-token figure is
// baselineTokens + an incremental estimate of only the messages appended since;
// when absent (first turn) it falls back to a full character estimate. This
// only changes how "currently used tokens" is computed — the threshold formula
// (effectiveWindow − margin) is untouched.
//
// `workDir` + `sessionID` locate the on-disk session log; when both are
// non-empty, a successful compaction appends a compact_boundary record there so
// a later resume can rebuild the compacted state instead of replaying the full
// pre-compaction transcript. When either is empty, boundary persistence is
// skipped (tests, one-shot callers) and behaviour is unchanged.
//
// toolSchemaNames is every registered tool name (unfiltered); toolSchemas is
// the filtered request schema list. The recovery attachment lists names only
// (TS: manageContext takes both).
func ManageContext(
	ctx context.Context,
	conv *conversation.Manager,
	client llm.Client,
	workDir string,
	sessionID string,
	contextWindow int,
	maxOutput int,
	tracking *AutoCompactTrackingState,
	recovery *RecoveryState,
	toolSchemaNames []string,
	toolSchemas []map[string]any,
) CompactResult {
	// Tool results in history were already budgeted to their final size at
	// ingest time, so conv's own messages reflect the actual payload sent;
	// estimate directly from them.
	baseline, count, has := conv.UsageAnchorState()
	anchor := UsageAnchor{BaselineTokens: baseline, AnchorCount: count, HasUsage: has}
	tokens := ComputeUsedTokens(conv.GetMessages(), anchor)
	// Soft auto-compact trigger: used tokens >= effectiveWindow − auto margin.
	if tokens < computeCompactThreshold(contextWindow, maxOutput, false) {
		return CompactResult{}
	}

	// Hard-block line: once used tokens cross effectiveWindow − manual margin,
	// force a compaction (bypassing the circuit breaker) instead of the soft
	// auto path, since the context is too close to the wall to risk skipping.
	if tokens >= computeCompactThreshold(contextWindow, maxOutput, true) {
		return runManageCompact(ctx, conv, client, workDir, sessionID, contextWindow, recovery, toolSchemaNames, toolSchemas, tracking, "")
	}

	// Circuit breaker: stop retrying after N consecutive failures. Without
	// this, sessions where context is irrecoverably over the limit hammer
	// the API with doomed compaction attempts on every iteration. The message
	// is surfaced to the caller (TS exposes it via the compact event) instead
	// of failing silently.
	if tracking != nil && tracking.ConsecutiveFailures >= MaxConsecutiveAutoCompactFailures {
		return CompactResult{Message: fmt.Sprintf("Auto-compact circuit breaker: %d consecutive failures", MaxConsecutiveAutoCompactFailures)}
	}

	return runManageCompact(ctx, conv, client, workDir, sessionID, contextWindow, recovery, toolSchemaNames, toolSchemas, tracking, "")
}

// runManageCompact is the TS try/catch around doCompact: a successful run
// resets the failure counter, any error increments it and becomes an
// "Auto-compact failed:" message.
func runManageCompact(
	ctx context.Context,
	conv *conversation.Manager,
	client llm.Client,
	workDir string,
	sessionID string,
	contextWindow int,
	recovery *RecoveryState,
	toolSchemaNames []string,
	toolSchemas []map[string]any,
	tracking *AutoCompactTrackingState,
	customInstructions string,
) CompactResult {
	result, err := autoCompact(ctx, conv, client, workDir, sessionID, contextWindow, recovery, toolSchemaNames, toolSchemas, customInstructions)
	if err != nil {
		if tracking != nil {
			tracking.ConsecutiveFailures++
		}
		return CompactResult{Message: "Auto-compact failed: " + err.Error()}
	}
	if tracking != nil {
		tracking.ConsecutiveFailures = 0
	}
	return result
}

// ForceCompact is the manual /compact entry. Always runs Layer 2 (full summary) regardless of
// current token ratio. Layer 1 is skipped because a full summary supersedes the
// tool-result budget anyway. customInstructions is the optional user focus
// appended to the summary instructions (TS: forceCompact).
func ForceCompact(
	ctx context.Context,
	conv *conversation.Manager,
	client llm.Client,
	workDir string,
	sessionID string,
	contextWindow int,
	recovery *RecoveryState,
	toolSchemaNames []string,
	toolSchemas []map[string]any,
	customInstructions string,
) (CompactResult, error) {
	return autoCompact(ctx, conv, client, workDir, sessionID, contextWindow, recovery, toolSchemaNames, toolSchemas, customInstructions)
}

// hasToolResult reports whether a message is the tool_result half of a
// tool_use↔tool_result pair: a user-role message carrying result blocks. Its
// partner tool_use lives on a preceding assistant message; such a message
// must never be kept without its tool_use (TS: hasToolResult).
func hasToolResult(m conversation.Message) bool {
	return m.Role == "user" && len(m.ToolResults) > 0
}

// computeKeepStartIndex chooses the boundary between the prefix that gets
// summarized (messages[:keepStart]) and the recent tail kept verbatim
// (messages[keepStart:]).
//
// Walk back from the tail accumulating per-message tokens (single-message
// EstimateTokens). Stop once EITHER the token lower bound (keepRecentTokens) OR
// the message-count lower bound (minKeepMessages) is met — whichever comes
// first is enough. But never let the accumulated tail exceed keepMaxTokens: if
// including one more message would cross that cap, stop before it.
//
// After the budget walk, snap the boundary backward so it never splits a
// tool_use ↔ tool_result pair: if keepStart lands on a message bearing
// tool_results, move it back past the preceding assistant tool_use message(s)
// so the pair stays whole in the kept tail (keep a full pair rather than an
// orphaned tool_result).
//
// Returns the index; callers treat keepStart <= 0 (or a tiny prefix) as "too
// little to compact" and fall back to the original full-summary behaviour.
func computeKeepStartIndex(messages []conversation.Message) int {
	n := len(messages)
	if n == 0 {
		return 0
	}

	keptTokens := 0
	keptCount := 0
	keepStart := n
	for i := n - 1; i >= 0; i-- {
		msgTokens := EstimateTokens(messages[i : i+1])
		// Upper bound: if adding this message would exceed the cap, stop and
		// leave it in the summarized prefix (don't keep it).
		if keptCount > 0 && keptTokens+msgTokens > keepMaxTokens {
			break
		}
		keptTokens += msgTokens
		keptCount++
		keepStart = i
		// Lower bounds: either satisfied → done.
		if keptTokens >= keepRecentTokens || keptCount >= minKeepMessages {
			break
		}
	}

	// Don't split a tool_use ↔ tool_result pair: if the boundary lands on a
	// tool_result user message, move it back past the assistant tool_use
	// message that produced its ids so the pair stays whole in the kept tail
	// (better to keep one extra pair than to leave an orphaned tool_result).
	keepStart = backUpPastToolUse(messages, keepStart)
	return keepStart
}

// backUpPastToolUse: if messages[keepStart] is a tool_result user message,
// walk back to include the assistant tool_use message that produced its
// tool_use_id(s). Keeps the pair intact; idempotent when the boundary is
// already clean (TS: backUpPastToolUse).
func backUpPastToolUse(messages []conversation.Message, keepStart int) int {
	if keepStart <= 0 || keepStart >= len(messages) {
		return keepStart
	}
	if !hasToolResult(messages[keepStart]) {
		return keepStart
	}
	ids := make(map[string]struct{}, len(messages[keepStart].ToolResults))
	for _, tr := range messages[keepStart].ToolResults {
		ids[tr.ToolUseID] = struct{}{}
	}
	for i := keepStart - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != "assistant" {
			continue
		}
		for _, tu := range m.ToolUses {
			if _, ok := ids[tu.ToolUseID]; ok {
				return i
			}
		}
	}
	// No matching tool_use found (should not happen for well-formed
	// transcripts); leave keepStart unchanged rather than dropping the whole
	// prefix.
	return keepStart
}

// groupMessagesByAPIRound splits messages into groups by API round: each new
// assistant reply starts a new group (TS: groupMessagesByAPIRound). A group
// therefore holds one assistant turn plus the user/tool messages that led up
// to it, so dropping whole groups never orphans a tool_result from its
// tool_use.
func groupMessagesByAPIRound(messages []conversation.Message) [][]conversation.Message {
	var groups [][]conversation.Message
	var current []conversation.Message
	hasAssistant := false

	for _, m := range messages {
		if m.Role == "assistant" && hasAssistant {
			groups = append(groups, current)
			current = nil
			hasAssistant = false
		}
		current = append(current, m)
		if m.Role == "assistant" {
			hasAssistant = true
		}
	}
	if len(current) > 0 {
		groups = append(groups, current)
	}
	return groups
}

// truncateHeadForPTL drops the oldest API-round groups from the prefix
// messages until the estimated token count drops by at least tokenGap.
// Returns nil if there's nothing meaningful left to summarize.
func truncateHeadForPTL(prefix []conversation.Message, tokenGap float64) []conversation.Message {
	groups := groupMessagesByAPIRound(prefix)
	if len(groups) < 2 {
		return nil
	}

	dropCount := 0
	if tokenGap > 0 {
		acc := 0
		for _, g := range groups {
			// TS accumulates per-message estimates (sum of estimateOne), not
			// one ceil over the whole group.
			for i := range g {
				acc += EstimateTokens(g[i : i+1])
			}
			dropCount++
			if float64(acc) >= tokenGap {
				break
			}
		}
	} else {
		dropCount = max(1, len(groups)/5)
	}

	dropCount = min(dropCount, len(groups)-1)
	if dropCount < 1 {
		return nil
	}

	var result []conversation.Message
	for _, g := range groups[dropCount:] {
		result = append(result, g...)
	}
	if len(result) > 0 && result[0].Role != "user" {
		marker := conversation.Message{Role: "user", Content: ptlRetryMarker}
		result = append([]conversation.Message{marker}, result...)
	}
	return result
}

// buildPrefixText serializes prefix messages into a text block for the
// summary LLM call (TS: serializePrefixText). Tool calls keep their full
// JSON-serialized arguments and tool results keep their full content — the
// summarizer needs the actual payloads, not elided placeholders.
func buildPrefixText(prefix []conversation.Message) string {
	parts := make([]string, 0, len(prefix))
	for _, m := range prefix {
		// TS: contentToText(m.content) — block arrays flatten to their text
		// blocks (with placeholders for rich blocks); the summarizer never
		// sees base64.
		content := m.Content
		if len(m.ContentBlocks) > 0 {
			content = utils.ContentToText(m.ContentBlocks)
		}
		text := fmt.Sprintf("[%s]: %s", m.Role, content)
		if len(m.ToolUses) > 0 {
			lines := make([]string, 0, len(m.ToolUses))
			for _, tu := range m.ToolUses {
				args := tu.Arguments
				if args == nil {
					args = map[string]any{}
				}
				lines = append(lines, fmt.Sprintf("%s %s %s", tu.ToolUseID, tu.ToolName, marshalNoHTMLEscape(args)))
			}
			text += "\n[tool calls]\n" + strings.Join(lines, "\n")
		}
		if len(m.ToolResults) > 0 {
			lines := make([]string, 0, len(m.ToolResults))
			for _, tr := range m.ToolResults {
				errLabel := ""
				if tr.IsError {
					errLabel = " (error)"
				}
				lines = append(lines, fmt.Sprintf("%s%s: %s", tr.ToolUseID, errLabel, tr.Content))
			}
			text += "\n[tool results]\n" + strings.Join(lines, "\n")
		}
		parts = append(parts, text)
	}
	return strings.Join(parts, "\n\n")
}

// autoCompact is Layer 2: an LLM summary of the older prefix that replaces only
// messages[:keepStart] with a single summary message, while the recent tail
// (messages[keepStart:]) is preserved verbatim. After the summary lands, a recovery
// block is appended to the summary message so the model still has snapshots of
// the files it just read, the SOPs for any skills it invoked, and the current
// tool listing. When there's too little prefix to summarize, compaction is
// skipped entirely and the conversation is left untouched.
func autoCompact(
	ctx context.Context,
	conv *conversation.Manager,
	client llm.Client,
	workDir string,
	sessionID string,
	contextWindow int,
	recovery *RecoveryState,
	toolSchemaNames []string,
	toolSchemas []map[string]any,
	customInstructions string,
) (CompactResult, error) {
	messages := conv.GetMessages()

	// Select the recent tail to keep verbatim; only the prefix before keepStart
	// is summarized. Degenerate cases: if (almost) everything is already inside
	// the kept tail, compacting would only summarize a tiny prefix — skip it and
	// keep the conversation verbatim rather than churn for no real token savings
	// (TS: MIN_COMPACT_PREFIX guard). The skip is surfaced to the caller so a
	// compact event fires instead of silently doing nothing.
	keepStart := computeKeepStartIndex(messages)
	if keepStart <= 0 || keepStart < minCompactPrefix {
		return CompactResult{
			Message: fmt.Sprintf("Compaction skipped: only %d message(s) to summarize, kept verbatim", keepStart),
		}, nil
	}
	prefix := messages[:keepStart]
	keep := messages[keepStart:]

	// Summarize only the prefix; the retained tail must not appear twice in
	// context. Cache-sharing summary: the original messages are left untouched and
	// the summary instruction is appended at the end. The message prefix matches
	// the main conversation's last API call, so it hits the Prompt Cache and only
	// the trailing summary instruction is billed at full price. On PTL
	// (prompt-too-long) this degrades to text serialization + truncate-and-retry.
	finalSummary, err := callSummaryWithCacheSharing(ctx, client, prefix, toolSchemas, customInstructions)
	if err != nil {
		var ptlErr *llm.ContextTooLongError
		if !errors.As(err, &ptlErr) {
			return CompactResult{}, err
		}
		finalSummary, err = callSummaryWithPTLRetry(ctx, client, prefix, toolSchemas, customInstructions)
		if err != nil {
			return CompactResult{}, err
		}
	}

	// Guard: the conversation must not have been mutated while the summary was
	// in flight (another turn appending, a rewind, etc.). If it changed, the
	// summary no longer describes the live history — keep the current messages
	// instead of replacing them (TS: "Conversation changed during compaction").
	if current := conv.GetMessages(); !sameMessages(current, messages) {
		return CompactResult{}, errors.New("Conversation changed during compaction; keeping the current history")
	}

	// Persist a compact_boundary record so a later resume can rebuild this
	// compacted state (summary + kept tail) instead of replaying the full
	// pre-compaction transcript. Append-only: the original prefix messages stay
	// in the session file but won't be replayed past this boundary. We inline the
	// kept tail with its tool blocks, so a resumed session keeps the full
	// tool-call chain of those recent turns. The boundary stores the pure summary
	// text, not the recovery attachment, since the recovery snapshots are an
	// in-memory rebuild aid unavailable on resume. Skipped when sessionID/workDir
	// is empty (tests, one-shot callers).
	if sessionID != "" && workDir != "" {
		keepRecords := make([]session.KeepMessage, 0, len(keep))
		for _, m := range keep {
			// TS drops messages with neither text nor tool blocks from the
			// boundary (content may be a block array — blocks count).
			if m.Role != "user" && m.Role != "assistant" {
				continue
			}
			if m.Content == "" && len(m.ContentBlocks) == 0 && len(m.ToolUses) == 0 && len(m.ToolResults) == 0 {
				continue
			}
			keepRecords = append(keepRecords, session.FromConversationKeep(m))
		}
		session.SaveCompactBoundary(workDir, sessionID, finalSummary, keepRecords)
	}

	content := BuildCompactionSummaryMessage(finalSummary, len(keep) > 0)
	if sessionID != "" && workDir != "" {
		content += fmt.Sprintf("\n\nIf you need specific details from before compaction (code snippets, error messages, etc.), use ReadFile to read the full session transcript: %s", session.SessionFilePath(workDir, sessionID))
	}
	if attachment := BuildRecoveryAttachment(recovery, toolSchemaNames); attachment != "" {
		content += "\n\n---\n\n" + attachment
	}

	conv.ReplaceWithCompacted(content, keep)
	return CompactResult{
		Compacted: true,
		Message:   fmt.Sprintf("Compacted %d messages into summary (%d chars), kept %d recent messages verbatim", len(prefix), utils.UTF16Len(finalSummary), len(keep)),
	}, nil
}

// sameMessages reports whether two message snapshots are element-wise equal.
// Used by the conversation-changed guard: TS compares message object identity;
// Go's GetMessages returns struct copies, so a deep comparison is the
// equivalent check.
func sameMessages(a, b []conversation.Message) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !reflect.DeepEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

// callSummaryWithCacheSharing keeps the original message list without
// serializing it and appends the summary instruction as a trailing user message
// sent to the LLM. The message prefix matches the main conversation's last call,
// so it hits the Prompt Cache (Anthropic 90% discount, OpenAI 50%, DeepSeek
// ~90%). The message list is passed through as-is, with no truncation: a
// trailing tool_result must appear in the summary request together with its
// tool_use, or the pairing is broken (TS: callSummaryWithCacheSharing).
func callSummaryWithCacheSharing(
	ctx context.Context,
	client llm.Client,
	messages []conversation.Message,
	toolSchemas []map[string]any,
	customInstructions string,
) (string, error) {
	summaryConv := conversation.NewManager()
	summaryConv.AppendMessages(messages)
	summaryConv.AddUserMessage(BuildSummaryInstructions(customInstructions))

	events, errs := client.Stream(ctx, summaryConv, toolSchemas)
	return collectSummary(events, errs)
}

// collectSummary drains a summary stream and validates the outcome (TS:
// collectSummary). The model must answer with prose, not request a tool; the
// stream must end with end_turn/stop; and the formatted summary must be
// non-empty with balanced <summary>/<analysis> tags. Any violation is an error
// so a degenerate reply can never silently replace the conversation history.
func collectSummary(events <-chan llm.StreamEvent, errs <-chan error) (string, error) {
	var text strings.Builder
	var validationErr error
	for ev := range events {
		switch e := ev.(type) {
		case llm.TextDelta:
			text.WriteString(e.Text)
		case llm.ToolCallStart, llm.ToolCallComplete:
			if validationErr == nil {
				validationErr = errors.New("Compaction requested a tool instead of a summary")
			}
		case llm.StreamEnd:
			if validationErr == nil && e.StopReason != "end_turn" && e.StopReason != "stop" {
				validationErr = fmt.Errorf("Compaction summary did not finish: %s", e.StopReason)
			}
		}
	}
	var streamErr error
	select {
	case streamErr = <-errs:
	default:
	}
	if streamErr != nil {
		return "", streamErr
	}
	if validationErr != nil {
		return "", validationErr
	}
	raw := text.String()
	summary := formatCompactSummary(raw)
	if summary == "" ||
		(strings.Contains(raw, "<summary>") && !strings.Contains(raw, "</summary>")) ||
		(strings.Contains(raw, "<analysis>") && !strings.Contains(raw, "</analysis>")) {
		return "", errors.New("Compaction returned an empty or incomplete summary")
	}
	return summary, nil
}

// isPTLError reports whether err is a prompt-too-long failure: either the
// typed ContextTooLongError or a provider error whose message matches the
// same substrings the TS client checks ("prompt"+"long", "too many",
// "context_length") — providers phrase the overrun differently and don't all
// map onto the typed error (TS: requestSummaryWithPTLRetry isPTL).
func isPTLError(err error) bool {
	if err == nil {
		return false
	}
	var ptlErr *llm.ContextTooLongError
	if errors.As(err, &ptlErr) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return (strings.Contains(msg, "prompt") && strings.Contains(msg, "long")) ||
		strings.Contains(msg, "too many") ||
		strings.Contains(msg, "context_length")
}

// callSummaryWithPTLRetry sends the prefix to the LLM for summarization. If
// the request fails with a prompt-too-long error, it drops the oldest
// API-round groups from the prefix and retries, up to maxPTLRetries times.
func callSummaryWithPTLRetry(
	ctx context.Context,
	client llm.Client,
	prefix []conversation.Message,
	toolSchemas []map[string]any,
	customInstructions string,
) (string, error) {
	currentPrefix := prefix
	for attempt := 0; ; attempt++ {
		text := buildPrefixText(currentPrefix)
		summaryConv := conversation.NewManager()
		summaryConv.AddUserMessage(BuildSummaryPrompt(text, customInstructions))

		events, errs := client.Stream(ctx, summaryConv, toolSchemas)
		summary, err := collectSummary(events, errs)
		if err == nil {
			return summary, nil
		}

		if !isPTLError(err) || attempt >= maxPTLRetries {
			return "", err
		}

		// TS: sum of per-message estimates (reduce estimateOne) / 5, not one
		// ceil over the whole prefix.
		gapTokens := 0
		for i := range currentPrefix {
			gapTokens += EstimateTokens(currentPrefix[i : i+1])
		}
		tokenGap := float64(gapTokens) / 5
		truncated := truncateHeadForPTL(currentPrefix, tokenGap)
		if truncated == nil {
			return "", err
		}
		currentPrefix = truncated
	}
}

// formatCompactSummary strips the <analysis> scratchpad block from the model's two-phase response,
// returning only the contents of the <summary> block. Falls back to the raw text when neither tag
// is present (model disobeyed the prompt structure) so we never lose the summary altogether.
func formatCompactSummary(raw string) string {
	if _, after, ok := strings.Cut(raw, "<summary>"); ok {
		body := after
		if before, _, ok := strings.Cut(body, "</summary>"); ok {
			return strings.TrimSpace(before)
		}
		return strings.TrimSpace(body)
	}
	// No <summary> block — drop any <analysis>.</analysis> block if present and return what's left.
	if start := strings.Index(raw, "<analysis>"); start >= 0 {
		if end := strings.Index(raw, "</analysis>"); end > start {
			return strings.TrimSpace(raw[:start] + raw[end+len("</analysis>"):])
		}
	}
	return strings.TrimSpace(raw)
}
