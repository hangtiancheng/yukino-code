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

package session

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
)

func TestNewID(t *testing.T) {
	id := NewID()
	// TS shape: base36 millisecond clock + "-" + 8 hex chars (TS: newSessionId).
	parts := strings.SplitN(id, "-", 2)
	if len(parts) != 2 || parts[0] == "" || len(parts[1]) != 8 {
		t.Fatalf("unexpected ID format: %s", id)
	}
	if _, err := strconv.ParseInt(parts[0], 36, 64); err != nil {
		t.Fatalf("timestamp prefix is not base36: %s", id)
	}
	if _, err := hex.DecodeString(parts[1]); err != nil {
		t.Fatalf("random suffix is not hex: %s", id)
	}
	// Two IDs generated within the same millisecond must not be equal.
	id2 := NewID()
	if id == id2 {
		t.Fatalf("two IDs generated in the same millisecond collided: %s", id)
	}
}

func TestSaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	sid := "test-session"

	SaveMessage(dir, sid, Message{Role: "user", Content: "hello", Ts: 1})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "hi", Ts: 2})

	msgs := LoadSession(dir, sid)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].Role != "user" || msgs[0].Content != "hello" {
		t.Fatalf("unexpected first message: %+v", msgs[0])
	}
	if msgs[1].Role != "assistant" || msgs[1].Content != "hi" {
		t.Fatalf("unexpected second message: %+v", msgs[1])
	}
}

func TestLoadEmpty(t *testing.T) {
	dir := t.TempDir()
	msgs := LoadSession(dir, "nonexistent")
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(msgs))
	}
}

func TestListSessions(t *testing.T) {
	dir := t.TempDir()

	SaveMessage(dir, "s1", Message{Role: "user", Content: "first session", Ts: 1})
	SaveMessage(dir, "s2", Message{Role: "user", Content: "second session", Ts: 2})
	SaveMessage(dir, "s2", Message{Role: "assistant", Content: "reply", Ts: 3})

	sessions := ListSessions(dir)
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(sessions))
	}

	found := map[string]bool{}
	for _, s := range sessions {
		found[s.ID] = true
		if s.ID == "s2" && s.MessageCount != 2 {
			t.Fatalf("expected 2 messages in s2, got %d", s.MessageCount)
		}
	}
	if !found["s1"] || !found["s2"] {
		t.Fatalf("missing sessions: %v", sessions)
	}
}

func TestFileCreated(t *testing.T) {
	dir := t.TempDir()
	SaveMessage(dir, "test", Message{Role: "user", Content: "hi", Ts: 1})

	path := filepath.Join(dir, ".yukino", "sessions", "test.jsonl")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("session file was not created")
	}
}

