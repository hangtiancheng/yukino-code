package compact

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

// CompactResult is the structured outcome of a compaction. When Compacted is
// true, Boundary carries the summary plus the verbatim kept tail (including
// tool blocks) so the caller that owns the sessionId can persist a
// compact_boundary record — exactly what resume needs to replay.
type CompactResult struct {
	Compacted bool
	Message   string
	Boundary  *session.CompactBoundary
}

// ComputeCompactThreshold mirrors the reference token-budget formula:
// effectiveWindow = contextWindow − min(maxOutput, SummaryOutputReserve),
// minus a margin capped to a ratio of the effective window.
func ComputeCompactThreshold(contextWindow, maxOutput int, manual bool) (int, error) {
	reserve := maxOutput
	if reserve > SummaryOutputReserve {
		reserve = SummaryOutputReserve
	}
	effective := contextWindow - reserve
	if effective <= 0 {
		return 0, fmt.Errorf("Context window %d is too small to compact: after reserving %d tokens for the summary output there is no room left for the conversation.", contextWindow, reserve)
	}
	fixedMargin := AutoCompactSafetyMargin
	ratio := AutoMarginRatio
	if manual {
		fixedMargin = ManualCompactSafetyMargin
		ratio = ManualMarginRatio
	}
	margin := min(fixedMargin, int(math.Floor(float64(effective)*ratio)))
	return effective - margin, nil
}

type AutoCompactTrackingState struct {
	ConsecutiveFailures int
}

// UsageAnchor is the real-token anchor captured after each stream ends:
// the last API-reported context size plus the message count at that moment;
// only messages beyond the anchor are character-estimated.
type UsageAnchor struct {
	BaselineTokens int
	AnchorCount    int
	HasUsage       bool
}

func BaselineFromUsage(u llm.UsageInfo) int {
	return u.InputTokens + u.CacheReadTokens + u.CacheCreationTokens + u.OutputTokens
}

func contentChars(msg conversation.Message) int {
	if len(msg.ContentBlocks) == 0 {
		return utf8.RuneCountInString(msg.Content)
	}
	chars := 0
	for _, block := range msg.ContentBlocks {
		blockType, _ := block["type"].(string)
		switch blockType {
		case "text":
			text, _ := block["text"].(string)
			chars += utf8.RuneCountInString(text)
		case "image":
			chars += ImageCharEquiv
		}
	}
	return chars
}

func toolResultBlocksChars(blocks []map[string]any) (textChars, richChars int) {
	for _, block := range blocks {
		blockType, _ := block["type"].(string)
		switch blockType {
		case "text":
			text, _ := block["text"].(string)
			textChars += utf8.RuneCountInString(text)
		case "image":
			richChars += ImageCharEquiv
		case "tool_reference":
			toolName, _ := block["tool_name"].(string)
			richChars += utf8.RuneCountInString(toolName)
		case "search_result":
			source, _ := block["source"].(string)
			title, _ := block["title"].(string)
			richChars += utf8.RuneCountInString(source) + utf8.RuneCountInString(title)
			if nested, ok := block["content"].([]any); ok {
				for _, item := range nested {
					if record, ok := item.(map[string]any); ok {
						if text, ok := record["text"].(string); ok {
							richChars += utf8.RuneCountInString(text)
						}
					}
				}
			}
		case "document":
			source, _ := block["source"].(map[string]any)
			sourceType, _ := source["type"].(string)
			switch sourceType {
			case "base64":
				richChars += ImageCharEquiv
			case "url":
				raw, _ := source["url"].(string)
				richChars += utf8.RuneCountInString(raw)
			case "text":
				data, _ := source["data"].(string)
				richChars += utf8.RuneCountInString(data)
			case "content":
				if text, ok := source["content"].(string); ok {
					richChars += utf8.RuneCountInString(text)
					break
				}
				if list, ok := source["content"].([]any); ok {
					for _, item := range list {
						record, ok := item.(map[string]any)
						if !ok {
							continue
						}
						if itemType, _ := record["type"].(string); itemType == "text" {
							text, _ := record["text"].(string)
							richChars += utf8.RuneCountInString(text)
						} else {
							richChars += ImageCharEquiv
						}
					}
				}
			}
		}
	}
	return textChars, richChars
}

