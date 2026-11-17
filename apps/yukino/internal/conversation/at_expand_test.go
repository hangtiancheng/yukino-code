package conversation

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func writeAtFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestExpandAtRefsProseAdjacent(t *testing.T) {
	cases := []string{
		"read @notes.md#L2-3; then continue",
		"read @notes.md#L2-L3，继续",
		"read @notes.md#L2-3继续",
		"read @notes.md；继续",
		"read @notes.md继续",
		"read (@notes.md)",
	}
	for _, text := range cases {
		t.Run(text, func(t *testing.T) {
			cwd := t.TempDir()
			writeAtFile(t, cwd, "notes.md", "one\ntwo\nthree\nfour")
			out := ExpandAtRefs(text, cwd)
			if !strings.Contains(out, `path="notes.md"`) {
				t.Fatalf("missing file appendix:\n%s", out)
			}
			if strings.Contains(text, "#L") {
				if !strings.Contains(out, "two\nthree") {
					t.Fatalf("missing line range content:\n%s", out)
				}
				if strings.Contains(out, "\nfour") {
					t.Fatalf("range must exclude line 4:\n%s", out)
				}
			} else if !strings.Contains(out, "one\ntwo") {
				t.Fatalf("missing full content:\n%s", out)
			}
		})
	}
}

func TestExpandAtRefsUnicodeAndQuoted(t *testing.T) {
	cwd := t.TempDir()
	writeAtFile(t, cwd, "笔记.md", "unicode file")
	writeAtFile(t, cwd, "notes; v2.md", "quoted file")
	if out := ExpandAtRefs("read @笔记.md，继续", cwd); !strings.Contains(out, "unicode file") {
		t.Fatalf("unicode filename not expanded:\n%s", out)
	}
	if out := ExpandAtRefs(`read @"notes; v2.md"`, cwd); !strings.Contains(out, "quoted file") {
		t.Fatalf("quoted filename not expanded:\n%s", out)
	}
}

func TestExpandAtRefsInlinesContents(t *testing.T) {
	cwd := t.TempDir()
	writeAtFile(t, cwd, "notes.md", "hello from notes")
	text := "please read @notes.md and summarize"
	out := ExpandAtRefs(text, cwd)
	if !strings.Contains(out, text) {
		t.Fatalf("original text must be preserved:\n%s", out)
	}
	if !strings.Contains(out, `<file path="notes.md">`) {
		t.Fatalf("missing file block:\n%s", out)
	}
	if !strings.Contains(out, "hello from notes") {
		t.Fatalf("missing content:\n%s", out)
	}
}

func TestExpandAtRefsLeavesNonFiles(t *testing.T) {
	cwd := t.TempDir()
	text := "ping @alice about @nonexistent.txt"
	if out := ExpandAtRefs(text, cwd); out != text {
		t.Fatalf("text changed: %q", out)
	}
}

func TestExpandAtRefsNoRefs(t *testing.T) {
	cwd := t.TempDir()
	if out := ExpandAtRefs("just a plain message", cwd); out != "just a plain message" {
		t.Fatalf("text changed: %q", out)
	}
}

func TestExpandAtRefsDedupes(t *testing.T) {
	cwd := t.TempDir()
	writeAtFile(t, cwd, "a.txt", "AAA")
	out := ExpandAtRefs("@a.txt and again @a.txt", cwd)
	count := len(regexp.MustCompile(`<file path="a.txt">`).FindAllString(out, -1))
	if count != 1 {
		t.Fatalf("expected 1 file block, got %d:\n%s", count, out)
	}
}

func TestExpandAtRefsSkipsLargeFiles(t *testing.T) {
	cwd := t.TempDir()
	writeAtFile(t, cwd, "big.txt", strings.Repeat("x", MaxInlineBytes+1))
	text := "read @big.txt"
	if out := ExpandAtRefs(text, cwd); out != text {
		t.Fatalf("oversized file must not be inlined:\n%s", out[:80])
	}
}
