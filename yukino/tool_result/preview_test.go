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

package tool_result

import (
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
)

func TestToDisplayPreview(t *testing.T) {
	short := "hello"
	if got := ToDisplayPreview(short); got != short {
		t.Fatalf("short content must pass through: %q", got)
	}
	long := strings.Repeat("x", ToolResultPreviewChars+50)
	got := ToDisplayPreview(long)
	if !strings.HasPrefix(got, strings.Repeat("x", ToolResultPreviewChars)) {
		t.Fatal("preview must keep the first 2000 chars")
	}
	if !strings.Contains(got, "50 chars omitted from transcript") {
		t.Fatalf("omission count missing: %q", got[len(got)-60:])
	}
}

func TestReplaceToolResultContent(t *testing.T) {
	result := conversation.ToolResultBlock{
		ToolUseID: "t1",
		Content:   "old",
		ContentBlocks: []map[string]any{
			{"type": "text", "text": "old"},
			{"type": "tool_reference", "name": "X"},
		},
	}
	ReplaceToolResultContent(&result, "new")
	if result.Content != "new" {
		t.Fatalf("content not replaced: %q", result.Content)
	}
	if len(result.ContentBlocks) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(result.ContentBlocks))
	}
	if result.ContentBlocks[0]["type"] != "text" || result.ContentBlocks[0]["text"] != "new" {
		t.Fatalf("first block must be the new text: %v", result.ContentBlocks[0])
	}
	if result.ContentBlocks[1]["type"] != "tool_reference" {
		t.Fatalf("non-text blocks must be preserved: %v", result.ContentBlocks[1])
	}

	// Without content blocks only the text is replaced.
	plain := conversation.ToolResultBlock{Content: "old"}
	ReplaceToolResultContent(&plain, "new")
	if plain.Content != "new" || plain.ContentBlocks != nil {
		t.Fatalf("plain result wrong: %+v", plain)
	}
}

func TestBuildPersistedOutputPreviewMatchesSpillFormat(t *testing.T) {
	content := strings.Repeat("y", 5000)
	viaSpill := buildSpillPreview(content, "/tmp/spill/t1.txt")
	viaBuilder := BuildPersistedOutputPreview(len(content), content[:ToolResultPreviewChars], "/tmp/spill/t1.txt")
	if viaSpill != viaBuilder {
		t.Fatal("buildSpillPreview must delegate to BuildPersistedOutputPreview byte-identically")
	}
	if !strings.Contains(viaSpill, "Output too large (4KB)") || !strings.HasSuffix(viaSpill, "\n...\n</persisted-output>") {
		t.Fatalf("wrapper format wrong: %q", viaSpill[:80])
	}
	// Under the preview size: no ellipsis.
	small := BuildPersistedOutputPreview(100, strings.Repeat("z", 100), "/tmp/s.txt")
	if strings.Contains(small, "\n...") {
		t.Fatalf("small content must not carry ellipsis: %q", small)
	}
}