// A session that contains a compact_boundary must rebuild to the COMPACTED
// state on resume: the boundary's summary + the inlined kept tail + any plain
// messages appended after the boundary — while the original pre-compaction
// prefix written before the boundary is NOT replayed.
func TestFindLastCompactBoundary_RebuildsCompactedState(t *testing.T) {
	dir := t.TempDir()
	sid := "compacted-session"

	// Original pre-compaction prefix (must NOT be replayed after the boundary).
	SaveMessage(dir, sid, Message{Role: "user", Content: "ORIGINAL-PREFIX-1", Ts: 1})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "ORIGINAL-PREFIX-2", Ts: 2})
	SaveMessage(dir, sid, Message{Role: "user", Content: "ORIGINAL-PREFIX-3", Ts: 3})

	// Compaction fires: write a boundary inlining the summary + kept tail.
	keep := []KeepMessage{
		{Role: "user", Content: "KEPT-TAIL-USER"},
		{Role: "assistant", Content: "KEPT-TAIL-ASSISTANT"},
	}
	SaveCompactBoundary(dir, sid, "THE-SUMMARY", keep)

	// Continuation after the boundary (must be replayed).
	SaveMessage(dir, sid, Message{Role: "user", Content: "AFTER-BOUNDARY-USER", Ts: 5})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "AFTER-BOUNDARY-ASSISTANT", Ts: 6})

	msgs := LoadSession(dir, sid)

	boundary, after, ok := FindLastCompactBoundary(msgs)
	if !ok {
		t.Fatalf("expected a compact boundary to be found")
	}
	if boundary.Summary != "THE-SUMMARY" {
		t.Fatalf("summary mismatch: got %q", boundary.Summary)
	}
	// Kept tail (boundary-inlined) must round-trip with original role + content.
	if len(boundary.Keep) != 2 ||
		boundary.Keep[0].Role != "user" || boundary.Keep[0].Content != "KEPT-TAIL-USER" ||
		boundary.Keep[1].Role != "assistant" || boundary.Keep[1].Content != "KEPT-TAIL-ASSISTANT" {
		t.Fatalf("kept tail not round-tripped: %+v", boundary.Keep)
	}
	// After-boundary messages present and in order; original prefix absent.
	if len(after) != 2 {
		t.Fatalf("expected 2 after-boundary messages, got %d: %+v", len(after), after)
	}
	if after[0].Content != "AFTER-BOUNDARY-USER" || after[1].Content != "AFTER-BOUNDARY-ASSISTANT" {
		t.Fatalf("after-boundary content mismatch: %+v", after)
	}
	for _, m := range after {
		if strings.Contains(m.Content, "ORIGINAL-PREFIX") {
			t.Fatalf("original pre-compaction prefix must not appear after the boundary: %q", m.Content)
		}
	}

	// Simulate the resume rebuild the TUI performs and assert the final
	// reconstructed conversation: [summary] + keep + after, with no original
	// prefix.
	var rebuilt []Message
	rebuilt = append(rebuilt, Message{Role: "user", Content: boundary.Summary})
	for _, k := range boundary.Keep {
		rebuilt = append(rebuilt, Message{Role: k.Role, Content: k.Content})
	}
	rebuilt = append(rebuilt, after...)

	wantOrder := []string{
		"THE-SUMMARY", "KEPT-TAIL-USER", "KEPT-TAIL-ASSISTANT",
		"AFTER-BOUNDARY-USER", "AFTER-BOUNDARY-ASSISTANT",
	}
	if len(rebuilt) != len(wantOrder) {
		t.Fatalf("rebuilt length %d != expected %d: %+v", len(rebuilt), len(wantOrder), rebuilt)
	}
	for i, want := range wantOrder {
		if rebuilt[i].Content != want {
			t.Fatalf("rebuilt[%d] = %q, want %q", i, rebuilt[i].Content, want)
		}
	}
	for _, m := range rebuilt {
		if strings.Contains(m.Content, "ORIGINAL-PREFIX") {
			t.Fatalf("original prefix leaked into rebuilt conversation: %q", m.Content)
		}
	}
}

// The LAST boundary wins: a session compacted twice must rebuild from the most
// recent boundary, and messages between the two boundaries must not replay.
func TestFindLastCompactBoundary_UsesLastBoundary(t *testing.T) {
	dir := t.TempDir()
	sid := "twice-compacted"

	SaveMessage(dir, sid, Message{Role: "user", Content: "GEN0", Ts: 1})
	SaveCompactBoundary(dir, sid, "SUMMARY-1", []KeepMessage{{Role: "user", Content: "KEEP-1"}})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "BETWEEN-BOUNDARIES", Ts: 3})
	SaveCompactBoundary(dir, sid, "SUMMARY-2", []KeepMessage{{Role: "assistant", Content: "KEEP-2"}})
	SaveMessage(dir, sid, Message{Role: "user", Content: "NEWEST", Ts: 5})

	msgs := LoadSession(dir, sid)
	boundary, after, ok := FindLastCompactBoundary(msgs)
	if !ok {
		t.Fatalf("expected a boundary")
	}
	if boundary.Summary != "SUMMARY-2" {
		t.Fatalf("expected last boundary SUMMARY-2, got %q", boundary.Summary)
	}
	if len(boundary.Keep) != 1 || boundary.Keep[0].Content != "KEEP-2" {
		t.Fatalf("expected KEEP-2, got %+v", boundary.Keep)
	}
	if len(after) != 1 || after[0].Content != "NEWEST" {
		t.Fatalf("expected only NEWEST after last boundary, got %+v", after)
	}
}

