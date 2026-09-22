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
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
)

// ExtractWrittenPaths collects the unique file_path arguments of every
// WriteFile/EditFile tool call that completed successfully, in first-seen
// order (TS: memory/written-paths.ts).
//
// Only completed writes count as saved memories; assistant prose is not
// execution evidence, and a tool call whose result is missing or flagged as
// an error never contributes its path.
func ExtractWrittenPaths(messages []conversation.Message) []string {
	successful := make(map[string]struct{})
	for _, m := range messages {
		for _, r := range m.ToolResults {
			if !r.IsError {
				successful[r.ToolUseID] = struct{}{}
			}
		}
	}

	var paths []string
	seen := make(map[string]struct{})
	for _, m := range messages {
		for _, tu := range m.ToolUses {
			if tu.ToolName != "WriteFile" && tu.ToolName != "EditFile" {
				continue
			}
			if _, ok := successful[tu.ToolUseID]; !ok {
				continue
			}
			// TS keeps every string file_path (typeof === "string"), including
			// the empty string (written-paths.ts:36-44).
			fp, ok := tu.Arguments["file_path"].(string)
			if !ok {
				continue
			}
			if _, dup := seen[fp]; dup {
				continue
			}
			seen[fp] = struct{}{}
			paths = append(paths, fp)
		}
	}
	return paths
}
