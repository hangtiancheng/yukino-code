package memory

import (
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

func TestExtractWrittenPaths(t *testing.T) {
	messages := []conversation.Message{
		{Role: "assistant", ToolUses: []conversation.ToolUseBlock{
			{ToolUseID: "a", ToolName: "WriteFile", Arguments: map[string]any{"file_path": "one.md"}},
			{ToolUseID: "b", ToolName: "EditFile", Arguments: map[string]any{"file_path": "two.md"}},
			{ToolUseID: "c", ToolName: "WriteFile", Arguments: map[string]any{"file_path": "failed.md"}},
		}},
		{Role: "user", ToolResults: []conversation.ToolResultBlock{
			{ToolUseID: "a"},
			{ToolUseID: "b", IsError: true},
		}},
	}
	got := ExtractWrittenPaths(messages)
	want := []string{"one.md"}
	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("ExtractWrittenPaths = %v, want %v", got, want)
	}
}
