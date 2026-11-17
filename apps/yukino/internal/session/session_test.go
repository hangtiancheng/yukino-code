package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

func TestNewID(t *testing.T) {
	id := NewID()
	if !sessionIDRe.MatchString(id) {
		t.Fatalf("unexpected ID format: %s", id)
	}
	id2 := NewID()
	if id == id2 {
		t.Fatalf("two IDs generated in same second collided: %s", id)
	}
}

func TestSaveAndLoad(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	sid := "test-session"

	SaveMessage(dir, sid, Message{Role: "user", Content: "hello", Timestamp: 1})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "hi", Timestamp: 2})

	msgs, _ := LoadSession(dir, sid)
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
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	msgs, _ := LoadSession(dir, "nonexistent")
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(msgs))
	}
}

func TestListSessions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()

	long := strings.Repeat("x", FirstMessagePreviewChars+50)
	SaveMessage(dir, "s1", Message{Role: "user", Content: "first session", Timestamp: 100, UserInput: &conversation.UserInput{ID: "00000000-0000-0000-0000-000000000001", Timestamp: 100000}})
	SaveMessage(dir, "s2", Message{Role: "user", Content: long, Timestamp: 200, UserInput: &conversation.UserInput{ID: "00000000-0000-0000-0000-000000000002", Timestamp: 200000}})
	SaveMessage(dir, "s2", Message{Role: "assistant", Content: "reply", Timestamp: 300})
	SaveMessage(dir, "s3", Message{Role: "assistant", Content: "no user input", Timestamp: 400})

	sessions := ListSessions(dir)
	if len(sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(sessions))
	}
	// Newest user input first; sessions without user messages sort last.
	if sessions[0].ID != "s2" || sessions[1].ID != "s1" || sessions[2].ID != "s3" {
		t.Fatalf("unexpected order: %s %s %s", sessions[0].ID, sessions[1].ID, sessions[2].ID)
	}
	if sessions[0].MessageCount != 2 {
		t.Fatalf("expected 2 messages in s2, got %d", sessions[0].MessageCount)
	}
	if got := len([]rune(sessions[0].FirstMessage)); got != FirstMessagePreviewChars {
		t.Fatalf("expected preview truncated to %d chars, got %d", FirstMessagePreviewChars, got)
	}
	if sessions[0].LastUserMessageTime == nil || sessions[0].LastUserMessageTime.Unix() != 200 {
		t.Fatalf("expected last user message time 200, got %v", sessions[0].LastUserMessageTime)
	}
	if sessions[2].LastUserMessageTime != nil {
		t.Fatalf("expected nil last user message time, got %v", sessions[2].LastUserMessageTime)
	}
}

func TestFileCreated(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	SaveMessage(dir, "test", Message{Role: "user", Content: "hi", Timestamp: 1})

	path := SessionFilePath(dir, "test")
	if path == "" {
		t.Fatal("no session file path")
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("session file was not created")
	}
}

func TestFindLastCompactBoundary_RebuildsCompactedState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	sid := "compacted-session"

	SaveMessage(dir, sid, Message{Role: "user", Content: "ORIGINAL-PREFIX-1", Timestamp: 1})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "ORIGINAL-PREFIX-2", Timestamp: 2})
	SaveMessage(dir, sid, Message{Role: "user", Content: "ORIGINAL-PREFIX-3", Timestamp: 3})

	keep := []KeepMessage{
		{Role: "user", Content: "KEPT-TAIL-USER"},
		{Role: "assistant", Content: "KEPT-TAIL-ASSISTANT"},
	}
	SaveCompactBoundary(dir, sid, "THE-SUMMARY", keep)

	SaveMessage(dir, sid, Message{Role: "user", Content: "AFTER-BOUNDARY-USER", Timestamp: 5})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "AFTER-BOUNDARY-ASSISTANT", Timestamp: 6})

	msgs, _ := LoadSession(dir, sid)

	boundary, after, ok := FindLastCompactBoundary(msgs)
	if !ok {
		t.Fatalf("expected a compact boundary to be found")
	}
	if boundary.Summary != "THE-SUMMARY" {
		t.Fatalf("summary mismatch: got %q", boundary.Summary)
	}
	if len(boundary.Keep) != 2 ||
		boundary.Keep[0].Role != "user" || boundary.Keep[0].Content != "KEPT-TAIL-USER" ||
		boundary.Keep[1].Role != "assistant" || boundary.Keep[1].Content != "KEPT-TAIL-ASSISTANT" {
		t.Fatalf("kept tail not round-tripped: %+v", boundary.Keep)
	}
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