// EstimateMessages is the rough character-based token estimate over an
// explicit message slice, used for the cold-start whole-transcript fallback,
// the post-anchor increment, and per-message accounting (keep-walk, PTL head
// truncation).
func EstimateMessages(messages []conversation.Message) int {
	totalChars := 0
	for _, msg := range messages {
		totalChars += contentChars(msg)
		if len(msg.ToolUses) > 0 {
			encoded, err := json.Marshal(msg.ToolUses)
			if err == nil {
				totalChars += len(encoded)
			}
		}
		for _, tr := range msg.ToolResults {
			if len(tr.ContentBlocks) > 0 {
				textChars, richChars := toolResultBlocksChars(tr.ContentBlocks)
				totalChars += max(utf8.RuneCountInString(tr.Content), textChars) + richChars
			} else {
				totalChars += utf8.RuneCountInString(tr.Content)
			}
		}
		for _, tb := range msg.ThinkingBlocks {
			if tb.Type == "thinking" {
				totalChars += utf8.RuneCountInString(tb.Thinking)
			} else {
				totalChars += utf8.RuneCountInString(tb.Data)
			}
		}
	}
	return int(math.Ceil(float64(totalChars) / CharsPerToken))
}

func EstimateTokens(conv *conversation.Manager) int {
	return EstimateMessages(conv.GetMessages())
}

func estimateOne(msg conversation.Message) int {
	return EstimateMessages([]conversation.Message{msg})
}

// hasToolResult reports whether the message is the second half of a
// tool_use↔tool_result pair.
func hasToolResult(msg conversation.Message) bool {
	return msg.Role == "user" && len(msg.ToolResults) > 0
}

// ComputeKeepStartIndex chooses where the kept (verbatim) tail begins: walk
// backward accumulating per-message tokens until a "good enough" stop (kept
// tail reached KeepRecentTokens or MinKeepMessages kept), never letting the
// tail exceed KeepMaxTokens.
func ComputeKeepStartIndex(messages []conversation.Message) int {
	keepTokens := 0
	keepCount := 0
	keepStart := len(messages)

	for i := len(messages) - 1; i >= 0; i-- {
		t := estimateOne(messages[i])
		// Upper bound: adding this message would overflow the kept tail.
		if keepCount > 0 && keepTokens+t > KeepMaxTokens {
			break
		}
		keepStart = i
		keepTokens += t
		keepCount++
		// Lower bounds: either floor satisfied → kept enough recent context.
		if keepTokens >= KeepRecentTokens || keepCount >= MinKeepMessages {
			break
		}
	}

	return backUpPastToolUse(messages, keepStart)
}

// backUpPastToolUse keeps tool_use↔tool_result pairs whole: if the boundary
// lands on a tool_result user message, move it back past the assistant
// message carrying the matching tool_use ids.
func backUpPastToolUse(messages []conversation.Message, keepStart int) int {
	if keepStart <= 0 || keepStart >= len(messages) {
		return keepStart
	}
	if !hasToolResult(messages[keepStart]) {
		return keepStart
	}
	ids := map[string]bool{}
	for _, tr := range messages[keepStart].ToolResults {
		ids[tr.ToolUseID] = true
	}
	for i := keepStart - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != "assistant" {
			continue
		}
		for _, tu := range m.ToolUses {
			if ids[tu.ToolUseID] {
				return i
			}
		}
	}
	// No matching tool_use found (shouldn't happen for well-formed
	// transcripts); leave keepStart unchanged.
	return keepStart
}

// CurrentContextTokens trusts the last API-reported token count when an
// anchor exists and only character-estimates the messages appended after it;
// on a cold start it estimates the entire transcript.
func CurrentContextTokens(conv *conversation.Manager) int {
	messages, baseline, anchorCount, hasUsage := conv.UsageSnapshot()
	if !hasUsage {
		return EstimateMessages(messages)
	}
	start := min(anchorCount, len(messages))
	return baseline + EstimateMessages(messages[start:])
}

// ComputeUsedTokens estimates tokens for an explicit anchor (kept for
// callers that track the anchor themselves).
func ComputeUsedTokens(messages []conversation.Message, anchor UsageAnchor) int {
	if !anchor.HasUsage {
		return EstimateMessages(messages)
	}
	if anchor.AnchorCount < 0 || anchor.AnchorCount > len(messages) {
		return EstimateMessages(messages)
	}
	return anchor.BaselineTokens + EstimateMessages(messages[anchor.AnchorCount:])
}

