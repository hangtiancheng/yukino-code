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

package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Complete must return matches in registration order (TS complete():
// [...commands.values()].filter(...) keeps the Map's insertion order).
func TestCompleteRegistrationOrder(t *testing.T) {
	r := NewRegistry()
	for _, name := range []string{"beta", "alpha", "byte"} {
		r.Register(&Command{Name: name, Type: TypeLocal})
	}
	got := r.Complete("b")
	if len(got) != 2 || got[0].Name != "beta" || got[1].Name != "byte" {
		names := make([]string, 0, len(got))
		for _, c := range got {
			names = append(names, c.Name)
		}
		t.Fatalf("Complete(\"b\") = %v, want [beta byte] in registration order", names)
	}
	// An alias match also keeps the command's registration position.
	r.Register(&Command{Name: "zulu", Aliases: []string{"zed"}, Type: TypeLocal})
	got = r.Complete("ze")
	if len(got) != 1 || got[0].Name != "zulu" {
		t.Fatalf("alias completion wrong: %+v", got)
	}
}

// The default registry must register commands in the TS order so Complete
// (registration order) matches the TS output.
func TestDefaultRegistryRegistrationOrder(t *testing.T) {
	r := CreateDefaultRegistry()
	want := []string{
		"login", "help", "clear", "compact", "status", "session", "plan",
		"resume", "quit", "memory", "skills", "worktree", "code-review",
		"review", "rewind", "mcp", "sandbox", "thinking",
	}
	got := r.Complete("")
	if len(got) != len(want) {
		t.Fatalf("expected %d commands, got %d", len(want), len(got))
	}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("Complete(\"\")[%d] = %q, want %q (TS registration order)", i, got[i].Name, name)
		}
	}
}

// ListCommands sorts with the ICU root collator like TS localeCompare: a
// plain byte sort would order "Zebra" before "apple".
func TestListCommandsICUOrder(t *testing.T) {
	r := NewRegistry()
	for _, name := range []string{"Zebra", "apple", "Banana"} {
		r.Register(&Command{Name: name, Type: TypeLocal})
	}
	got := r.ListCommands()
	if len(got) != 3 {
		t.Fatalf("expected 3 commands, got %d", len(got))
	}
	want := []string{"apple", "Banana", "Zebra"}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("ListCommands()[%d] = %q, want %q (localeCompare order)", i, got[i].Name, name)
		}
	}
}

// The persisted document keeps first-use insertion order (TS:
// JSON.stringify(Object.fromEntries(this.usage)) over the Map), uses the TS
// two-space indent, and does not HTML-escape keys (JSON.stringify keeps
// `<`/`>`/`&` literal).
func TestUsageTrackerSaveOrderAndEscaping(t *testing.T) {
	dir := t.TempDir()
	tr := NewUsageTracker(dir)
	tr.Record("zeta")
	tr.Record("<alpha>&")
	tr.Record("zeta") // a repeat keeps the original position (Map.set)

	raw, err := os.ReadFile(filepath.Join(dir, ".yukino", "command_usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	if strings.Index(content, `"zeta"`) == -1 || strings.Index(content, `"<alpha>&"`) == -1 {
		t.Fatalf("keys missing or HTML-escaped: %s", content)
	}
	if strings.Contains(content, `\u003c`) {
		t.Fatalf("JSON.stringify does not HTML-escape, Go must not either: %s", content)
	}
	if strings.Index(content, `"zeta"`) > strings.Index(content, `"<alpha>&"`) {
		t.Fatalf("keys must keep first-use order (zeta first): %s", content)
	}
	if !strings.Contains(content, "{\n  \"zeta\": {\n    \"usageCount\": 2,") {
		t.Fatalf("unexpected document shape: %s", content)
	}
}

// A corrupt entry is skipped per-entry (TS: safeParse per Object.entries
// item); the remaining valid entries still load in document order.
func TestUsageTrackerLoadSkipsInvalidEntries(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".yukino"), 0o755); err != nil {
		t.Fatal(err)
	}
	doc := `{
  "good": {"usageCount": 1, "lastUsedAt": 1700000000000},
  "bad-string": {"usageCount": "x", "lastUsedAt": 1700000000000},
  "bad-missing": {"usageCount": 1},
  "bad-not-object": 5,
  "also-good": {"usageCount": 1, "lastUsedAt": 1700000000000}
}`
	path := filepath.Join(dir, ".yukino", "command_usage.json")
	if err := os.WriteFile(path, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}

	tr := NewUsageTracker(dir)
	if tr.GetScore("bad-string") != 0 || tr.GetScore("bad-missing") != 0 || tr.GetScore("bad-not-object") != 0 {
		t.Fatalf("invalid entries must not load: %v", tr.usage)
	}
	if tr.GetScore("good") == 0 || tr.GetScore("also-good") == 0 {
		t.Fatalf("valid entries must load: %v", tr.usage)
	}
	// Equal usageCount + lastUsedAt → equal scores → the stable sort keeps
	// the document insertion order (TS Array.prototype.sort is stable and
	// compares scores only).
	recent := tr.GetRecentlyUsed(5)
	if len(recent) != 2 || recent[0] != "good" || recent[1] != "also-good" {
		t.Fatalf("tie order must follow insertion order: %v", recent)
	}
}

// A non-object document is ignored silently (TS isRecord guard), and a
// missing file starts empty.
func TestUsageTrackerLoadNonObjectDocument(t *testing.T) {
	dir := t.TempDir()
	tr := NewUsageTracker(dir)
	if len(tr.order) != 0 {
		t.Fatalf("missing file must start empty: %v", tr.order)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".yukino"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".yukino", "command_usage.json")
	for _, doc := range []string{`[1,2]`, `"str"`, `not json`} {
		if err := os.WriteFile(path, []byte(doc), 0o644); err != nil {
			t.Fatal(err)
		}
		tr := NewUsageTracker(dir)
		if len(tr.order) != 0 {
			t.Fatalf("non-object document %q must be ignored: %v", doc, tr.order)
		}
	}
}
