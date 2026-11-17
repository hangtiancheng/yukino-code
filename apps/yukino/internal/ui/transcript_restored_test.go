package ui

import (
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

// transcriptFromRestored mirrors the reference function shared by /resume and
// /rewind: user-Bash records render as cards, tool uses/results fold into
// turn_summary cards, and other messages render their text.
func TestTranscriptFromRestoredRendersUserBashAndTools(t *testing.T) {
	msgs := []conversation.Message{
		{Role: "user", UserBash: &conversation.UserBashResult{Command: "echo hi", Output: "hi", Status: "completed"}},
		{Role: "assistant", ToolUses: []conversation.ToolUseBlock{{ToolUseID: "t1", ToolName: "ReadFile", Arguments: map[string]any{"file_path": "x.txt"}}}},
		{Role: "user", ToolResults: []conversation.ToolResultBlock{{ToolUseID: "t1", Content: "file contents", IsError: false}}},
		{Role: "assistant", Content: "hello there"},
	}
	out := transcriptFromRestored(msgs)
	if len(out) != 3 {
		t.Fatalf("got %d messages, want 3 (user-bash card, tool summary, text): %#v", len(out), out)
	}
	if out[0].role != "turn_summary" || len(out[0].toolGroup) != 1 || out[0].toolGroup[0].toolName != "Bash" {
		t.Fatalf("user-bash card wrong: %#v", out[0])
	}
	if out[0].toolGroup[0].args["command"] != "echo hi" {
		t.Fatalf("user-bash command wrong: %#v", out[0].toolGroup[0].args)
	}
	if out[1].role != "turn_summary" || len(out[1].toolGroup) != 1 || out[1].toolGroup[0].toolName != "ReadFile" {
		t.Fatalf("tool summary wrong: %#v", out[1])
	}
	if !strings.Contains(out[1].toolGroup[0].output, "file contents") {
		t.Fatalf("tool output wrong: %q", out[1].toolGroup[0].output)
	}
	if out[2].role != "assistant" || out[2].content != "hello there" {
		t.Fatalf("text message wrong: %#v", out[2])
	}
}

// Restored Agent cards get live status semantics: the interruption marker means
// stopped, otherwise completed (matching the reference agentStatus).
func TestTranscriptFromRestoredAgentStatus(t *testing.T) {
	msgs := []conversation.Message{
		{Role: "assistant", ToolUses: []conversation.ToolUseBlock{{ToolUseID: "a1", ToolName: "Agent"}}},
		{Role: "user", ToolResults: []conversation.ToolResultBlock{{ToolUseID: "a1", Content: "done"}}},
		{Role: "assistant", ToolUses: []conversation.ToolUseBlock{{ToolUseID: "a2", ToolName: "Agent"}}},
		{Role: "user", ToolResults: []conversation.ToolResultBlock{{ToolUseID: "a2", Content: "work [Interrupted]"}}},
	}
	out := transcriptFromRestored(msgs)
	if len(out) != 2 {
		t.Fatalf("got %d summaries, want 2", len(out))
	}
	if out[0].toolGroup[0].status != "completed" {
		t.Fatalf("first agent status = %q, want completed", out[0].toolGroup[0].status)
	}
	if out[1].toolGroup[0].status != "stopped" {
		t.Fatalf("interrupted agent status = %q, want stopped", out[1].toolGroup[0].status)
	}
}
