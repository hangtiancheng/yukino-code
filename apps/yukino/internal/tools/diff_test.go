package tools

import (
	"strconv"
	"strings"
	"testing"
)

func TestBuildDiffSingleLineChange(t *testing.T) {
	old := "a\nb\nc\nd\ne\n"
	new_ := "a\nb\nX\nd\ne\n"
	d := BuildDiff(old, new_)

	if d.Additions != 1 {
		t.Errorf("additions = %d, want 1", d.Additions)
	}
	if d.Removals != 1 {
		t.Errorf("removals = %d, want 1", d.Removals)
	}
	if !strings.Contains(d.Text, "-    3  c") {
		t.Errorf("missing removed line, got:\n%s", d.Text)
	}
	if !strings.Contains(d.Text, "+    3  X") {
		t.Errorf("missing added line, got:\n%s", d.Text)
	}
	if !strings.Contains(d.Text, "   2  b") || !strings.Contains(d.Text, "   4  d") {
		t.Errorf("missing context lines with original line numbers, got:\n%s", d.Text)
	}
}

func TestBuildDiffPureInsertion(t *testing.T) {
	d := BuildDiff("a\nb\n", "a\nX\nY\nb\n")
	if d.Removals != 0 {
		t.Errorf("removals = %d, want 0", d.Removals)
	}
	if d.Additions != 2 {
		t.Errorf("additions = %d, want 2", d.Additions)
	}
	if !strings.Contains(d.Text, "+    2  X") || !strings.Contains(d.Text, "+    3  Y") {
		t.Errorf("missing added lines, got:\n%s", d.Text)
	}
}

func TestBuildDiffPureDeletion(t *testing.T) {
	d := BuildDiff("a\nb\nc\n", "a\nc\n")
	if d.Additions != 0 {
		t.Errorf("additions = %d, want 0", d.Additions)
	}
	if d.Removals != 1 {
		t.Errorf("removals = %d, want 1", d.Removals)
	}
	if !strings.Contains(d.Text, "-    2  b") {
		t.Errorf("missing removed line, got:\n%s", d.Text)
	}
}

func TestBuildDiffTrimsUnrelatedPrefixSuffix(t *testing.T) {
	oldLines := make([]string, 20)
	for i := range oldLines {
		oldLines[i] = "line" + strconv.Itoa(i)
	}
	newLines := append([]string(nil), oldLines...)
	newLines[10] = "CHANGED"

	d := BuildDiff(strings.Join(oldLines, "\n"), strings.Join(newLines, "\n"))
	if strings.Contains(d.Text, "line0\n") {
		t.Errorf("unrelated prefix line leaked into diff, got:\n%s", d.Text)
	}
	if !strings.Contains(d.Text, "-   11  line10") || !strings.Contains(d.Text, "+   11  CHANGED") {
		t.Errorf("missing changed line, got:\n%s", d.Text)
	}
}

func TestBuildDiffCapsVeryLargeOutput(t *testing.T) {
	oldLines := make([]string, 500)
	newLines := make([]string, 500)
	for i := range oldLines {
		oldLines[i] = "old" + strconv.Itoa(i)
		newLines[i] = "new" + strconv.Itoa(i)
	}
	d := BuildDiff(strings.Join(oldLines, "\n"), strings.Join(newLines, "\n"))
	if !strings.Contains(d.Text, "truncated") {
		t.Errorf("expected truncation marker, got:\n%s", d.Text)
	}
	lineCount := len(strings.Split(d.Text, "\n"))
	if lineCount >= 500 {
		t.Errorf("expected capped output, got %d lines", lineCount)
	}
}
