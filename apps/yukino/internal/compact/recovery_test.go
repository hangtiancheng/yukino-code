package compact

import (
	"strings"
	"testing"
)

func TestBuildRecoveryAttachmentEmpty(t *testing.T) {
	s := NewRecoveryState()
	if got := s.BuildRecoveryAttachment(nil); got != "" {
		t.Errorf("empty state must produce empty attachment, got %q", got)
	}
}

func TestBuildRecoveryAttachmentEmits(t *testing.T) {
	s := NewRecoveryState()
	s.RecordFileRead("/tmp/a.go", "package a")
	out := s.BuildRecoveryAttachment([]string{"Bash", "ReadFile"})
	for _, want := range []string{
		"## Recently read files\n",
		"These snapshots are what the file-reading tool last returned.",
		"### /tmp/a.go  (read ",
		"```\npackage a\n```",
		"## Available tools\n\nYou still have access to the following tools — call them directly when the task needs one:\n\n- Bash\n- ReadFile",
		"## Note\n\nEverything above the divider is reconstructed context.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// Sections join with a blank line; the header keeps its trailing newline.
	if !strings.Contains(out, "## Recently read files\n\n\nThese snapshots") {
		t.Errorf("section joining mismatch:\n%q", out)
	}
}

func TestRecordFileReadEvictionAndRefresh(t *testing.T) {
	s := NewRecoveryState()
	for i := 0; i < RecoveryFileLimit+2; i++ {
		s.RecordFileRead(string(rune('a'+i))+".txt", "content")
	}
	files := s.SnapshotFiles(RecoveryFileLimit)
	if len(files) != RecoveryFileLimit {
		t.Fatalf("files = %d, want %d", len(files), RecoveryFileLimit)
	}
	for _, f := range files {
		if f.Path == "a.txt" || f.Path == "b.txt" {
			t.Errorf("oldest entry %q must be evicted", f.Path)
		}
	}
	// Re-recording refreshes recency: the oldest surviving entry stays.
	s.RecordFileRead("c.txt", "refreshed")
	files = s.SnapshotFiles(RecoveryFileLimit)
	found := false
	for _, f := range files {
		if f.Path == "c.txt" && f.Content == "refreshed" {
			found = true
		}
	}
	if !found {
		t.Errorf("refreshed entry missing: %+v", files)
	}
}

func TestTruncateByTokens(t *testing.T) {
	short := "abc"
	if got := truncateByTokens(short, 100); got != short {
		t.Errorf("short = %q", got)
	}
	long := strings.Repeat("x", 100000)
	got := truncateByTokens(long, 100)
	if !strings.HasSuffix(got, "\n… (content truncated)") {
		t.Errorf("suffix missing: %q", got[len(got)-30:])
	}
	// Budget: maxChars = floor(100*3.5) = 350; result length = 350.
	if len([]rune(got)) != 350 {
		t.Errorf("length = %d, want 350", len([]rune(got)))
	}
	// Tiny budgets clip the suffix itself.
	got = truncateByTokens(long, 1)
	if len([]rune(got)) != 3 {
		t.Errorf("tiny budget = %q", got)
	}
	if got := truncateByTokens("", 10); got != "" {
		t.Errorf("empty = %q", got)
	}
	if got := truncateByTokens("x", 0); got != "x" {
		t.Errorf("zero budget = %q", got)
	}
}

func TestRecordFileReadTruncatesAtRecord(t *testing.T) {
	s := NewRecoveryState()
	long := strings.Repeat("y", 100000)
	s.RecordFileRead("/tmp/big.txt", long)
	files := s.SnapshotFiles(1)
	if len(files) != 1 {
		t.Fatal("expected one file")
	}
	if len([]rune(files[0].Content)) > 20000 {
		t.Errorf("content must be truncated at record time, got %d runes", len([]rune(files[0].Content)))
	}
}