func TestFindLastCompactBoundary_UsesLastBoundary(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	sid := "twice-compacted"

	SaveMessage(dir, sid, Message{Role: "user", Content: "GEN0", Timestamp: 1})
	SaveCompactBoundary(dir, sid, "SUMMARY-1", []KeepMessage{{Role: "user", Content: "KEEP-1"}})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "BETWEEN-BOUNDARIES", Timestamp: 3})
	SaveCompactBoundary(dir, sid, "SUMMARY-2", []KeepMessage{{Role: "assistant", Content: "KEEP-2"}})
	SaveMessage(dir, sid, Message{Role: "user", Content: "NEWEST", Timestamp: 5})

	msgs, _ := LoadSession(dir, sid)
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

func TestFindLastCompactBoundary_NoBoundaryFullReplay(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	sid := "legacy-session"

	SaveMessage(dir, sid, Message{Role: "user", Content: "hello", Timestamp: 1})
	SaveMessage(dir, sid, Message{Role: "assistant", Content: "hi", Timestamp: 2})
	SaveMessage(dir, sid, Message{Role: "user", Content: "again", Timestamp: 3})

	msgs, _ := LoadSession(dir, sid)
	_, _, ok := FindLastCompactBoundary(msgs)
	if ok {
		t.Fatalf("legacy session must report no boundary so caller does a full replay")
	}
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages preserved for full replay, got %d", len(msgs))
	}
}

func TestToolBlocksRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	id := "tools"

	assistant := conversation.Message{
		Role:    "assistant",
		Content: "take a look at this file first",
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

	loaded, _ := LoadSession(dir, id)
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

func TestLoadKeepsEmptyContentToolResult(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	id := "empty-content"

	SaveMessage(dir, id, Message{
		Role:        "user",
		ToolResults: []ToolResultRecord{{ToolUseID: "toolu_9", Content: "ok"}},
	})

	loaded, _ := LoadSession(dir, id)
	if len(loaded) != 1 {
		t.Fatalf("tool-result-only record was dropped, got %d records", len(loaded))
	}
}

func TestLoadRejectsLegacyTimestampRecords(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	id := "legacy"
	path := SessionFilePath(dir, id)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{"role":"user","content":"hi","ts":1}
{"role":"assistant","content":"hello","ts":2}
`
	if err := os.WriteFile(path, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, _ := LoadSession(dir, id)
	if len(loaded) != 0 {
		t.Fatalf("obsolete timestamp records must be rejected, got %+v", loaded)
	}
}

func TestSaveTranscriptCompactBoundary(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	transcript := filepath.Join(dir, "custom-transcript.jsonl")

	if err := SaveTranscriptMessage(transcript, Message{Role: "user", Content: "ORIGINAL", Timestamp: 1}); err != nil {
		t.Fatal(err)
	}
	keep := []KeepMessage{{Role: "user", Content: "KEPT-TAIL"}}
	if err := SaveTranscriptCompactBoundary(transcript, "TRANSCRIPT-SUMMARY", keep); err != nil {
		t.Fatal(err)
	}

	msgs, _ := LoadTranscript(transcript)
	boundary, after, ok := FindLastCompactBoundary(msgs)
	if !ok {
		t.Fatal("expected a compact boundary in the custom transcript")
	}
	if boundary.Summary != "TRANSCRIPT-SUMMARY" || len(boundary.Keep) != 1 || boundary.Keep[0].Content != "KEPT-TAIL" {
		t.Fatalf("boundary = %#v", boundary)
	}
	if len(after) != 0 {
		t.Fatalf("expected no after-boundary messages, got %d", len(after))
	}
}
