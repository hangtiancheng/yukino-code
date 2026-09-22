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
	"fmt"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// ToolResultPreviewChars is the preview length used both for transcript
// display and for persisted spill replacements.
const ToolResultPreviewChars = 2000

// ToDisplayPreview truncates content for transcript display, keeping the
// omission count visible. Lengths are UTF-16 code units (TS: content.length),
// so CJK content is not omitted ~3x early and the cut never splits a
// character.
func ToDisplayPreview(content string) string {
	if utils.UTF16Len(content) <= ToolResultPreviewChars {
		return content
	}
	return utils.TruncateUTF16(content, ToolResultPreviewChars) +
		fmt.Sprintf("\n… %d chars omitted from transcript", utils.UTF16Len(content)-ToolResultPreviewChars)
}

// ReplaceToolResultContent swaps a tool result's text while keeping structured
// non-text blocks: the new text becomes the first text block, existing text
// blocks are dropped, everything else is preserved.
func ReplaceToolResultContent(result *conversation.ToolResultBlock, content string) {
	result.Content = content
	if len(result.ContentBlocks) > 0 {
		blocks := []map[string]any{{"type": "text", "text": content}}
		for _, block := range result.ContentBlocks {
			if block["type"] != "text" {
				blocks = append(blocks, block)
			}
		}
		result.ContentBlocks = blocks
	}
}

// BuildPersistedOutputPreview renders the <persisted-output> wrapper.
// buildSpillPreview derives the inputs from an in-memory string; tool-level
// producers (e.g. a backgrounded shell command's live output file) build the
// same wrapper from a stat + partial read without loading the full content.
func BuildPersistedOutputPreview(totalChars int, preview, spillPath string) string {
	sizeKB := totalChars / 1024
	var b strings.Builder
	fmt.Fprintf(&b, "<persisted-output>\n")
	fmt.Fprintf(&b, "Output too large (%dKB). Full content saved to:\n%s\n\n", sizeKB, spillPath)
	fmt.Fprintf(&b, "Preview (first 2KB):\n%s", preview)
	if totalChars > ToolResultPreviewChars {
		b.WriteString("\n...")
	}
	b.WriteString("\n</persisted-output>")
	return b.String()
}