// Backward compatibility: a session WITHOUT any boundary (old format) must
// report ok=false so the caller replays every message verbatim.
func TestFindLastCompactBoundary_NoBoundaryFullReplay(t *testing.T) {
	dir := t.TempDir()
	sid := "legacy-session"

	SaveMessage(dir, sid, Message{Role: "user", Content: "hello", Ts: 1})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "hi", Ts: 2})
	SaveMessage(dir, sid, Message{Role: "user", Content: "again", Ts: 3})

	msgs := LoadSession(dir, sid)
	_, _, ok := FindLastCompactBoundary(msgs)
	if ok {
		t.Fatalf("legacy session must report no boundary so caller does a full replay")
	}
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages preserved for full replay, got %d", len(msgs))
	}
}

// Tool blocks must survive a full round trip: persist → read back → restore into a conversation message.
func TestToolBlocksRoundTrip(t *testing.T) {
	dir := t.TempDir()
	id := "tools"

	assistant := conversation.Message{
		Role:    "assistant",
		Content: "Let me take a look at this file first",
		ToolUses: []conversation.ToolUseBlock{{
			ToolUseID: "toolu_1",
			ToolName:  "ReadFile",
			Arguments: map[string]any{"file_path": "main.go"},
		}},
	}
	toolResult := conversation.Message{
		Role: "user",
		ToolResults: []conversation.ToolResultBlock{{
			ToolUseID: "toolu_1",
			Content:   "package main",
		}},
	}

	SaveMessage(dir, id, FromConversation(assistant))
	SaveMessage(dir, id, FromConversation(toolResult))

	loaded := LoadSession(dir, id)
	if len(loaded) != 2 {
		t.Fatalf("expected 2 records, got %d", len(loaded))
	}

	gotAssistant := loaded[0].ToConversation()
	if len(gotAssistant.ToolUses) != 1 {
		t.Fatalf("tool_use lost, got %+v", gotAssistant)
	}
	if gotAssistant.ToolUses[0].ToolName != "ReadFile" {
		t.Errorf("tool name = %q, want ReadFile", gotAssistant.ToolUses[0].ToolName)
	}
	if gotAssistant.ToolUses[0].Arguments["file_path"] != "main.go" {
		t.Errorf("arguments lost: %+v", gotAssistant.ToolUses[0].Arguments)
	}

	gotResult := loaded[1].ToConversation()
	if len(gotResult.ToolResults) != 1 {
		t.Fatalf("tool_result lost, got %+v", gotResult)
	}
	if gotResult.ToolResults[0].ToolUseID != "toolu_1" {
		t.Errorf("pairing id = %q, want toolu_1", gotResult.ToolResults[0].ToolUseID)
	}
}

// A user message carrying image attachments persists its content blocks and
// round-trips them (TS writes content as a block array; the text fallback is
// recovered on load).
func TestUserMessageContentBlocksRoundTrip(t *testing.T) {
	dir := t.TempDir()
	id := "user-blocks"

	blocks := []map[string]any{
		{"type": "text", "text": "look at this"},
		{"type": "image", "source": map[string]any{
			"type": "base64", "media_type": "image/png", "data": "AAAA",
		}},
	}
	msg := conversation.Message{Role: "user", Content: "look at this", ContentBlocks: blocks}
	SaveMessage(dir, id, FromConversation(msg))

	loaded := LoadSession(dir, id)
	if len(loaded) != 1 {
		t.Fatalf("expected 1 record, got %d", len(loaded))
	}
	got := loaded[0].ToConversation()
	if len(got.ContentBlocks) != 2 {
		t.Fatalf("content blocks lost, got %+v", got.ContentBlocks)
	}
	if got.ContentBlocks[1]["type"] != "image" {
		t.Errorf("image block lost: %+v", got.ContentBlocks[1])
	}
	// On load the array content is flattened to a text fallback (the blocks are
	// the authoritative content); the text block plus the image placeholder.
	if got.Content != "look at this\n[Image: image/png]" {
		t.Errorf("text fallback = %q", got.Content)
	}
}

// A message carrying only tool results has no text of its own and must not be filtered out as empty content.
func TestLoadKeepsEmptyContentToolResult(t *testing.T) {
	dir := t.TempDir()
	id := "empty-content"

	SaveMessage(dir, id, Message{
		Role:        "user",
		ToolResults: []ToolResultRecord{{ToolUseID: "toolu_9", Content: "ok"}},
	})

	loaded := LoadSession(dir, id)
	if len(loaded) != 1 {
		t.Fatalf("tool-result-only record was dropped, got %d records", len(loaded))
	}
}

