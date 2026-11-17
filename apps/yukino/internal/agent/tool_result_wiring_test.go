package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/tool_result"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func findToolResultsMsg(t *testing.T, conv *conversation.Manager) conversation.Message {
	t.Helper()
	for _, m := range conv.GetMessages() {
		if len(m.ToolResults) > 0 {
			return m
		}
	}
	t.Fatal("no tool-results message in conversation")
	return conversation.Message{}
}

func mustSpillDir(t *testing.T) string {
	t.Helper()
	dir, err := tool_result.SpillDir("test-session")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestIngestSpillsSingleOversizedResult(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	big := strings.Repeat("x", 60000)
	client := &mockClient{responses: [][]llm.StreamEvent{
		{
			llm.ToolCallStart{ToolName: "BigTool", ToolID: "t1"},
			llm.ToolCallComplete{ToolID: "t1", ToolName: "BigTool", Arguments: map[string]any{}},
			llm.StreamEnd{StopReason: "tool_use"},
		},
		{
			llm.TextDelta{Text: "done"},
			llm.StreamEnd{StopReason: "end_turn"},
		},
	}}
	reg := tools.NewRegistry()
	reg.Register(&mockTool{name: "BigTool", result: big})
	ag := New(client, reg, "anthropic")
	ag.WorkDir = t.TempDir()
	ag.SetSessionID("test-session")
	conv := conversation.NewManager()

	_, events := runConversationRound(ag, conv, "go")

	msg := findToolResultsMsg(t, conv)
	got := msg.ToolResults[0].Content
	if !strings.HasPrefix(got, "<persisted-output>") {
		t.Fatalf("history content should be a preview, got %d chars: %q...", len(got), got[:40])
	}
	fi, err := os.Stat(filepath.Join(mustSpillDir(t), "t1.txt"))
	if err != nil {
		t.Fatalf("spill file missing: %v", err)
	}
	if fi.Size() != 60000 {
		t.Fatalf("spill file size = %d, want 60000", fi.Size())
	}
	trs := getToolResults(events)
	if len(trs) != 1 || len(trs[0].Output) != 60000 {
		t.Fatalf("UI event should carry raw output, got %d results", len(trs))
	}
}

func TestIngestReadbackExempt(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	ag0WorkDir := t.TempDir()
	readbackPath := filepath.Join(mustSpillDir(t), "toolu_old.txt")
	big := strings.Repeat("y", 60000)

	client := &mockClient{responses: [][]llm.StreamEvent{
		{
			llm.ToolCallStart{ToolName: "ReadFile", ToolID: "t_rb"},
			llm.ToolCallComplete{ToolID: "t_rb", ToolName: "ReadFile", Arguments: map[string]any{"file_path": readbackPath}},
			llm.StreamEnd{StopReason: "tool_use"},
		},
		{
			llm.TextDelta{Text: "done"},
			llm.StreamEnd{StopReason: "end_turn"},
		},
	}}
	reg := tools.NewRegistry()
	reg.Register(&mockTool{name: "ReadFile", result: big})
	ag := New(client, reg, "anthropic")
	ag.WorkDir = ag0WorkDir
	ag.SetSessionID("test-session")
	conv := conversation.NewManager()

	runConversationRound(ag, conv, "read it back")

	msg := findToolResultsMsg(t, conv)
	if got := msg.ToolResults[0].Content; len(got) != 60000 {
		t.Fatalf("readback should stay raw, got %d chars", len(got))
	}
	if _, err := os.Stat(filepath.Join(mustSpillDir(t), "t_rb.txt")); !os.IsNotExist(err) {
		t.Fatal("readback result must not be spilled")
	}
}

func TestIngestAggregateSpillsLargest(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sizes := map[string]int{"T1": 45000, "T2": 45000, "T3": 45001, "T4": 45000, "T5": 45000}
	var first []llm.StreamEvent
	reg := tools.NewRegistry()
	for _, name := range []string{"T1", "T2", "T3", "T4", "T5"} {
		id := "t" + strings.ToLower(name[1:])
		first = append(first,
			llm.ToolCallStart{ToolName: name, ToolID: id},
			llm.ToolCallComplete{ToolID: id, ToolName: name, Arguments: map[string]any{}},
		)
		reg.Register(&mockTool{name: name, result: strings.Repeat("z", sizes[name])})
	}
	first = append(first, llm.StreamEnd{StopReason: "tool_use"})

	client := &mockClient{responses: [][]llm.StreamEvent{
		first,
		{llm.TextDelta{Text: "done"}, llm.StreamEnd{StopReason: "end_turn"}},
	}}
	ag := New(client, reg, "anthropic")
	ag.WorkDir = t.TempDir()
	ag.SetSessionID("test-session")
	conv := conversation.NewManager()

	runConversationRound(ag, conv, "fan out")

	msg := findToolResultsMsg(t, conv)
	total := 0
	previews := 0
	var t3Content string
	for _, tr := range msg.ToolResults {
		total += len(tr.Content)
		if strings.HasPrefix(tr.Content, "<persisted-output>") {
			previews++
		}
		if tr.ToolUseID == "t3" {
			t3Content = tr.Content
		}
	}
	if total > 200000 {
		t.Fatalf("aggregate %d still over limit", total)
	}
	if previews != 1 {
		t.Fatalf("expected exactly 1 preview, got %d", previews)
	}
	if !strings.HasPrefix(t3Content, "<persisted-output>") {
		t.Fatal("largest result t3 should be the one spilled")
	}
}
