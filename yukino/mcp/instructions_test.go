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

package mcp

import (
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
)

type fakeHistory struct {
	reminders   []string
	hasReminder bool
}

func (h *fakeHistory) HasReminderContaining(string) bool { return h.hasReminder }
func (h *fakeHistory) AddSystemReminder(content string) {
	h.reminders = append(h.reminders, content)
	h.hasReminder = true
}

type fakeSource struct{ servers []ServerInfo }

func (s fakeSource) ConnectedServers() []ServerInfo { return s.servers }

func announcedSet(names ...string) map[string]bool {
	m := make(map[string]bool)
	for _, n := range names {
		m[n] = true
	}
	return m
}

func TestSyncInstructionsAnnouncesOnceSorted(t *testing.T) {
	h := &fakeHistory{}
	announced := announcedSet()
	src := fakeSource{servers: []ServerInfo{
		{Name: "b", Instructions: "b guidance"},
		{Name: "a", Instructions: "a guidance"},
	}}

	if !SyncInstructions(h, announced, src) {
		t.Fatal("first sync should announce")
	}
	if len(h.reminders) != 1 {
		t.Fatalf("want 1 reminder, got %d", len(h.reminders))
	}
	r := h.reminders[0]
	if !strings.Contains(r, InstructionsMarker) ||
		!strings.Contains(r, "## a\na guidance") ||
		!strings.Contains(r, "## b\nb guidance") {
		t.Fatalf("reminder missing content: %s", r)
	}
	if strings.Index(r, "## a") >= strings.Index(r, "## b") {
		t.Fatal("servers must be sorted by name")
	}

	if SyncInstructions(h, announced, src) {
		t.Fatal("second sync should stay quiet")
	}
	if len(h.reminders) != 1 {
		t.Fatalf("want still 1 reminder, got %d", len(h.reminders))
	}
}

func TestSyncInstructionsSingleDelta(t *testing.T) {
	h := &fakeHistory{}
	announced := announcedSet()
	SyncInstructions(h, announced, fakeSource{servers: []ServerInfo{
		{Name: "a", Instructions: "a guidance"},
		{Name: "b", Instructions: "b guidance"},
	}})

	// a disconnects, c connects late: one delta carries both.
	changed := SyncInstructions(h, announced, fakeSource{servers: []ServerInfo{
		{Name: "b", Instructions: "b guidance"},
		{Name: "c", Instructions: "c guidance"},
	}})
	if !changed {
		t.Fatal("delta sync should announce")
	}
	delta := h.reminders[len(h.reminders)-1]
	if !strings.Contains(delta, "## c\nc guidance") {
		t.Fatalf("delta missing late server: %s", delta)
	}
	if strings.Contains(delta, "## b") {
		t.Fatalf("delta must not repeat announced server b: %s", delta)
	}
	if !strings.Contains(delta, "no longer apply:\na") {
		t.Fatalf("delta missing retraction: %s", delta)
	}
	if !announced["b"] || !announced["c"] || announced["a"] {
		t.Fatalf("announced set wrong: %v", announced)
	}
}

func TestSyncInstructionsIgnoresSilentServers(t *testing.T) {
	h := &fakeHistory{}
	announced := announcedSet()
	if SyncInstructions(h, announced, fakeSource{servers: []ServerInfo{{Name: "quiet"}}}) {
		t.Fatal("server without instructions must not announce")
	}
	if SyncInstructions(h, announced, fakeSource{}) {
		t.Fatal("disconnect of a never-announced server must not retract")
	}
	if len(h.reminders) != 0 {
		t.Fatalf("want no reminders, got %v", h.reminders)
	}
}

func TestSyncInstructionsReAnnouncesAfterHistoryLoss(t *testing.T) {
	announced := announcedSet()
	src := fakeSource{servers: []ServerInfo{{Name: "a", Instructions: "a guidance"}}}
	first := &fakeHistory{}
	SyncInstructions(first, announced, src)
	if !announced["a"] {
		t.Fatal("a should be announced")
	}

	// Compaction dropped the reminder: history no longer carries the marker,
	// so everything goes out again — as a fresh announcement, not a delta.
	compacted := &fakeHistory{}
	if !SyncInstructions(compacted, announced, src) {
		t.Fatal("should re-announce after history loss")
	}
	if len(compacted.reminders) != 1 {
		t.Fatalf("want 1 reminder, got %d", len(compacted.reminders))
	}
	if !strings.Contains(compacted.reminders[0], "## a\na guidance") ||
		strings.Contains(compacted.reminders[0], "no longer apply") {
		t.Fatalf("re-announcement wrong: %s", compacted.reminders[0])
	}
}

func TestSyncInstructionsAgainstRealConversation(t *testing.T) {
	conv := conversation.NewManager()
	announced := announcedSet()
	src := fakeSource{servers: []ServerInfo{{Name: "a", Instructions: "a guidance"}}}

	if !SyncInstructions(conv, announced, src) {
		t.Fatal("first sync should announce")
	}
	if SyncInstructions(conv, announced, src) {
		t.Fatal("second sync should stay quiet")
	}

	// Rebuilt conversation (resume/compact) loses the reminder → announce again.
	rebuilt := conversation.NewManager()
	if !SyncInstructions(rebuilt, announced, src) {
		t.Fatal("should re-announce against rebuilt conversation")
	}
}
