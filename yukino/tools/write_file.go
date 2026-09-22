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

package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/file_history"
)

type WriteFileTool struct {
	FileHistory    *file_history.History
	FileStateCache *FileStateCache
}

func (t *WriteFileTool) Name() string { return "WriteFile" }

func (t *WriteFileTool) Description() string { return WriteFileDescription }

func (t *WriteFileTool) Category() ToolCategory { return CategoryWrite }

func (t *WriteFileTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path": map[string]any{"type": "string", "description": "File path, absolute or relative to the Agent's working directory. Missing parent directories are created; existing files must be read first."},
				"content":   map[string]any{"type": "string", "description": "Complete UTF-8 file contents. Replaces all existing content; an empty string creates or truncates an empty file."},
			},
			"required": []string{"file_path", "content"},
		},
	}
}

func (t *WriteFileTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	requestedPath, _ := args["file_path"].(string)
	if requestedPath == "" {
		return ToolResult{Output: "Error: file_path is required", IsError: true}
	}
	content, ok := args["content"].(string)
	if !ok {
		return ToolResult{Output: "Error: content is required", IsError: true}
	}

	filePath := ResolvePath(WorkDirFromContext(ctx), requestedPath)

	// Serialize concurrent writes targeting the same resolved path.
	return withFileMutationQueue(filePath, func() ToolResult {
		if err := ctx.Err(); err != nil {
			return ToolResult{Output: "Error: operation interrupted", IsError: true}
		}
		// Read-before-write gate. A file that exists on disk OR was previously
		// cached (e.g. deleted since) must have been read first (TS).
		fsc := ResolveFileStateCache(ctx, t.FileStateCache)
		if fsc != nil {
			if _, err := os.Stat(filePath); err == nil || fsc.Has(filePath) {
				if ok, errMsg := fsc.Check(filePath); !ok {
					return ToolResult{Output: errMsg, IsError: true}
				}
			}
		}

		if fh := ResolveFileHistory(ctx, t.FileHistory); fh != nil {
			fh.TrackEdit(filePath)
		}

		// TS wraps mkdir+write in one try/catch: every failure surfaces as
		// "Error writing file: ...".
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			log.Error("tool operation failed", "err", err)
			return ToolResult{Output: fmt.Sprintf("Error writing file: %s", err), IsError: true}
		}

		if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
			log.Error("tool operation failed", "err", err)
			return ToolResult{Output: fmt.Sprintf("Error writing file: %s", err), IsError: true}
		}

		// Update cache after successful write
		if fsc != nil {
			fsc.Update(filePath)
		}

		lineCount := strings.Count(content, "\n") + 1
		return ToolResult{Output: fmt.Sprintf("Successfully wrote to %s (%d lines)", filePath, lineCount)}
	})
}
