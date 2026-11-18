package conversation

import "testing"

func assistantWithTool(id, name string) Message {
	return Message{
		Role:     "assistant",
		Content:  "let me check",
		ToolUses: []ToolUseBlock{{ToolUseID: id, ToolName: name}},
	}
}

func resultFor(id, content string) Message {
	return Message{
		Role:        "user",
		ToolResults: []ToolResultBlock{{ToolUseID: id, Content: content}},
	}
}

func TestEnsureToolPairingLeavesPairedHistoryAlone(t *testing.T) {
	in := []Message{
		{Role: "user", Content: "hi"},
		assistantWithTool("t1", "ReadFile"),
		resultFor("t1", "content"),
	}
	got := EnsureToolPairing(in)
	if len(got) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(got))
	}
	if got[2].ToolResults[0].Content != "content" {
		t.Errorf("existing result was modified: %+v", got[2])
	}
}

func TestEnsureToolPairingFillsDanglingToolUse(t *testing.T) {
	in := []Message{
		{Role: "user", Content: "hi"},
		assistantWithTool("t1", "Bash"),
	}
	got := EnsureToolPairing(in)
	if len(got) != 3 {
		t.Fatalf("expected a synthetic result appended, got %d messages", len(got))
	}
	filled := got[2]
	if filled.Role != "user" || len(filled.ToolResults) != 1 {
		t.Fatalf("unexpected synthetic message: %+v", filled)
	}
	if filled.ToolResults[0].ToolUseID != "t1" {
		t.Errorf("pairing id = %q, want t1", filled.ToolResults[0].ToolUseID)
	}
	if !filled.ToolResults[0].IsError {
		t.Error("synthetic result should be marked as an error")
	}
	if filled.ToolResults[0].Content != InterruptedToolResult {
		t.Errorf("unexpected text: %q", filled.ToolResults[0].Content)
	}
}

func TestEnsureToolPairingFillsEveryToolUseInMessage(t *testing.T) {
	in := []Message{{
		Role: "assistant",
		ToolUses: []ToolUseBlock{
			{ToolUseID: "t1", ToolName: "ReadFile"},
			{ToolUseID: "t2", ToolName: "Grep"},
		},
	}}
	got := EnsureToolPairing(in)
	if len(got) != 2 {
		t.Fatalf("expected one synthetic message, got %d", len(got))
	}
	if len(got[1].ToolResults) != 2 {
		t.Fatalf("expected 2 synthetic results, got %d", len(got[1].ToolResults))
	}
}

func TestEnsureToolPairingDropsOrphanResult(t *testing.T) {
	in := []Message{
		{Role: "user", Content: "hi"},
		resultFor("ghost", "leftover"),
		{Role: "assistant", Content: "ok"},
	}
	got := EnsureToolPairing(in)
	for _, m := range got {
		for _, tr := range m.ToolResults {
			if tr.ToolUseID == "ghost" {
				t.Fatalf("orphan result survived: %+v", m)
			}
		}
	}
	if len(got) != 2 {
		t.Fatalf("expected the empty shell to be removed, got %d messages", len(got))
	}
}

func TestEnsureToolPairingDoesNotDuplicate(t *testing.T) {
	in := []Message{
		assistantWithTool("t1", "Bash"),
		{Role: "assistant", Content: "still going"},
	}
	got := EnsureToolPairing(in)
	count := 0
	for _, m := range got {
		for _, tr := range m.ToolResults {
			if tr.ToolUseID == "t1" {
				count++
			}
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one result for t1, got %d", count)
	}
}

func TestEnsureToolPairingDoesNotMutateInput(t *testing.T) {
	in := []Message{assistantWithTool("t1", "Bash")}
	_ = EnsureToolPairing(in)
	if len(in) != 1 {
		t.Fatalf("input slice was modified, len = %d", len(in))
	}
}