// ManageContext runs the auto-compact judgment for one turn.
func ManageContext(
	ctx context.Context,
	conv *conversation.Manager,
	client llm.Client,
	contextWindow int,
	maxOutput int,
	tracking *AutoCompactTrackingState,
	recovery *RecoveryState,
	toolSchemaNames []string,
	toolSchemas []map[string]any,
	sessionFilePath string,
) (CompactResult, error) {
	tokens := CurrentContextTokens(conv)
	autoThreshold, err := ComputeCompactThreshold(contextWindow, maxOutput, false)
	if err != nil {
		return CompactResult{}, err
	}
	hardBlock, err := ComputeCompactThreshold(contextWindow, maxOutput, true)
	if err != nil {
		return CompactResult{}, err
	}
	if tokens < autoThreshold {
		return CompactResult{}, nil
	}

	// Past the hard-block line we must compact even if the circuit breaker
	// tripped.
	forced := tokens >= hardBlock
	if !forced && tracking != nil && tracking.ConsecutiveFailures >= MaxConsecutiveFailures {
		return CompactResult{Message: fmt.Sprintf("Auto-compact circuit breaker: %d consecutive failures", MaxConsecutiveFailures)}, nil
	}

	result, err := doCompact(ctx, conv, client, recovery, toolSchemaNames, toolSchemas, sessionFilePath, "")
	if err != nil {
		if tracking != nil {
			tracking.ConsecutiveFailures++
		}
		return CompactResult{Message: "Auto-compact failed: " + utils.AsErrorString(err)}, nil
	}
	if tracking != nil {
		tracking.ConsecutiveFailures = 0
	}
	return result, nil
}

// ForceCompact compacts regardless of the token judgment (the /compact
// command and the context-too-long recovery path).
func ForceCompact(
	ctx context.Context,
	conv *conversation.Manager,
	client llm.Client,
	recovery *RecoveryState,
	toolSchemaNames []string,
	toolSchemas []map[string]any,
	sessionFilePath string,
	customInstructions string,
) (CompactResult, error) {
	return doCompact(ctx, conv, client, recovery, toolSchemaNames, toolSchemas, sessionFilePath, customInstructions)
}

// groupMessagesByAPIRound groups messages by API round: each new assistant
// reply starts a new group.
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

// truncateHeadForPTL drops the oldest API round groups until enough tokens
// are freed.
func truncateHeadForPTL(prefix []conversation.Message, tokenGap float64) []conversation.Message {
	groups := groupMessagesByAPIRound(prefix)
	if len(groups) < 2 {
		return nil
	}
	var dropCount int
	if tokenGap > 0 {
		acc := 0
		for _, g := range groups {
			acc += EstimateMessages(g)
			dropCount++
			if float64(acc) >= tokenGap {
				break
			}
		}
	} else {
		dropCount = max(1, len(groups)/PTLTruncateDivisor)
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
		result = append([]conversation.Message{{Role: "user", Content: PTLRetryMarker}}, result...)
	}
	return result
}

// serializePrefixText renders the prefix for the non-cache-sharing summary
// prompt; image blocks flatten to short placeholders so a text-only
// summarizer never sees base64.
func serializePrefixText(messages []conversation.Message) string {
	parts := make([]string, 0, len(messages))
	for _, m := range messages {
		var content any = m.Content
		if len(m.ContentBlocks) > 0 {
			content = m.ContentBlocks
		}
		text := fmt.Sprintf("[%s]: %s", m.Role, utils.ContentToText(content))
		if len(m.ToolUses) > 0 {
			lines := make([]string, 0, len(m.ToolUses))
			for _, tu := range m.ToolUses {
				argsJSON, _ := json.Marshal(tu.Arguments)
				lines = append(lines, fmt.Sprintf("%s %s %s", tu.ToolUseID, tu.ToolName, argsJSON))
			}
			text += "\n[tool calls]\n" + strings.Join(lines, "\n")
		}
		if len(m.ToolResults) > 0 {
			lines := make([]string, 0, len(m.ToolResults))
			for _, tr := range m.ToolResults {
				suffix := ""
				if tr.IsError {
					suffix = " (error)"
				}
				lines = append(lines, fmt.Sprintf("%s%s: %s", tr.ToolUseID, suffix, tr.Content))
			}
			text += "\n[tool results]\n" + strings.Join(lines, "\n")
		}
		parts = append(parts, text)
	}
	return strings.Join(parts, "\n\n")
}

