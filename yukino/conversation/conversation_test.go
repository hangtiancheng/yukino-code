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
	"strings"
	"testing"
)

// The usage anchor references the pre-truncation history, so any truncation
// must clear it; otherwise token estimates keep a stale baseline.
func TestTruncateToClearsUsageAnchor(t *testing.T) {
	m := NewManager()
	m.AddUserMessage("hi")
	m.AddAssistantMessage("hello")
	m.RecordUsageAnchor(100, 20, 30, 40)
	if _, _, hasUsage := m.UsageAnchorState(); !hasUsage {
		t.Fatal("anchor should be recorded before truncation")
	}

	m.TruncateTo(1)

	baseline, anchorCount, hasUsage := m.UsageAnchorState()
	if hasUsage || baseline != 0 || anchorCount != 0 {
		t.Errorf("anchor should be cleared, got baseline=%d anchorCount=%d hasUsage=%v",
			baseline, anchorCount, hasUsage)
	}
	if m.Len() != 1 {
		t.Errorf("history should be truncated to 1 message, got %d", m.Len())
	}
}

// Truncating to zero removes the injected reminder, so the flag must reset and
// instructions, memories and skills become injectable again.
func TestTruncateToZeroResetsLongTermMemoryInjected(t *testing.T) {
	m := NewManager()
	m.InjectLongTermMemory("instr", "", "")
	if m.Len() != 1 {
		t.Fatalf("want the injected message, got %d", m.Len())
	}

	m.TruncateTo(0)
	m.InjectLongTermMemory("instr", "", "")

	if m.Len() != 1 {
		t.Errorf("want re-injection after full truncation, got %d messages", m.Len())
	}
}

// A partial truncation keeps the injected reminder at index 0, so the flag
// stays set and a repeated injection is a no-op.
func TestTruncateToPartialKeepsLongTermMemoryFlag(t *testing.T) {
	m := NewManager()
	m.InjectLongTermMemory("instr", "", "")
	m.AddUserMessage("hi")

	m.TruncateTo(1)
	m.InjectLongTermMemory("instr", "", "")

	if m.Len() != 1 {
		t.Errorf("partial truncation keeps the injected message; want 1, got %d", m.Len())
	}
}

// ReplaceWithCompacted rebuilds the history as summary + kept tail, clears the
// usage anchor, and lets the long-term memory block be re-injected (TS
// replaceWithCompacted).
func TestReplaceWithCompacted(t *testing.T) {
	m := NewManager()
	m.AddUserMessage("old 1")
	m.AddAssistantMessage("old 2")
	m.RecordUsageAnchor(100, 10, 5, 5)

	keep := []Message{{Role: "assistant", Content: "kept"}}
	m.ReplaceWithCompacted("SUMMARY", keep)

	msgs := m.GetMessages()
	if len(msgs) != 2 || msgs[0].Role != "user" || msgs[0].Content != "SUMMARY" || msgs[1].Content != "kept" {
		t.Fatalf("unexpected history after replace: %+v", msgs)
	}
	if _, _, hasUsage := m.UsageAnchorState(); hasUsage {
		t.Error("usage anchor must be cleared by ReplaceWithCompacted")
	}
	// longTermMemoryInjected is reset: the block can be injected again.
	m.InjectLongTermMemory("instr", "", "")
	got := m.GetMessages()
	if got[0].Role != "user" || !strings.Contains(got[0].Content, "<project_context>") {
		t.Errorf("long-term memory must be re-injectable after replace, got first message %+v", got[0])
	}
}
