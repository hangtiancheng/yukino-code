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

package compact

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/session"
)

// stubSummaryClient implements llm.Client and streams a fixed <summary> block,
// so autoCompact's summarization step is deterministic in tests. It records the
// prompt it was asked to summarize so tests can assert that only the prefix —
// not the kept tail — was summarized.
type stubSummaryClient struct {
	summary      string
	lastPrompt   string
	allMessages  []conversation.Message
	streamCalled bool
}

func (c *stubSummaryClient) SetSystemPrompt(prompt string) {}

func (c *stubSummaryClient) Protocol() string { return "" }

func (c *stubSummaryClient) GetThinkingLevel() config.ThinkingLevel { return config.ThinkingOff }
func (c *stubSummaryClient) SetThinkingLevel(level config.ThinkingLevel) config.ThinkingLevel {
	return level
}
func (c *stubSummaryClient) GetSupportedThinkingLevels() []config.ThinkingLevel { return nil }

func (c *stubSummaryClient) Stream(ctx context.Context, conv *conversation.Manager, tools []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	c.streamCalled = true
	msgs := conv.GetMessages()
	c.allMessages = msgs
	if len(msgs) > 0 {
		c.lastPrompt = msgs[len(msgs)-1].Content
	}
	ch := make(chan llm.StreamEvent, 4)
	errCh := make(chan error, 1)
	ch <- llm.TextDelta{Text: "<summary>" + c.summary + "</summary>"}
	ch <- llm.StreamEnd{StopReason: "end_turn"}
	close(ch)
	errCh <- nil
	close(errCh)
	return ch, errCh
}

// Layer 1 (offload + snip) tests have moved to internal/toolresult/budget_test.go
// where the implementation now lives. compact only owns Layer 2 (autoCompact)
// plus the formatCompactSummary helper, so this file covers those.