// formatCompactSummary extracts the <summary> block; without one it strips
// any unprompted <analysis> block and falls back to the remaining raw text.
func formatCompactSummary(raw string) string {
	if match := SummaryBlockRe.FindStringSubmatch(raw); match != nil {
		return strings.TrimSpace(match[1])
	}
	if match := AnalysisBlockRe.FindString(raw); match != "" {
		return strings.TrimSpace(strings.Replace(raw, match, "", 1))
	}
	return strings.TrimSpace(raw)
}

// callSummaryWithCacheSharing keeps the original message list without
// serializing it and appends the summary instruction as a trailing user
// message, so the prefix matches the main conversation's last API call and
// hits the Prompt Cache.
func callSummaryWithCacheSharing(ctx context.Context, client llm.Client, messages []conversation.Message, toolSchemas []map[string]any, customInstructions string) (string, error) {
	summaryConv := conversation.NewManager()
	summaryConv.AppendMessages(messages)
	summaryConv.AddUserMessage(BuildSummaryInstructions(customInstructions))
	return collectSummary(ctx, client, summaryConv, toolSchemas)
}

func collectSummary(ctx context.Context, client llm.Client, conv *conversation.Manager, tools []map[string]any) (string, error) {
	for attempt := 0; ; attempt++ {
		text, err := collectSummaryAttempt(ctx, client, conv, tools)
		if err == nil {
			return text, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", ctxErr
		}
		wait, retry := llm.LLMRetryDelay(err, attempt)
		if !retry {
			return "", err
		}
		timer := time.NewTimer(wait)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return "", ctx.Err()
		}
	}
}

