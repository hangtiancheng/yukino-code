package compact

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
)

type stubSummaryClient struct {
	summary    string
	lastPrompt string
	stopReason string
	toolCall   bool
	failErr    error
}

func (c *stubSummaryClient) SetSystemPrompt(prompt string) {}

func (c *stubSummaryClient) Stream(ctx context.Context, conv *conversation.Manager, tools []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	if msgs := conv.GetMessages(); len(msgs) > 0 {
		c.lastPrompt = msgs[len(msgs)-1].Content
	}
	ch := make(chan llm.StreamEvent, 4)
	errCh := make(chan error, 1)
	if c.failErr != nil {
		close(ch)
		errCh <- c.failErr
		close(errCh)
		return ch, errCh
	}
	if c.toolCall {
		ch <- llm.ToolCallStart{ToolName: "Bash", ToolID: "t1"}
	}
	text := c.summary
	if text == "" {
		text = "<summary>THE SUMMARY</summary>"
	}
	ch <- llm.TextDelta{Text: text}
	stop := c.stopReason
	if stop == "" {
		stop = "end_turn"
	}
	ch <- llm.StreamEnd{StopReason: stop}
	close(ch)
	errCh <- nil
	close(errCh)
	return ch, errCh
}

// Expected values verified against the reference formatCompactSummary
// semantics (regex-based extraction).
func TestFormatCompactSummary(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"both blocks", "<analysis>scratch thoughts</analysis>\n<summary>final text</summary>", "final text"},
		{"summary unterminated, analysis present", "<analysis>scratch</analysis>\n<summary>tail with no close tag", "<summary>tail with no close tag"},
		{"only analysis", "prefix <analysis>scratch</analysis> suffix", "prefix  suffix"},
		{"neither", "plain text response", "plain text response"},
		{"summary only", "<summary>\n  spaced  \n</summary>", "spaced"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatCompactSummary(tc.in); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestComputeCompactThreshold(t *testing.T) {
	// Large window keeps the fixed margin.
	got, err := ComputeCompactThreshold(200000, 32000, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := 200000 - SummaryOutputReserve - AutoCompactSafetyMargin; got != want {
		t.Errorf("auto = %d, want %d", got, want)
	}
	got, err = ComputeCompactThreshold(200000, 32000, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := 200000 - SummaryOutputReserve - ManualCompactSafetyMargin; got != want {
		t.Errorf("manual = %d, want %d", got, want)
	}
	// Small window caps the margin to the ratio of the effective window.
	got, err = ComputeCompactThreshold(30000, 10000, false)
	if err != nil {
		t.Fatal(err)
	}
	effective := 30000 - 10000
	if want := effective - effective/4; got != want {
		t.Errorf("capped = %d, want %d", got, want)
	}
	// maxOutput below the reserve uses maxOutput as the reserve.
	got, _ = ComputeCompactThreshold(200000, 5000, false)
	if want := 200000 - 5000 - AutoCompactSafetyMargin; got != want {
		t.Errorf("small maxOutput = %d, want %d", got, want)
	}
	if _, err := ComputeCompactThreshold(10000, 20000, false); err == nil ||
		!strings.Contains(err.Error(), "too small to compact") {
		t.Errorf("small window err = %v", err)
	}
}

func bigMsg(tokens int) string {
	return strings.Repeat("x", tokens*4)
}

func msgContents(msgs []conversation.Message) []string {
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m.Content)
	}
	return out
}

func containsMsg(msgs []conversation.Message, want string) bool {
	for _, m := range msgs {
		if m.Content == want {
			return true
		}
	}
	return false
}

func populatedConversation() *conversation.Manager {
	conv := conversation.NewManager()
	for i := 0; i < 6; i++ {
		conv.AddUserMessage("OLD-PREFIX " + bigMsg(3000))
		conv.AddAssistantMessage("OLD-REPLY " + bigMsg(3000))
	}
	conv.AddUserMessage("RECENT-A unique-marker-A")
	conv.AddAssistantMessage("RECENT-B unique-marker-B")
	return conv
}

func TestDoCompactKeepsRecentVerbatim(t *testing.T) {
	conv := populatedConversation()
	client := &stubSummaryClient{summary: "THE SUMMARY"}
	result, err := doCompact(context.Background(), conv, client, nil, nil, nil, "", "")
	if err != nil {
		t.Fatalf("doCompact error: %v", err)
	}
	if !result.Compacted {
		t.Fatalf("result = %+v", result)
	}
	// The keep-walk retains at least MinKeepMessages recent messages.
	if !strings.Contains(result.Message, "Compacted 9 messages into summary (11 chars), kept 5 recent messages verbatim") {
		t.Errorf("message = %q", result.Message)
	}
	out := conv.GetMessages()
	var sawSummary bool
	for _, m := range out {
		if strings.Contains(m.Content, "THE SUMMARY") {
			sawSummary = true
		}
	}
	if !sawSummary {
		t.Errorf("summary not present after compaction")
	}
	for _, r := range []string{"RECENT-A unique-marker-A", "RECENT-B unique-marker-B"} {
		if !containsMsg(out, r) {
			t.Errorf("recent message %q not preserved; messages=%v", r, msgContents(out))
		}
	}
	if result.Boundary == nil || !strings.Contains(result.Boundary.Summary, "THE SUMMARY") {
		t.Errorf("boundary = %+v", result.Boundary)
	}
	if len(result.Boundary.Keep) != 5 {
		t.Errorf("boundary keep = %d records", len(result.Boundary.Keep))
	}
}

func TestDoCompactSkipsTinyPrefix(t *testing.T) {
	conv := conversation.NewManager()
	conv.AddUserMessage("only one message")
	client := &stubSummaryClient{}
	result, err := doCompact(context.Background(), conv, client, nil, nil, nil, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Compacted || !strings.Contains(result.Message, "Compaction skipped: only 0 message(s) to summarize") {
		t.Errorf("result = %+v", result)
	}
}

func TestDoCompactSessionFilePathHint(t *testing.T) {
	conv := populatedConversation()
	client := &stubSummaryClient{summary: "SUM"}
	result, err := doCompact(context.Background(), conv, client, nil, nil, nil, "/path/session.jsonl", "")
	if err != nil {
		t.Fatal(err)
	}
	msgs := conv.GetMessages()
	if !strings.Contains(msgs[0].Content, "use ReadFile to read the full session transcript: /path/session.jsonl") {
		t.Errorf("transcript hint missing: %q", msgs[0].Content)
	}
	if !strings.Contains(result.Boundary.Summary, "/path/session.jsonl") {
		t.Errorf("boundary summary must keep the transcript hint: %q", result.Boundary.Summary)
	}
	if strings.Contains(result.Boundary.Summary, "Recently read files") {
		t.Error("boundary summary must exclude the recovery attachment")
	}
}

func TestDoCompactRecoveryAttachment(t *testing.T) {
	conv := populatedConversation()
	client := &stubSummaryClient{summary: "SUM"}
	recovery := NewRecoveryState()
	recovery.RecordFileRead("/tmp/x.go", "package x")
	result, err := doCompact(context.Background(), conv, client, recovery, []string{"Bash"}, nil, "", "")
	if err != nil {
		t.Fatal(err)
	}
	msgs := conv.GetMessages()
	if !strings.Contains(msgs[0].Content, RecoveryAttachmentDivider) ||
		!strings.Contains(msgs[0].Content, "## Recently read files") ||
		!strings.Contains(msgs[0].Content, "- Bash") {
		t.Errorf("recovery attachment missing: %q", msgs[0].Content)
	}
	if strings.Contains(result.Boundary.Summary, "Recently read files") {
		t.Error("boundary must exclude the recovery attachment")
	}
}

func TestDoCompactConversationChanged(t *testing.T) {
	conv := populatedConversation()
	// Mutate the conversation mid-flight by wrapping the client.
	mutating := &mutatingClient{stubSummaryClient: &stubSummaryClient{summary: "SUM"}, conv: conv}
	_, err := doCompact(context.Background(), conv, mutating, nil, nil, nil, "", "")
	if err == nil || err.Error() != CompactionConversationChangedError {
		t.Errorf("err = %v", err)
	}
}

type mutatingClient struct {
	*stubSummaryClient
	conv *conversation.Manager
}

func (c *mutatingClient) Stream(ctx context.Context, conv *conversation.Manager, tools []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	c.conv.AddUserMessage("injected during compaction")
	return c.stubSummaryClient.Stream(ctx, conv, tools)
}

func TestCollectSummaryValidation(t *testing.T) {
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")

	toolClient := &stubSummaryClient{toolCall: true}
	if _, err := collectSummaryAttempt(context.Background(), toolClient, conv, nil); err == nil ||
		err.Error() != CompactionToolCallError {
		t.Errorf("tool call err = %v", err)
	}

	stopClient := &stubSummaryClient{stopReason: "max_tokens"}
	if _, err := collectSummaryAttempt(context.Background(), stopClient, conv, nil); err == nil ||
		!strings.Contains(err.Error(), "did not finish: max_tokens") {
		t.Errorf("stop reason err = %v", err)
	}

	emptyClient := &stubSummaryClient{summary: "<summary></summary>"}
	if _, err := collectSummaryAttempt(context.Background(), emptyClient, conv, nil); err == nil ||
		err.Error() != CompactionEmptySummaryError {
		t.Errorf("empty summary err = %v", err)
	}

	unterminated := &stubSummaryClient{summary: "<summary>no close"}
	if _, err := collectSummaryAttempt(context.Background(), unterminated, conv, nil); err == nil ||
		err.Error() != CompactionEmptySummaryError {
		t.Errorf("unterminated err = %v", err)
	}
}

func TestManageContextCircuitBreakerAndSkip(t *testing.T) {
	// populatedConversation estimates ~41.2k tokens; with contextWindow
	// 60000 / maxOutput 10000 the effective window is 50000 and the
	// thresholds land at auto=37500 and hard=47000, so the run sits between
	// them (not forced).
	conv := populatedConversation()
	tracking := &AutoCompactTrackingState{ConsecutiveFailures: MaxConsecutiveFailures}
	result, err := ManageContext(context.Background(), conv, &stubSummaryClient{}, 60000, 10000, tracking, nil, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Compacted || !strings.Contains(result.Message, "Auto-compact circuit breaker: 3 consecutive failures") {
		t.Errorf("circuit breaker result = %+v", result)
	}

	// Below the threshold: no message.
	small := conversation.NewManager()
	small.AddUserMessage("tiny")
	result, err = ManageContext(context.Background(), small, &stubSummaryClient{}, 200000, 32000, nil, nil, nil, nil, "")
	if err != nil || result.Compacted || result.Message != "" {
		t.Errorf("below-threshold result = %+v err=%v", result, err)
	}

	// Failure increments the breaker and reports the failure message.
	tracking = &AutoCompactTrackingState{}
	failing := &stubSummaryClient{failErr: errors.New("boom")}
	result, err = ManageContext(context.Background(), conv, failing, 60000, 10000, tracking, nil, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Message, "Auto-compact failed: boom") || tracking.ConsecutiveFailures != 1 {
		t.Errorf("failure result = %+v failures = %d", result, tracking.ConsecutiveFailures)
	}
}

func TestComputeKeepStartIndex(t *testing.T) {
	var msgs []conversation.Message
	for i := 0; i < 6; i++ {
		msgs = append(msgs, conversation.Message{Role: "user", Content: bigMsg(3000)})
		msgs = append(msgs, conversation.Message{Role: "assistant", Content: bigMsg(3000)})
	}
	msgs = append(msgs,
		conversation.Message{Role: "user", Content: "recent-a"},
		conversation.Message{Role: "assistant", Content: "recent-b"},
	)
	keepStart := ComputeKeepStartIndex(msgs)
	if keepStart <= 0 || keepStart >= len(msgs) {
		t.Fatalf("keepStart = %d", keepStart)
	}
	kept := msgs[keepStart:]
	if len(kept) < MinKeepMessages {
		t.Errorf("kept %d messages, want >= %d", len(kept), MinKeepMessages)
	}
	if kept[len(kept)-1].Content != "recent-b" {
		t.Error("tail must reach the last message")
	}
}

func TestBackUpPastToolUse(t *testing.T) {
	msgs := []conversation.Message{
		{Role: "user", Content: "old"},
		{Role: "assistant", Content: "", ToolUses: []conversation.ToolUseBlock{{ToolUseID: "t1", ToolName: "Bash"}}},
		{Role: "user", Content: "", ToolResults: []conversation.ToolResultBlock{{ToolUseID: "t1", Content: "ok"}}},
		{Role: "assistant", Content: "done"},
	}
	// Boundary lands on the tool_result user message; must back up to the
	// assistant message carrying the matching tool_use.
	if got := backUpPastToolUse(msgs, 2); got != 1 {
		t.Errorf("backUp = %d, want 1", got)
	}
	// Clean boundary stays put.
	if got := backUpPastToolUse(msgs, 3); got != 3 {
		t.Errorf("clean boundary = %d, want 3", got)
	}
}

func TestGroupMessagesByAPIRound(t *testing.T) {
	msgs := []conversation.Message{
		{Role: "user", Content: "a"},
		{Role: "assistant", Content: "b"},
		{Role: "user", Content: "c"},
		{Role: "assistant", Content: "d"},
		{Role: "user", Content: "e"},
	}
	groups := groupMessagesByAPIRound(msgs)
	// Each new assistant reply starts a new group: [a,b,c] then [d,e].
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(groups))
	}
	if len(groups[0]) != 3 || len(groups[1]) != 2 {
		t.Errorf("group sizes = %d %d", len(groups[0]), len(groups[1]))
	}
}

func TestTruncateHeadForPTL(t *testing.T) {
	var prefix []conversation.Message
	for i := 0; i < 10; i++ {
		prefix = append(prefix, conversation.Message{Role: "user", Content: bigMsg(100)})
		prefix = append(prefix, conversation.Message{Role: "assistant", Content: bigMsg(100)})
	}
	truncated := truncateHeadForPTL(prefix, 0)
	if truncated == nil {
		t.Fatal("expected truncation")
	}
	if len(truncated) >= len(prefix) {
		t.Errorf("truncated %d >= original %d", len(truncated), len(prefix))
	}
	if truncated[0].Role != "user" {
		t.Errorf("first message role = %s, want user (PTL marker)", truncated[0].Role)
	}
	if truncated[0].Content != PTLRetryMarker {
		t.Errorf("marker = %q", truncated[0].Content)
	}
	// Single group cannot be truncated.
	if got := truncateHeadForPTL(prefix[:2], 10); got != nil {
		t.Errorf("single group must return nil, got %v", got)
	}
}

func TestSerializePrefixText(t *testing.T) {
	msgs := []conversation.Message{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "calling", ToolUses: []conversation.ToolUseBlock{{ToolUseID: "t1", ToolName: "Bash", Arguments: map[string]any{"command": "ls"}}}},
		{Role: "user", Content: "", ToolResults: []conversation.ToolResultBlock{{ToolUseID: "t1", Content: "file.txt", IsError: true}}},
	}
	text := serializePrefixText(msgs)
	for _, want := range []string{
		"[user]: hello",
		"[assistant]: calling\n[tool calls]\nt1 Bash {\"command\":\"ls\"}",
		"[tool results]\nt1 (error): file.txt",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
}

func TestEstimateMessages(t *testing.T) {
	msgs := []conversation.Message{
		{Role: "user", Content: strings.Repeat("x", 350)},
		{Role: "assistant", Content: "", ToolUses: []conversation.ToolUseBlock{{ToolUseID: "t", ToolName: "Bash", Arguments: map[string]any{}}}},
		{Role: "user", Content: "", ToolResults: []conversation.ToolResultBlock{{ToolUseID: "t", Content: strings.Repeat("y", 350)}}},
		{Role: "assistant", Content: "", ThinkingBlocks: []conversation.ThinkingBlock{{Type: "thinking", Thinking: strings.Repeat("z", 350)}}},
	}
	if got := EstimateMessages(msgs); got < 300 {
		t.Errorf("estimate = %d", got)
	}
	if got := EstimateMessages(nil); got != 0 {
		t.Errorf("empty estimate = %d", got)
	}
}
