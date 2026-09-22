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

package memory

import (
	"reflect"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
)

// Mirrors TS tests/harness-data.test.ts: failed tool calls and prose must
// never be reported as saved memories.
func TestExtractWrittenPathsIgnoresFailedCalls(t *testing.T) {
	msgs := []conversation.Message{
		{
			Role:    "assistant",
			Content: `{"tool":"WriteFile","file_path":"fake.md"}`,
			ToolUses: []conversation.ToolUseBlock{
				{ToolUseID: "failed", ToolName: "WriteFile", Arguments: map[string]any{"file_path": "failed.md"}},
			},
		},
		{
			Role: "user",
			ToolResults: []conversation.ToolResultBlock{
				{ToolUseID: "failed", Content: "denied", IsError: true},
			},
		},
	}
	if got := ExtractWrittenPaths(msgs); len(got) != 0 {
		t.Fatalf("failed write must not count, got %v", got)
	}
}

func TestExtractWrittenPathsCountsSuccessfulAndDedupes(t *testing.T) {
	msgs := []conversation.Message{
		{
			Role: "assistant",
			ToolUses: []conversation.ToolUseBlock{
				{ToolUseID: "a", ToolName: "WriteFile", Arguments: map[string]any{"file_path": "one.md"}},
				{ToolUseID: "b", ToolName: "EditFile", Arguments: map[string]any{"file_path": "two.md"}},
				{ToolUseID: "c", ToolName: "ReadFile", Arguments: map[string]any{"file_path": "three.md"}},
			},
		},
		{
			Role: "user",
			ToolResults: []conversation.ToolResultBlock{
				{ToolUseID: "a", Content: "ok"},
				{ToolUseID: "b", Content: "ok"},
				{ToolUseID: "c", Content: "ok"},
			},
		},
		{
			Role: "assistant",
			ToolUses: []conversation.ToolUseBlock{
				{ToolUseID: "d", ToolName: "WriteFile", Arguments: map[string]any{"file_path": "one.md"}}, // dup
			},
		},
		{
			Role:        "user",
			ToolResults: []conversation.ToolResultBlock{{ToolUseID: "d", Content: "ok"}},
		},
		// A tool call with no result at all never counts.
		{
			Role: "assistant",
			ToolUses: []conversation.ToolUseBlock{
				{ToolUseID: "e", ToolName: "WriteFile", Arguments: map[string]any{"file_path": "pending.md"}},
			},
		},
	}
	want := []string{"one.md", "two.md"}
	if got := ExtractWrittenPaths(msgs); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