func TestFormatCompactSummary(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "both blocks present",
			in:   "<analysis>scratch thoughts</analysis>\n<summary>final text</summary>",
			want: "final text",
		},
		{
			name: "summary block unterminated",
			in:   "<analysis>scratch</analysis>\n<summary>tail with no close tag",
			want: "tail with no close tag",
		},
		{
			name: "only analysis block — drop it",
			in:   "prefix <analysis>scratch</analysis> suffix",
			want: "prefix  suffix",
		},
		{
			name: "neither block — return raw",
			in:   "plain text response",
			want: "plain text response",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := formatCompactSummary(tc.in)
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// EstimateTokens covers all content sources without crashing on empty.
func TestEstimateTokensZeroAndPopulated(t *testing.T) {
	if got := EstimateTokens(nil); got != 0 {
		t.Errorf("empty input should be 0 tokens, got %d", got)
	}
	conv := conversation.NewManager()
	conv.AddUserMessage(strings.Repeat("x", 700))
	got := EstimateTokens(conv.GetMessages())
	if got < 150 || got > 250 {
		t.Errorf("700-char message should estimate ~200 tokens, got %d", got)
	}
}

// BaselineFromUsage must sum all four real-token counters so the anchor reflects
// the true prompt+output size even when cache hits dominate (input small,
// cache_read large).
func TestBaselineFromUsage(t *testing.T) {
	u := llm.UsageInfo{
		InputTokens:         100,
		OutputTokens:        40,
		CacheReadTokens:     5000,
		CacheCreationTokens: 200,
	}
	if got, want := BaselineFromUsage(u), 5340; got != want {
		t.Errorf("BaselineFromUsage = %d, want %d", got, want)
	}
	// Zero usage (compat endpoint that reports nothing) → zero baseline so the
	// caller knows not to adopt it as an anchor.
	if got := BaselineFromUsage(llm.UsageInfo{}); got != 0 {
		t.Errorf("empty usage baseline = %d, want 0", got)
	}
}

// ComputeUsedTokens: with no anchor (cold start / first turn) it must fall back
// to a full character estimate over every message, matching EstimateTokens.
func TestComputeUsedTokensColdStartFallback(t *testing.T) {
	conv := conversation.NewManager()
	conv.AddUserMessage(strings.Repeat("x", 700))
	conv.AddAssistantMessage(strings.Repeat("y", 700))
	msgs := conv.GetMessages()

	got := ComputeUsedTokens(msgs, UsageAnchor{}) // HasUsage == false
	want := EstimateTokens(msgs)
	if got != want {
		t.Errorf("cold-start ComputeUsedTokens = %d, want full estimate %d", got, want)
	}
}

// ComputeUsedTokens: with an anchor it must return baseline + an estimate of
// ONLY the messages appended past anchorCount — not a re-estimate of the whole
// transcript. This is the cache-hit win: the real input was far smaller than the
// character count of the anchored prefix.
func TestComputeUsedTokensWithAnchorIncremental(t *testing.T) {
	conv := conversation.NewManager()
	// 3 large anchored messages: their real token cost is captured by baseline,
	// NOT by their character count.
	conv.AddUserMessage(strings.Repeat("x", 7000))
	conv.AddAssistantMessage(strings.Repeat("y", 7000))
	conv.AddUserMessage(strings.Repeat("z", 7000))
	anchorCount := conv.Len()
	// One small message appended after the anchor.
	conv.AddAssistantMessage(strings.Repeat("w", 350))
	msgs := conv.GetMessages()

	const baseline = 1500 // pretend the real API said the prefix cost 1500 tokens
	anchor := UsageAnchor{BaselineTokens: baseline, AnchorCount: anchorCount, HasUsage: true}

	got := ComputeUsedTokens(msgs, anchor)
	wantIncrement := EstimateTokens(msgs[anchorCount:])
	if got != baseline+wantIncrement {
		t.Errorf("anchored ComputeUsedTokens = %d, want baseline+increment %d", got, baseline+wantIncrement)
	}
	// Sanity: the incremental result must be far below a full character estimate
	// of the (cache-heavy) transcript, proving we didn't re-estimate the prefix.
	if full := EstimateTokens(msgs); got >= full {
		t.Errorf("anchored result %d should be below full estimate %d", got, full)
	}
}

// ComputeUsedTokens: a stale anchor (AnchorCount past the current message count,
// e.g. after a compaction rewound the transcript) must not panic. TS clamps
// start = Math.min(anchorCount, messages.length), so the increment is an empty
// slice and the result is exactly the baseline (currentContextTokens).
func TestComputeUsedTokensStaleAnchorClamp(t *testing.T) {
	conv := conversation.NewManager()
	conv.AddUserMessage("hi")
	msgs := conv.GetMessages()

	anchor := UsageAnchor{BaselineTokens: 9999, AnchorCount: 50, HasUsage: true}
	got := ComputeUsedTokens(msgs, anchor)
	if want := anchor.BaselineTokens; got != want {
		t.Errorf("stale-anchor ComputeUsedTokens = %d, want baseline %d", got, want)
	}
}

// bigMsg returns a message whose content alone estimates to roughly `tokens`
// tokens (recoveryCharsPerToken ≈ 3.5 chars/token), so tests can drive the
// keepRecentTokens budget walk deterministically.
func bigMsg(tokens int) string {
	return strings.Repeat("x", tokens*4)
}

// containsMsg reports whether any message in msgs has content equal to want.
func containsMsg(msgs []conversation.Message, want string) bool {
	for _, m := range msgs {
		if m.Content == want {
			return true
		}
	}
	return false
}

// autoCompact must keep the recent tail verbatim, not replace it with the
// summary. We build a transcript whose older prefix is large enough to clear
// keepStart > 0 and whose tail carries distinctive content; after compaction
// the tail content must still be present (not only the summary).
func TestAutoCompactKeepsRecentVerbatim(t *testing.T) {
	conv := conversation.NewManager()
	// Older prefix: several large messages that should be summarized away.
	for range 6 {
		conv.AddUserMessage("OLD-PREFIX " + bigMsg(3000))
		conv.AddAssistantMessage("OLD-REPLY " + bigMsg(3000))
	}
	// Recent tail: distinctive small messages we expect to survive verbatim.
	recent := []string{"RECENT-A unique-marker-A", "RECENT-B unique-marker-B"}
	conv.AddUserMessage(recent[0])
	conv.AddAssistantMessage(recent[1])

	client := &stubSummaryClient{summary: "THE SUMMARY"}
	result, err := autoCompact(context.Background(), conv, client, "", "", 200000, nil, nil, nil, "")
	if err != nil {
		t.Fatalf("autoCompact error: %v", err)
	}
	if result.Message == "" {
		t.Fatalf("expected a compaction message, got empty (degraded to no-op)")
	}
	out := conv.GetMessages()

	// Summary must be present.
	var sawSummary bool
	for _, m := range out {
		if strings.Contains(m.Content, "THE SUMMARY") {
			sawSummary = true
		}
	}
	if !sawSummary {
		t.Errorf("summary not present after compaction")
	}
	// Recent tail must be preserved verbatim, not collapsed into the summary.
	for _, r := range recent {
		if !containsMsg(out, r) {
			t.Errorf("recent message %q not preserved verbatim after compaction; messages=%v", r, msgContents(out))
		}
	}
}

// When a sessionID + workDir are wired, autoCompact must persist a
// compact_boundary record into the session log: the inlined summary plus the
// kept tail (role+content). This is the on-disk half of the resume round-trip —
// session.FindLastCompactBoundary then rebuilds the compacted state from it.
func TestAutoCompactPersistsBoundary(t *testing.T) {
	conv := conversation.NewManager()
	for range 6 {
		conv.AddUserMessage("OLD-PREFIX " + bigMsg(3000))
		conv.AddAssistantMessage("OLD-REPLY " + bigMsg(3000))
	}
	conv.AddUserMessage("RECENT-TAIL-USER unique-marker-A")
	conv.AddAssistantMessage("RECENT-TAIL-ASSISTANT unique-marker-B")

	workDir := t.TempDir()
	sid := "compact-roundtrip"
	client := &stubSummaryClient{summary: "PERSISTED-SUMMARY"}

	msg, err := autoCompact(context.Background(), conv, client, workDir, sid, 200000, nil, nil, nil, "")
	if err != nil {
		t.Fatalf("autoCompact error: %v", err)
	}
	if msg.Message == "" {
		t.Fatalf("expected a compaction message, got empty (degraded to no-op)")
	}

	// Read the session log back and assert the boundary was written with the
	// summary + the kept tail inlined.
	msgs := session.LoadSession(workDir, sid)
	boundary, after, ok := session.FindLastCompactBoundary(msgs)
	if !ok {
		t.Fatalf("expected a compact_boundary record to be persisted")
	}
	if boundary.Summary != "PERSISTED-SUMMARY" {
		t.Fatalf("persisted summary mismatch: got %q", boundary.Summary)
	}
	if len(after) != 0 {
		t.Fatalf("no messages should follow a freshly written boundary, got %d", len(after))
	}
	// The kept tail must be inlined verbatim into the boundary.
	var sawTailUser, sawTailAssistant bool
	for _, k := range boundary.Keep {
		if k.Content == "RECENT-TAIL-USER unique-marker-A" {
			sawTailUser = true
		}
		if k.Content == "RECENT-TAIL-ASSISTANT unique-marker-B" {
			sawTailAssistant = true
		}
	}
	if !sawTailUser || !sawTailAssistant {
		t.Fatalf("kept tail not inlined into boundary: %+v", boundary.Keep)
	}
	// The boundary's kept tail must exactly equal the conversation's tail that
	// autoCompact preserved verbatim (same role+content, in order). The summary
	// stored on disk is the pure summary text, and after the in-memory rebuild
	// the conversation is [summary user msg] + [continuation ack] + keep, so the
	// kept tail lives at the end of the rebuilt conversation.
	rebuilt := conv.GetMessages()
	tail := rebuilt[len(rebuilt)-len(boundary.Keep):]
	for i, k := range boundary.Keep {
		if tail[i].Role != k.Role || tail[i].Content != k.Content {
			t.Fatalf("boundary keep[%d]=%+v does not match in-memory tail %+v", i, k, tail[i])
		}
	}
}

// Without a sessionID/workDir, autoCompact must NOT touch any session log
// (one-shot callers, tests, sub-agents) — behaviour stays as before.
func TestAutoCompactNoSessionNoBoundary(t *testing.T) {
	conv := conversation.NewManager()
	for range 6 {
		conv.AddUserMessage("OLD-PREFIX " + bigMsg(3000))
		conv.AddAssistantMessage("OLD-REPLY " + bigMsg(3000))
	}
	conv.AddUserMessage("RECENT-A")
	conv.AddAssistantMessage("RECENT-B")

	workDir := t.TempDir()
	client := &stubSummaryClient{summary: "S"}
	// Empty sessionID → no persistence.
	if _, err := autoCompact(context.Background(), conv, client, workDir, "", 200000, nil, nil, nil, ""); err != nil {
		t.Fatalf("autoCompact error: %v", err)
	}
	// No session file should have been created under any id.
	msgs := session.LoadSession(workDir, "anything")
	if len(msgs) != 0 {
		t.Fatalf("expected no session log written when sessionID empty, got %d", len(msgs))
	}
}

// autoCompact must summarize only messages[:keepStart]; the kept tail must NOT
// appear in the prompt handed to the summarizer.
func TestAutoCompactCacheSharingUsesOriginalMessages(t *testing.T) {
	conv := conversation.NewManager()
	for i := 0; i < 6; i++ {
		conv.AddUserMessage("PREFIX-CONTENT " + bigMsg(3000))
		conv.AddAssistantMessage("PREFIX-REPLY " + bigMsg(3000))
	}
	conv.AddUserMessage("RECENT-MARKER")
	conv.AddAssistantMessage("RECENT-REPLY")

	client := &stubSummaryClient{summary: "S"}
	if _, err := autoCompact(context.Background(), conv, client, "", "", 200000, nil, nil, nil, ""); err != nil {
		t.Fatalf("autoCompact error: %v", err)
	}
	if !client.streamCalled {
		t.Fatalf("summarizer was never called")
	}
	// On the cache-sharing path the summary call reuses the original messages
	// (without serializing them to text); the last message is the summary
	// instruction.
	lastMsg := client.allMessages[len(client.allMessages)-1]
	if !strings.Contains(lastMsg.Content, "summary") {
		t.Errorf("last message should be the summary prompt, got: %s", lastMsg.Content[:100])
	}
	// The message list must include the prefix content (the core of cache
	// sharing: the original messages are left untouched).
	allContent := ""
	for _, m := range client.allMessages {
		allContent += m.Content + " "
	}
	if !strings.Contains(allContent, "PREFIX-CONTENT") {
		t.Errorf("summary messages must include prefix content for cache sharing")
	}
	// Only the compacted prefix is summarized (TS compact.ts:630-642): the kept
	// tail must not appear in the summary request, or the tail content would be
	// double-counted in the context.
	if strings.Contains(allContent, "RECENT-MARKER") {
		t.Errorf("kept tail must not be sent to the summarizer (double-counted context)")
	}
}

// computeKeepStartIndex must never split a tool_use ↔ tool_result pair: if the
// budget boundary lands on the user message carrying tool_results, it must move
// back to include the assistant tool_use message that produced them.
func TestComputeKeepStartIndexDoesNotSplitToolPair(t *testing.T) {
	conv := conversation.NewManager()
	// Large prefix so keepStart > 0.
	for range 8 {
		conv.AddUserMessage(bigMsg(3000))
		conv.AddAssistantMessage(bigMsg(3000))
	}
	// A tool_use / tool_result pair near the tail. The tool_result is a big
	// message so the budget boundary is likely to land right on it.
	conv.AddToolUseMessage("calling tool", "tu-1", "ReadFile", map[string]any{"path": "/x"})
	conv.AddToolResultMessage("tu-1", bigMsg(9000), false, nil)
	msgs := conv.GetMessages()

	keepStart := computeKeepStartIndex(msgs)
	if keepStart <= 0 || keepStart >= len(msgs) {
		t.Fatalf("keepStart=%d out of expected range (0, %d)", keepStart, len(msgs))
	}
	// The boundary message must not be a lone tool_result whose matching
	// tool_use was left in the summarized prefix.
	if hasToolResult(msgs[keepStart]) {
		t.Fatalf("keepStart landed on a tool_result message (orphaned); keepStart=%d", keepStart)
	}
	// Verify the pair is whole inside the kept tail: walk it and ensure every
	// tool_result has a preceding tool_use within the kept slice.
	keep := msgs[keepStart:]
	openUses := map[string]bool{}
	for _, m := range keep {
		for _, tu := range m.ToolUses {
			openUses[tu.ToolUseID] = true
		}
		for _, tr := range m.ToolResults {
			if !openUses[tr.ToolUseID] {
				t.Errorf("tool_result %s in kept tail has no matching tool_use in tail (pair split)", tr.ToolUseID)
			}
		}
	}
}

// When the conversation is too short to have any summarizable prefix (keepStart
// <= 0), autoCompact must degrade to a no-op: no summarization, conversation
// left untouched.
func TestAutoCompactDegradesWhenTooFewMessages(t *testing.T) {
	conv := conversation.NewManager()
	conv.AddUserMessage("just one")
	conv.AddAssistantMessage("two")
	before := conv.GetMessages()

	client := &stubSummaryClient{summary: "S"}
	result, err := autoCompact(context.Background(), conv, client, "", "", 200000, nil, nil, nil, "")
	if err != nil {
		t.Fatalf("autoCompact error: %v", err)
	}
	// TS reports the skip instead of returning nothing, so the caller can
	// surface a compact event (compact.ts:623-628).
	if want := "Compaction skipped: only 0 message(s) to summarize, kept verbatim"; result.Message != want {
		t.Errorf("got %q, want %q", result.Message, want)
	}
	if result.Compacted {
		t.Errorf("degenerate compaction must not report a compaction")
	}
	if client.streamCalled {
		t.Errorf("summarizer should not be called when degrading to no-op")
	}
	after := conv.GetMessages()
	if len(before) != len(after) {
		t.Errorf("conversation changed during no-op: before=%d after=%d", len(before), len(after))
	}
	for i := range before {
		if before[i].Content != after[i].Content {
			t.Errorf("message %d mutated during no-op", i)
		}
	}
}

func msgContents(msgs []conversation.Message) []string {
	out := make([]string, len(msgs))
	for i, m := range msgs {
		c := m.Content
		if len(c) > 40 {
			c = c[:40] + "..."
		}
		out[i] = c
	}
	return out
}

// --- TS-alignment tests (compact.ts) ---

// stubEvents builds a buffered event/error channel pair for collectSummary tests.
func stubEvents(events ...llm.StreamEvent) (<-chan llm.StreamEvent, <-chan error) {
	ch := make(chan llm.StreamEvent, len(events)+1)
	for _, ev := range events {
		ch <- ev
	}
	close(ch)
	errCh := make(chan error, 1)
	errCh <- nil
	close(errCh)
	return ch, errCh
}

// collectSummary must reject a model that requests a tool instead of
// summarizing (TS compact.ts:527-532).
func TestCollectSummaryRejectsToolCall(t *testing.T) {
	events, errs := stubEvents(
		llm.ToolCallStart{ToolName: "ReadFile", ToolID: "t1"},
		llm.StreamEnd{StopReason: "end_turn"},
	)
	if _, err := collectSummary(events, errs); err == nil ||
		!strings.Contains(err.Error(), "requested a tool") {
		t.Fatalf("expected tool-request error, got %v", err)
	}
}

// collectSummary must reject a stream that ends with a non-final stop reason
// (TS compact.ts:536-542).
func TestCollectSummaryRejectsBadStopReason(t *testing.T) {
	events, errs := stubEvents(
		llm.TextDelta{Text: "<summary>partial</summary>"},
		llm.StreamEnd{StopReason: "max_tokens"},
	)
	if _, err := collectSummary(events, errs); err == nil ||
		!strings.Contains(err.Error(), "did not finish") {
		t.Fatalf("expected stop-reason error, got %v", err)
	}
}

// collectSummary must reject empty summaries and unbalanced <summary>/
// <analysis> tags so a degenerate reply can never replace the history
// (TS compact.ts:545-553).
func TestCollectSummaryRejectsEmptyOrIncomplete(t *testing.T) {
	cases := []struct{ name, text string }{
		{"empty", ""},
		{"unclosed summary tag", "<summary>no close tag"},
		{"unclosed analysis tag", "<analysis>scratch\n<summary>ok</summary>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			events, errs := stubEvents(
				llm.TextDelta{Text: tc.text},
				llm.StreamEnd{StopReason: "end_turn"},
			)
			if _, err := collectSummary(events, errs); err == nil ||
				!strings.Contains(err.Error(), "empty or incomplete summary") {
				t.Fatalf("expected incomplete-summary error, got %v", err)
			}
		})
	}
}