// Legacy session files that lack the tool fields must still load normally.
// Records missing the required `timestamp` key are rejected like the TS
// SessionMessageSchema (logged and skipped): the old Go-only `ts` field no
// longer substitutes.
func TestLoadLegacyRecordsWithoutToolFields(t *testing.T) {
	dir := t.TempDir()
	id := "legacy"
	path := SessionFilePath(dir, id)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{"role":"user","content":"hi","timestamp":1}
{"role":"assistant","content":"hello","timestamp":2}
{"role":"user","content":"legacy-ts-only","ts":3}
`
	if err := os.WriteFile(path, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded := LoadSession(dir, id)
	if len(loaded) != 2 {
		t.Fatalf("expected 2 valid records (ts-only line rejected by the TS schema), got %d", len(loaded))
	}
	if loaded[0].Content != "hi" || len(loaded[0].ToolUses) != 0 {
		t.Errorf("legacy record parsed wrong: %+v", loaded[0])
	}
	if loaded[0].Ts != 1 || loaded[1].Ts != 2 {
		t.Errorf("timestamp field not read: %+v", loaded)
	}
}

// Records violating the TS SessionMessageSchema (missing role, missing
// timestamp, wrong-typed content) are skipped — loadSession must keep every
// valid line around them instead of aborting (TS safeParse-failure branch).
func TestLoadSkipsSchemaViolations(t *testing.T) {
	dir := t.TempDir()
	id := "schema-violations"
	path := SessionFilePath(dir, id)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	lines := `{"content":"no role","timestamp":1}
{"role":"user","content":"no timestamp"}
{"role":"user","content":42,"timestamp":2}
{"role":"user","content":[1,2],"timestamp":3}
{"role":"user","content":"valid","timestamp":4,"tool_uses":[{"tool_name":"Bash"}]}
{"role":"user","content":"also valid","timestamp":5}
`
	if err := os.WriteFile(path, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded := LoadSession(dir, id)
	if len(loaded) != 1 || loaded[0].Content != "also valid" {
		t.Fatalf("expected only the fully valid record, got %+v", loaded)
	}
}

// The on-disk timestamp field must be `timestamp` (TS SessionMessageSchema),
// not the legacy Go `ts`, so the TS implementation can read Go-written sessions.
func TestSaveWritesTimestampField(t *testing.T) {
	dir := t.TempDir()
	id := "ts-field"
	SaveMessage(dir, id, Message{Role: "user", Content: "hi", Ts: 42})

	raw, err := os.ReadFile(SessionFilePath(dir, id))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"timestamp":42`) {
		t.Fatalf("disk record must carry `timestamp`: %s", raw)
	}
	if strings.Contains(string(raw), `"ts":`) {
		t.Fatalf("disk record must not carry legacy `ts`: %s", raw)
	}

	loaded := LoadSession(dir, id)
	if len(loaded) != 1 || loaded[0].Ts != 42 {
		t.Fatalf("timestamp did not round-trip: %+v", loaded)
	}
}

