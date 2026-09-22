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
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 1x1 transparent PNG.
const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExpandAtRefsInlinesFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "hello.txt", "hello world")

	got := ExpandAtRefs("look at @hello.txt please", dir)
	if !strings.Contains(got, `<file path="hello.txt">`) || !strings.Contains(got, "hello world") {
		t.Fatalf("file not inlined: %q", got)
	}
	if !strings.HasPrefix(got, "look at @hello.txt please") {
		t.Fatalf("original text must be preserved: %q", got)
	}
}

func TestExpandAtRefsLeavesNonFiles(t *testing.T) {
	dir := t.TempDir()
	got := ExpandAtRefs("ping @nobody and @user", dir)
	if got != "ping @nobody and @user" {
		t.Fatalf("non-file tokens must stay literal: %q", got)
	}
}

func TestExpandAtRefsNoRefs(t *testing.T) {
	if got := ExpandAtRefs("plain text", t.TempDir()); got != "plain text" {
		t.Fatalf("text changed without refs: %q", got)
	}
}

func TestExpandAtRefsDeduplicates(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.txt", "A")

	got := ExpandAtRefs("@a.txt and again @a.txt", dir)
	if strings.Count(got, "<file path=\"a.txt\">") != 1 {
		t.Fatalf("repeated ref must inline once: %q", got)
	}
}

func TestExpandAtRefsLineRange(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "lines.txt", "one\ntwo\nthree\nfour")

	got := ExpandAtRefs("@lines.txt#L2-3", dir)
	if !strings.Contains(got, `lines="2-3"`) || !strings.Contains(got, "two\nthree") {
		t.Fatalf("range slice wrong: %q", got)
	}
	if strings.Contains(got, "one\n") || strings.Contains(got, "four") {
		t.Fatalf("range must exclude other lines: %q", got)
	}
}

func TestExpandAtRefsQuotedPathWithSpaces(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "my file.txt", "spaced")

	got := ExpandAtRefs(`see @"my file.txt" here`, dir)
	if !strings.Contains(got, "spaced") {
		t.Fatalf("quoted ref not expanded: %q", got)
	}
}

func TestExpandAtRefsSkipsLargeFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "big.txt", strings.Repeat("x", maxInlineBytes+1))

	got := ExpandAtRefs("@big.txt", dir)
	if got != "@big.txt" {
		t.Fatalf("oversized file must stay literal: %q", got)
	}
}

func TestExpandAtRefsWithImagesPlainText(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "note.txt", "N")

	got, blocks := ExpandAtRefsWithImages("@note.txt", dir)
	if blocks != nil {
		t.Fatalf("no image refs must yield nil blocks, got %v", blocks)
	}
	if !strings.Contains(got, "N") {
		t.Fatalf("text ref must still expand: %q", got)
	}
}

func TestExpandAtRefsWithImagesLoadsBlocks(t *testing.T) {
	dir := t.TempDir()
	raw, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, "shot.png", string(raw))

	got, blocks := ExpandAtRefsWithImages("screenshot @shot.png", dir)
	if len(blocks) != 1 {
		t.Fatalf("want 1 image block, got %d", len(blocks))
	}
	block := blocks[0]
	if block["type"] != "image" {
		t.Fatalf("block type wrong: %v", block)
	}
	source, _ := block["source"].(map[string]any)
	if source == nil || source["type"] != "base64" || source["media_type"] != "image/png" {
		t.Fatalf("source wrong: %v", block)
	}
	if source["data"] != tinyPNG {
		t.Fatalf("base64 payload must round-trip: %v", source["data"])
	}
	if !strings.Contains(got, `<image type="base64" media_type="image/png" path="shot.png" />`) {
		t.Fatalf("placeholder missing: %q", got)
	}
}

// TS slice(from-1, to) yields an empty array when the requested line range
// starts past EOF; Go must not panic there and must inline an empty snippet
// (TS still appends the <file> block because "".length <= MAX_INLINE_BYTES).
func TestExpandAtRefsLineRangeBeyondEOF(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "short.txt", "one\ntwo\nthree")
	got := ExpandAtRefs("@short.txt#L990-999", dir)
	if !strings.Contains(got, `lines="990-999"`) {
		t.Fatalf("expected the range block to be inlined, got: %q", got)
	}
	if strings.Contains(got, "three") {
		t.Errorf("out-of-range slice must be empty, got: %q", got)
	}
}