// collectSummary accepts a well-formed reply and returns the bare summary.
func TestCollectSummaryAcceptsValidReply(t *testing.T) {
	events, errs := stubEvents(
		llm.TextDelta{Text: "<analysis>scratch</analysis>\n<summary>the summary</summary>"},
		llm.StreamEnd{StopReason: "end_turn"},
	)
	got, err := collectSummary(events, errs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "the summary" {
		t.Errorf("got %q, want %q", got, "the summary")
	}
}

// isPTLError must match the typed error plus the TS substring rules
// (TS compact.ts:577-584).
func TestIsPTLError(t *testing.T) {
	positive := []error{
		&llm.ContextTooLongError{Message: "Context too long"},
		errors.New("your prompt is too long"),
		errors.New("too many tokens in messages"),
		errors.New("openai: context_length_exceeded"),
	}
	for _, err := range positive {
		if !isPTLError(err) {
			t.Errorf("isPTLError(%v) = false, want true", err)
		}
	}
	negative := []error{
		nil,
		errors.New("rate limited"),
		errors.New("connection reset"),
	}
	for _, err := range negative {
		if isPTLError(err) {
			t.Errorf("isPTLError(%v) = true, want false", err)
		}
	}
}

// groupMessagesByAPIRound must start a new group at EVERY assistant message
// (TS compact.ts:409-427), not only after tool_result boundaries.
func TestGroupMessagesByAPIRoundStartsNewGroupPerAssistant(t *testing.T) {
	msgs := []conversation.Message{
		{Role: "user", Content: "q1"},
		{Role: "assistant", Content: "a1"},
		{Role: "user", Content: "q2"},
		{Role: "assistant", Content: "a2"},
		{Role: "user", Content: "q3"},
	}
	groups := groupMessagesByAPIRound(msgs)
	if len(groups) != 2 {
		t.Fatalf("got %d groups, want 2: %v", len(groups), msgContents(flatten(groups)))
	}
	if len(groups[0]) != 3 || groups[0][2].Content != "q2" {
		t.Errorf("group 0 = %v, want [q1 a1 q2]", msgContents(groups[0]))
	}
	if len(groups[1]) != 2 || groups[1][0].Content != "a2" {
		t.Errorf("group 1 = %v, want [a2 q3]", msgContents(groups[1]))
	}
}

func flatten(groups [][]conversation.Message) []conversation.Message {
	var out []conversation.Message
	for _, g := range groups {
		out = append(out, g...)
	}
	return out
}

// buildPrefixText must keep tool-call arguments (JSON) and full tool results
// (TS compact.ts:467-482) — no truncation, no dropped arguments.
func TestBuildPrefixTextKeepsArgsAndFullResults(t *testing.T) {
	long := strings.Repeat("r", 600)
	msgs := []conversation.Message{
		{
			Role:     "assistant",
			Content:  "calling",
			ToolUses: []conversation.ToolUseBlock{{ToolUseID: "tu-1", ToolName: "ReadFile", Arguments: map[string]any{"path": "/x"}}},
		},
		{
			Role:        "user",
			ToolResults: []conversation.ToolResultBlock{{ToolUseID: "tu-1", Content: long, IsError: true}},
		},
	}
	text := buildPrefixText(msgs)
	if !strings.Contains(text, `tu-1 ReadFile {"path":"/x"}`) {
		t.Errorf("tool arguments missing from serialized prefix:\n%s", text)
	}
	if !strings.Contains(text, "tu-1 (error): "+long) {
		t.Errorf("full tool result missing from serialized prefix (truncated?)")
	}
}

// EstimateTokens must count image content blocks as the fixed imageCharEquiv
// (TS compact.ts:123,140-201,205-231).
func TestEstimateTokensImageBlocks(t *testing.T) {
	msgs := []conversation.Message{{
		Role: "user",
		ToolResults: []conversation.ToolResultBlock{{
			ToolUseID:     "tu-1",
			Content:       "[Image]",
			ContentBlocks: []map[string]any{{"type": "image", "source": map[string]any{"type": "base64", "data": "AAAA"}}},
		}},
	}}
	// max(len("[Image]"), 0 text chars) + 7000 rich chars = 7007 chars →
	// ceil(7007 / 3.5) = 2002 tokens.
	if got := EstimateTokens(msgs); got != 2002 {
		t.Errorf("EstimateTokens with image block = %d, want 2002", got)
	}
}

// ManageContext must surface the circuit-breaker message instead of failing
// silently (TS compact.ts:355-363).
func TestManageContextCircuitBreakerMessage(t *testing.T) {
	conv := conversation.NewManager()
	conv.AddUserMessage("hi")
	client := &stubSummaryClient{summary: "S"}
	tracking := &AutoCompactTrackingState{ConsecutiveFailures: MaxConsecutiveAutoCompactFailures}
	// contextWindow=10000, maxOutput=1000 → autoThreshold=-4000 (always over),
	// hardBlock=6000 (tiny conversation stays under it → not forced).
	result := ManageContext(context.Background(), conv, client, "", "", 10000, 1000, tracking, nil, nil, nil)
	if result.Compacted {
		t.Fatalf("circuit breaker must not compact")
	}
	if want := "Auto-compact circuit breaker: 3 consecutive failures"; result.Message != want {
		t.Errorf("got %q, want %q", result.Message, want)
	}
	if client.streamCalled {
		t.Errorf("summarizer must not be called while the circuit breaker is open")
	}
}

// autoCompact must skip compaction when fewer than minCompactPrefix messages
// would be summarized (TS compact.ts:82,623-628).
func TestAutoCompactSkipsTinyPrefix(t *testing.T) {
	conv := conversation.NewManager()
	// First message alone exceeds keepMaxTokens, so the keep-walk stops at
	// index 1 → only 1 message would be summarized → below MIN_COMPACT_PREFIX.
	conv.AddUserMessage(bigMsg(50000))
	conv.AddAssistantMessage("short reply")
	conv.AddUserMessage("q")
	conv.AddAssistantMessage("a")
	before := conv.GetMessages()

	client := &stubSummaryClient{summary: "S"}
	result, err := autoCompact(context.Background(), conv, client, "", "", 200000, nil, nil, nil, "")
	if err != nil {
		t.Fatalf("autoCompact error: %v", err)
	}
	// TS reports the skip instead of returning nothing, so the caller can
	// surface a compact event (compact.ts:623-628).
	if want := "Compaction skipped: only 1 message(s) to summarize, kept verbatim"; result.Message != want {
		t.Errorf("got %q, want %q", result.Message, want)
	}
	if result.Compacted {
		t.Errorf("tiny-prefix skip must not report a compaction")
	}
	if client.streamCalled {
		t.Errorf("summarizer must not be called for a prefix below MIN_COMPACT_PREFIX")
	}
	if len(conv.GetMessages()) != len(before) {
		t.Errorf("conversation must be untouched when compaction is skipped")
	}
}

// mutatingStubClient appends a message to the live conversation during the
// summary stream, simulating a concurrent turn landing mid-compaction.
type mutatingStubClient struct {
	*stubSummaryClient
	live *conversation.Manager
}

func (c *mutatingStubClient) Stream(ctx context.Context, conv *conversation.Manager, tools []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	c.live.AddUserMessage("concurrent mutation")
	return c.stubSummaryClient.Stream(ctx, conv, tools)
}

// autoCompact must abort (keeping the current history) when the conversation
// changed while the summary was in flight (TS compact.ts:656-667).
func TestAutoCompactAbortsWhenConversationChanged(t *testing.T) {
	conv := conversation.NewManager()
	for range 6 {
		conv.AddUserMessage("OLD " + bigMsg(3000))
		conv.AddAssistantMessage("REPLY " + bigMsg(3000))
	}
	conv.AddUserMessage("RECENT-A")
	conv.AddAssistantMessage("RECENT-B")
	before := conv.GetMessages()

	client := &mutatingStubClient{stubSummaryClient: &stubSummaryClient{summary: "S"}, live: conv}
	if _, err := autoCompact(context.Background(), conv, client, "", "", 200000, nil, nil, nil, ""); err == nil ||
		!strings.Contains(err.Error(), "Conversation changed during compaction") {
		t.Fatalf("expected conversation-changed error, got %v", err)
	}
	// The history must NOT have been replaced by summary+keep: the original
	// messages are all still there (plus the one concurrent append).
	after := conv.GetMessages()
	if len(after) != len(before)+1 {
		t.Fatalf("conversation was rewritten despite the guard: before=%d after=%d", len(before), len(after))
	}
	for i := range before {
		if before[i].Content != after[i].Content {
			t.Errorf("message %d was replaced despite the conversation-changed guard", i)
		}
	}
}