// TS-written lines may carry `content` as an array of content blocks. Go must
// flatten them to text and keep the line (and every line after it) instead of
// silently dropping them.
func TestLoadToleratesTSArrayContent(t *testing.T) {
	dir := t.TempDir()
	id := "array-content"
	path := SessionFilePath(dir, id)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	tsLines := `{"role":"user","content":[{"type":"text","text":"look at this"},{"type":"image","source":{"type":"base64","media_type":"image/png"}}],"timestamp":1}
{"role":"assistant","content":"plain string","timestamp":2}
`
	if err := os.WriteFile(path, []byte(tsLines), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded := LoadSession(dir, id)
	if len(loaded) != 2 {
		t.Fatalf("array-content line was dropped, got %d records: %+v", len(loaded), loaded)
	}
	if loaded[0].Content != "look at this\n[Image: image/png]" {
		t.Fatalf("array content not flattened like TS contentToText: %q", loaded[0].Content)
	}
	if loaded[1].Content != "plain string" {
		t.Fatalf("line after array-content line lost: %+v", loaded[1])
	}
}

// A single over-long line (> the old 1MB Scanner cap) must not abort the load
// and drop every message after it.
func TestLoadLongLineDoesNotTruncateRest(t *testing.T) {
	dir := t.TempDir()
	id := "long-line"
	path := SessionFilePath(dir, id)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	big := strings.Repeat("x", 2*1024*1024)
	content := `{"role":"user","content":"` + big + `","timestamp":1}
{"role":"assistant","content":"after-big","timestamp":2}
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded := LoadSession(dir, id)
	if len(loaded) != 2 {
		t.Fatalf("expected 2 records across the over-long line, got %d", len(loaded))
	}
	if len(loaded[0].Content) != len(big) {
		t.Fatalf("over-long line truncated: %d != %d", len(loaded[0].Content), len(big))
	}
	if loaded[1].Content != "after-big" {
		t.Fatalf("message after the over-long line lost: %+v", loaded[1])
	}
}

// A damaged (unparseable or empty-summary) trailing boundary must fall back to
// the last VALID boundary instead of replaying the whole compacted prefix.
func TestFindLastCompactBoundary_SkipsDamagedBoundary(t *testing.T) {
	dir := t.TempDir()
	sid := "damaged-boundary"

	SaveMessage(dir, sid, Message{Role: "user", Content: "ORIGINAL-PREFIX", Ts: 1})
	SaveCompactBoundary(dir, sid, "GOOD-SUMMARY", []KeepMessage{{Role: "user", Content: "KEPT"}})
	SaveMessage(dir, sid, Message{Role: "user", Content: "BETWEEN", Ts: 3})
	// Corrupt boundary blob (not valid JSON payload).
	SaveMessage(dir, sid, Message{Role: "system", Type: TypeCompactBoundary, Content: "{not-json", Ts: 4})
	// Valid JSON but empty summary — recovers nothing, must also be skipped.
	SaveCompactBoundary(dir, sid, "   ", nil)
	SaveMessage(dir, sid, Message{Role: "user", Content: "NEWEST", Ts: 6})

	msgs := LoadSession(dir, sid)
	boundary, after, ok := FindLastCompactBoundary(msgs)
	if !ok {
		t.Fatalf("expected fallback to the last valid boundary")
	}
	if boundary.Summary != "GOOD-SUMMARY" {
		t.Fatalf("expected GOOD-SUMMARY, got %q", boundary.Summary)
	}
	// Plain messages appended after the valid boundary replay; the damaged
	// boundary records themselves are skipped.
	if len(after) != 2 || after[0].Content != "BETWEEN" || after[1].Content != "NEWEST" {
		t.Fatalf("expected [BETWEEN NEWEST] after the valid boundary, got %+v", after)
	}
	for _, m := range after {
		if strings.Contains(m.Content, "ORIGINAL-PREFIX") {
			t.Fatalf("compacted prefix leaked into replay: %q", m.Content)
		}
	}
}

// When EVERY boundary is damaged there is nothing to rebuild from; the caller
// must fall back to a full replay (ok=false).
func TestFindLastCompactBoundary_AllDamagedFullReplay(t *testing.T) {
	dir := t.TempDir()
	sid := "all-damaged"

	SaveMessage(dir, sid, Message{Role: "user", Content: "hello", Ts: 1})
	SaveMessage(dir, sid, Message{Role: "system", Type: TypeCompactBoundary, Content: "{not-json", Ts: 2})

	msgs := LoadSession(dir, sid)
	if _, _, ok := FindLastCompactBoundary(msgs); ok {
		t.Fatalf("no valid boundary exists; must report ok=false for full replay")
	}
}

// listSessions must label a session by its first NON-EMPTY user message,
// truncated to 100 characters (TS listSessions).
func TestListSessionsFirstMessageTruncated(t *testing.T) {
	dir := t.TempDir()

	long := strings.Repeat("a", 150)
	// s1: first user message overlong → truncated to 100.
	SaveMessage(dir, "s1", Message{Role: "user", Content: long, Ts: 1})
	// s2: first user message has tool results but empty text → skipped; the
	// next non-empty user message labels the session.
	SaveMessage(dir, "s2", Message{Role: "user", ToolResults: []ToolResultRecord{{ToolUseID: "t1", Content: "ok"}}, Ts: 2})
	SaveMessage(dir, "s2", Message{Role: "user", Content: "real question", Ts: 3})

	sessions := ListSessions(dir)
	byID := map[string]SessionInfo{}
	for _, s := range sessions {
		byID[s.ID] = s
	}
	if got := byID["s1"].FirstMessage; len([]rune(got)) != 100 || got != long[:100] {
		t.Fatalf("s1 firstMessage not truncated to 100 chars: len=%d", len([]rune(got)))
	}
	if got := byID["s2"].FirstMessage; got != "real question" {
		t.Fatalf("s2 must skip the empty-content user message, got %q", got)
	}
}

// provider_item_id (tool uses) and content_blocks (tool results) must survive
// the JSON round trip, and TS-style tool results whose `content` is a block
// array must load with the blocks preserved as content_blocks.
func TestToolRecordExtendedFieldsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	id := "extended-fields"

	SaveMessage(dir, id, Message{
		Role: "assistant",
		Ts:   1,
		ToolUses: []ToolUseRecord{{
			ToolUseID:      "toolu_1",
			ToolName:       "ReadFile",
			ProviderItemID: "item_abc",
		}},
	})
	blocks := []map[string]any{{"type": "text", "text": "file body"}}
	SaveMessage(dir, id, Message{
		Role: "user",
		Ts:   2,
		ToolResults: []ToolResultRecord{{
			ToolUseID:     "toolu_1",
			Content:       "file body",
			ContentBlocks: blocks,
		}},
	})

	raw, err := os.ReadFile(SessionFilePath(dir, id))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"provider_item_id":"item_abc"`) {
		t.Fatalf("provider_item_id not persisted: %s", raw)
	}
	if !strings.Contains(string(raw), `"content_blocks"`) {
		t.Fatalf("content_blocks not persisted: %s", raw)
	}

	loaded := LoadSession(dir, id)
	if len(loaded) != 2 {
		t.Fatalf("expected 2 records, got %d", len(loaded))
	}
	if loaded[0].ToolUses[0].ProviderItemID != "item_abc" {
		t.Errorf("provider_item_id lost on load: %+v", loaded[0].ToolUses[0])
	}
	if len(loaded[1].ToolResults[0].ContentBlocks) != 1 ||
		loaded[1].ToolResults[0].ContentBlocks[0]["text"] != "file body" {
		t.Errorf("content_blocks lost on load: %+v", loaded[1].ToolResults[0])
	}
	// Restoring into the conversation layer must carry the blocks too.
	conv := loaded[1].ToConversation()
	if len(conv.ToolResults) != 1 || len(conv.ToolResults[0].ContentBlocks) != 1 {
		t.Errorf("content_blocks not restored into conversation: %+v", conv.ToolResults)
	}

	// TS legacy shape: content is the block array itself, no content_blocks.
	path := SessionFilePath(dir, "ts-results")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	tsLine := `{"role":"user","content":"","timestamp":3,"tool_results":[{"tool_use_id":"toolu_2","content":[{"type":"text","text":"from ts"}]}]}
`
	if err := os.WriteFile(path, []byte(tsLine), 0o644); err != nil {
		t.Fatal(err)
	}
	tsLoaded := LoadSession(dir, "ts-results")
	if len(tsLoaded) != 1 {
		t.Fatalf("TS tool_results line dropped, got %d records", len(tsLoaded))
	}
	tr := tsLoaded[0].ToolResults[0]
	if tr.Content != "from ts" {
		t.Errorf("array content not flattened: %q", tr.Content)
	}
	if len(tr.ContentBlocks) != 1 || tr.ContentBlocks[0]["text"] != "from ts" {
		t.Errorf("legacy array content must be preserved as content_blocks: %+v", tr.ContentBlocks)
	}
}

// Session records persist like TS JSON.stringify: `<`/`>`/`&` stay literal
// (encoding/json's default HTML escaping would diverge from the TS bytes).
func TestSaveMessageNoHTMLEscaping(t *testing.T) {
	dir := t.TempDir()
	id := "escape"
	SaveMessage(dir, id, Message{Role: "user", Content: "a < b && c > d", Ts: 1})

	raw, err := os.ReadFile(SessionFilePath(dir, id))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"content":"a < b && c > d"`) {
		t.Fatalf("content must stay unescaped like JSON.stringify: %s", raw)
	}
	if strings.Contains(string(raw), `\u003c`) || strings.Contains(string(raw), `\u0026`) {
		t.Fatalf("HTML escaping detected: %s", raw)
	}
	loaded := LoadSession(dir, id)
	if len(loaded) != 1 || loaded[0].Content != "a < b && c > d" {
		t.Fatalf("round-trip lost content: %+v", loaded)
	}
}