func collectSummaryAttempt(ctx context.Context, client llm.Client, conv *conversation.Manager, tools []map[string]any) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	maxOutputTokens := config.DefaultMaxOutputTokens
	thinkingTokens := 0
	if budgetProvider, ok := client.(llm.OutputBudgetProvider); ok {
		budget := budgetProvider.GetOutputBudget()
		thinkingTokens = budget.ThinkingTokens
		if budget.MaxOutputTokens > 0 {
			maxOutputTokens = budget.MaxOutputTokens
		}
	}
	maxOutput := max(1, min(thinkingTokens+SummaryAnswerReserveTokens, maxOutputTokens))
	streamCtx := llm.WithMaxOutputTokens(ctx, maxOutput)
	streamCtx = llm.WithAnswerReserveTokens(streamCtx, SummaryAnswerReserveTokens)

	events, errs := client.Stream(streamCtx, conv, tools)
	var text strings.Builder
	completed := false
	for events != nil || errs != nil {
		select {
		case event, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
			switch e := event.(type) {
			case llm.ToolCallStart:
				_ = e
				return "", errors.New(CompactionToolCallError)
			case llm.ToolCallComplete:
				return "", errors.New(CompactionToolCallError)
			case llm.TextDelta:
				text.WriteString(e.Text)
			case llm.StreamEnd:
				if e.StopReason != "end_turn" && e.StopReason != "stop" {
					return "", fmt.Errorf("Compaction summary did not finish: %s", e.StopReason)
				}
				completed = true
			}
		case err, ok := <-errs:
			if !ok {
				errs = nil
			} else if err != nil {
				return "", err
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !completed {
		return "", errors.New(CompactionStreamIncompleteError)
	}
	summary := formatCompactSummary(text.String())
	if summary == "" ||
		(strings.Contains(text.String(), SummaryOpenTag) && !strings.Contains(text.String(), SummaryCloseTag)) ||
		(strings.Contains(text.String(), AnalysisOpenTag) && !strings.Contains(text.String(), AnalysisCloseTag)) {
		return "", errors.New(CompactionEmptySummaryError)
	}
	return summary, nil
}

// requestSummaryWithPTLRetry is summary generation with prompt-too-long
// retry: each retry truncates roughly one fifth of the summarized prefix.
func requestSummaryWithPTLRetry(ctx context.Context, client llm.Client, prefix []conversation.Message, toolSchemas []map[string]any, customInstructions string) (string, error) {
	currentPrefix := prefix
	for attempt := 0; ; attempt++ {
		text := serializePrefixText(currentPrefix)
		summaryConv := conversation.NewManager()
		summaryConv.AddUserMessage(BuildSummaryPrompt(text, customInstructions))

		summary, err := collectSummary(ctx, client, summaryConv, toolSchemas)
		if err == nil {
			return summary, nil
		}
		msg := strings.ToLower(err.Error())
		var tooLong *llm.ContextTooLongError
		isPTL := errors.As(err, &tooLong) ||
			(strings.Contains(msg, "prompt") && strings.Contains(msg, "long")) ||
			strings.Contains(msg, "too many") ||
			strings.Contains(msg, "context_length")
		if !isPTL || attempt >= MaxPTLRetries {
			return "", err
		}
		tokenGap := float64(EstimateMessages(currentPrefix)) / PTLTruncateDivisor
		truncated := truncateHeadForPTL(currentPrefix, tokenGap)
		if truncated == nil {
			return "", err
		}
		currentPrefix = truncated
	}
}

func doCompact(
	ctx context.Context,
	conv *conversation.Manager,
	client llm.Client,
	recovery *RecoveryState,
	toolSchemaNames []string,
	toolSchemas []map[string]any,
	sessionFilePath string,
	customInstructions string,
) (CompactResult, error) {
	if err := ctx.Err(); err != nil {
		return CompactResult{}, err
	}
	// Tool results in the transcript were already budget-processed to their
	// final form at insertion time; the retention boundary is determined
	// directly from the conversation's own messages.
	estimationMessages := conv.GetMessages()

	keepStart := ComputeKeepStartIndex(estimationMessages)
	if keepStart <= 0 || keepStart < MinCompactPrefix {
		return CompactResult{
			Compacted: false,
			Message:   fmt.Sprintf("Compaction skipped: only %d message(s) to summarize, kept verbatim", keepStart),
		}, nil
	}

	toSummarize := estimationMessages[:keepStart]
	toKeep := estimationMessages[keepStart:]

	// Summarize only the prefix; the retained tail must not appear twice in
	// context.
	summary, err := callSummaryWithCacheSharing(ctx, client, toSummarize, toolSchemas, customInstructions)
	if err != nil {
		var tooLong *llm.ContextTooLongError
		if !errors.As(err, &tooLong) {
			return CompactResult{}, err
		}
		summary, err = requestSummaryWithPTLRetry(ctx, client, toSummarize, toolSchemas, customInstructions)
		if err != nil {
			return CompactResult{}, err
		}
	}

	if err := ctx.Err(); err != nil {
		return CompactResult{}, err
	}
	currentMessages := conv.GetMessages()
	if len(currentMessages) != len(estimationMessages) || !messagesIdentical(currentMessages, estimationMessages) {
		return CompactResult{}, errors.New(CompactionConversationChangedError)
	}

	recoveryAttachment := ""
	if recovery != nil {
		recoveryAttachment = recovery.BuildRecoveryAttachment(toolSchemaNames)
	}

	summaryContent := BuildCompactionSummaryMessage(summary, len(toKeep) > 0)
	if sessionFilePath != "" {
		summaryContent += BuildSessionTranscriptHint(sessionFilePath)
	}
	if recoveryAttachment != "" {
		summaryContent += RecoveryAttachmentDivider + recoveryAttachment
	}
	conv.ReplaceWithCompacted(summaryContent, toKeep)

	// Build the boundary payload the session owner will persist. The summary
	// here excludes the recovery attachment (rebuilt fresh per process) but
	// keeps the transcript hint: the session file outlives the process.
	persistedSummary := summary
	if sessionFilePath != "" {
		persistedSummary += BuildSessionTranscriptHint(sessionFilePath)
	}
	var keep []session.KeepMessage
	for _, m := range toKeep {
		if (m.Role == "user" || m.Role == "assistant") &&
			(m.Content != "" || len(m.ContentBlocks) > 0 || len(m.ToolUses) > 0 || len(m.ToolResults) > 0 || len(m.ThinkingBlocks) > 0) {
			keep = append(keep, session.FromConversationKeep(m))
		}
	}

	return CompactResult{
		Compacted: true,
		Message: fmt.Sprintf("Compacted %d messages into summary (%d chars), kept %d recent messages verbatim",
			len(toSummarize), utf8.RuneCountInString(summary), len(toKeep)),
		Boundary: &session.CompactBoundary{Summary: persistedSummary, Keep: keep},
	}, nil
}

func messagesIdentical(a, b []conversation.Message) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Role != b[i].Role || a[i].Content != b[i].Content ||
			len(a[i].ToolUses) != len(b[i].ToolUses) || len(a[i].ToolResults) != len(b[i].ToolResults) ||
			len(a[i].ThinkingBlocks) != len(b[i].ThinkingBlocks) || len(a[i].ContentBlocks) != len(b[i].ContentBlocks) {
			return false
		}
	}
	return true
}
