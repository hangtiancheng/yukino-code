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

package conversation

import (
	"reflect"
	"testing"
)

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

// A fully paired history should not be modified at all.
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

// When a tool call has no result, an error result must be appended immediately
// after the call.
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

// When a single message contains multiple calls, every one must be filled in.
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

// Orphan results with no matching call must be dropped.
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

// A call that has already been filled in must not be filled again in later
// messages.
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

// The input must not be mutated in place.
func TestEnsureToolPairingDoesNotMutateInput(t *testing.T) {
	in := []Message{assistantWithTool("t1", "Bash")}
	_ = EnsureToolPairing(in)
	if len(in) != 1 {
		t.Fatalf("input slice was modified, len = %d", len(in))
	}
}

// A result that arrives after an intervening user turn is not adjacent to its
// call. The call must be repaired at the turn boundary with a synthetic
// interrupted result, while the late result keeps only its own content.
func TestEnsureToolPairingRepairsCallBeforeInterveningTurn(t *testing.T) {
	late := resultFor("a", "result a")
	late.Content = "<system-reminder>still relevant</system-reminder>"
	in := []Message{
		assistantWithTool("a", "ReadFile"),
		{Role: "user", Content: "continue"},
		late,
	}
	got := EnsureToolPairing(in)

	if len(got) != 4 {
		t.Fatalf("expected 4 messages, got %d: %+v", len(got), got)
	}
	if len(got[1].ToolResults) != 1 ||
		got[1].ToolResults[0].ToolUseID != "a" ||
		!got[1].ToolResults[0].IsError ||
		got[1].ToolResults[0].Content != InterruptedToolResult {
		t.Errorf("expected a synthetic interrupted result right after the call, got %+v", got[1])
	}
	if got[2].Content != "continue" || len(got[2].ToolResults) != 0 {
		t.Errorf("intervening user message changed: %+v", got[2])
	}
	if got[3].Content != late.Content || len(got[3].ToolResults) != 0 {
		t.Errorf("late result should keep its content and lose the tool results: %+v", got[3])
	}
	total := 0
	for _, m := range got {
		total += len(m.ToolResults)
	}
	if total != 1 {
		t.Errorf("expected exactly 1 tool result overall, got %d", total)
	}
	// The repair must be idempotent.
	if again := EnsureToolPairing(got); !reflect.DeepEqual(again, got) {
		t.Errorf("repair is not idempotent:\nfirst:  %+v\nsecond: %+v", got, again)
	}
}

// A result that precedes its call must not resolve that call.
func TestEnsureToolPairingIgnoresResultBeforeCall(t *testing.T) {
	in := []Message{
		resultFor("a", "result a"),
		assistantWithTool("a", "ReadFile"),
	}
	got := EnsureToolPairing(in)

	if len(got) != 2 {
		t.Fatalf("expected 2 messages, got %d: %+v", len(got), got)
	}
	if got[0].Role != "assistant" || len(got[0].ToolUses) != 1 {
		t.Fatalf("expected the call first, got %+v", got[0])
	}
	if len(got[1].ToolResults) != 1 || !got[1].ToolResults[0].IsError {
		t.Errorf("expected a synthetic error result after the call, got %+v", got[1])
	}
}

// Duplicate results are dropped and a missing sibling is filled at the turn
// boundary; the merged group keeps the first result message's content.
func TestEnsureToolPairingDeduplicatesAndFillsSibling(t *testing.T) {
	first := resultFor("a", "result a")
	first.Content = "<system-reminder>note</system-reminder>"
	in := []Message{
		{Role: "assistant", ToolUses: []ToolUseBlock{
			{ToolUseID: "a", ToolName: "ReadFile"},
			{ToolUseID: "b", ToolName: "Grep"},
		}},
		first,
		resultFor("a", "duplicate a"),
	}
	got := EnsureToolPairing(in)

	if len(got) != 2 {
		t.Fatalf("expected 2 messages, got %d: %+v", len(got), got)
	}
	if got[1].Content != first.Content {
		t.Errorf("merged group lost the first result message's content: %q", got[1].Content)
	}
	want := []ToolResultBlock{
		{ToolUseID: "a", Content: "result a"},
		{ToolUseID: "b", Content: InterruptedToolResult, IsError: true},
	}
	if !reflect.DeepEqual(got[1].ToolResults, want) {
		t.Errorf("merged results = %+v, want %+v", got[1].ToolResults, want)
	}
}

// Parallel result messages are merged into a single group right after the
// call; a later result message keeps its own content as a separate message.
func TestEnsureToolPairingKeepsParallelResultsTogether(t *testing.T) {
	second := resultFor("b", "result b")
	second.Content = "<system-reminder>after tools</system-reminder>"
	in := []Message{
		{Role: "assistant", ToolUses: []ToolUseBlock{
			{ToolUseID: "a", ToolName: "ReadFile"},
			{ToolUseID: "b", ToolName: "Grep"},
		}},
		resultFor("a", "result a"),
		second,
	}
	got := EnsureToolPairing(in)

	if len(got) != 3 {
		t.Fatalf("expected 3 messages, got %d: %+v", len(got), got)
	}
	if len(got[1].ToolResults) != 2 ||
		got[1].ToolResults[0].ToolUseID != "a" ||
		got[1].ToolResults[1].ToolUseID != "b" {
		t.Errorf("expected both results merged right after the call, got %+v", got[1])
	}
	if got[2].Content != second.Content || len(got[2].ToolResults) != 0 {
		t.Errorf("trailing result message should keep its content only: %+v", got[2])
	}
}

// TS measures content.length for the empty-shell test, which for a block
// array is the block count: a result message whose only content is a block
// array must be kept (orphaned results dropped), not dropped.
func TestEnsureToolPairingKeepsContentBlocksShell(t *testing.T) {
	shell := Message{
		Role:          "user",
		ContentBlocks: []map[string]any{{"type": "text", "text": "attachment"}},
		ToolResults:   []ToolResultBlock{{ToolUseID: "orphan", Content: "stale"}},
	}
	out := EnsureToolPairing([]Message{assistantWithTool("tu-1", "ReadFile"), resultFor("tu-1", "ok"), shell})
	if len(out) != 3 {
		t.Fatalf("expected the content-blocks shell to be kept, got %d messages: %+v", len(out), out)
	}
	last := out[2]
	if len(last.ToolResults) != 0 {
		t.Errorf("orphan results must be dropped, got %d", len(last.ToolResults))
	}
	if len(last.ContentBlocks) != 1 {
		t.Errorf("content blocks must be preserved, got %d", len(last.ContentBlocks))
	}
}
