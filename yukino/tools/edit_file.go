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
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/file_history"
)

type EditFileTool struct {
	FileHistory    *file_history.History
	FileStateCache *FileStateCache
}

func (t *EditFileTool) Name() string { return "EditFile" }

func (t *EditFileTool) Description() string { return EditFileDescription }

func (t *EditFileTool) Category() ToolCategory { return CategoryWrite }

func (t *EditFileTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path":   map[string]any{"type": "string", "description": "Path to the existing file, absolute or relative to the Agent's working directory. Read it first with ReadFile."},
				"old_string":  map[string]any{"type": "string", "description": "Non-empty exact text to replace, including whitespace but excluding ReadFile line-number prefixes. Must match once unless replace_all is true."},
				"new_string":  map[string]any{"type": "string", "description": "Replacement text. May be empty to delete the matched text; must differ from old_string."},
				"replace_all": map[string]any{"type": "boolean", "description": "Replace all occurrences of old_string (default false)", "default": false},
			},
			"required": []string{"file_path", "old_string", "new_string"},
		},
	}
}

func (t *EditFileTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	requestedPath, _ := args["file_path"].(string)
	oldStr, _ := args["old_string"].(string)
	replaceAll := boolArg(args, "replace_all")

	if requestedPath == "" {
		return ToolResult{Output: "Error: file_path is required", IsError: true}
	}

	filePath := ResolvePath(WorkDirFromContext(ctx), requestedPath)

	if oldStr == "" {
		return ToolResult{Output: "Error: old_string is required", IsError: true}
	}
	newStr, ok := args["new_string"].(string)
	if !ok {
		return ToolResult{Output: "Error: new_string is required", IsError: true}
	}
	if oldStr == newStr {
		return ToolResult{Output: "Error: old_string and new_string MUST be different", IsError: true}
	}

	// Serialize concurrent edits targeting the same resolved path.
	return withFileMutationQueue(filePath, func() ToolResult {
		if err := ctx.Err(); err != nil {
			return ToolResult{Output: "Error: operation interrupted", IsError: true}
		}
		// Read-before-edit gate
		if fsc := ResolveFileStateCache(ctx, t.FileStateCache); fsc != nil {
			if ok, errMsg := fsc.Check(filePath); !ok {
				return ToolResult{Output: errMsg, IsError: true}
			}
		}

		if fh := ResolveFileHistory(ctx, t.FileHistory); fh != nil {
			fh.TrackEdit(filePath)
		}

		data, err := os.ReadFile(filePath)
		if err != nil {
			// TS has no dedicated not-found branch: readFile failures (ENOENT
			// included) surface through the same catch as any other read error.
			log.Error("tool operation failed", "err", err)
			return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
		}

		content := decodeUTF8Lenient(data)
		count := strings.Count(content, oldStr)
		if count == 0 {
			return ToolResult{Output: "Error: old_string not found in file", IsError: true}
		}
		if !replaceAll && count > 1 {
			return ToolResult{Output: fmt.Sprintf("Error: old_string found %d times in file. It must be unique. Add more surrounding context, or set replace_all to true", count), IsError: true}
		}

		var newContent string
		if replaceAll {
			newContent = strings.ReplaceAll(content, oldStr, newStr)
		} else {
			newContent = strings.Replace(content, oldStr, newStr, 1)
		}
		if err := os.WriteFile(filePath, []byte(newContent), 0o644); err != nil {
			log.Error("tool operation failed", "err", err)
			return ToolResult{Output: fmt.Sprintf("Error writing file: %s", err), IsError: true}
		}

		// Update cache after successful edit
		if fsc := ResolveFileStateCache(ctx, t.FileStateCache); fsc != nil {
			fsc.Update(filePath)
		}

		// Attach the concrete diff rather than just a "done" message:
		// the model and TUI both need to know which lines were changed.
		diff := BuildDiff(content, newContent)
		summary := fmt.Sprintf(
			"Updated %s with %d addition%s and %d removal%s",
			filePath, diff.Additions, plural(diff.Additions), diff.Removals, plural(diff.Removals),
		)
		if replaceAll && count > 1 {
			summary += fmt.Sprintf(" (%d replacements)", count)
		}
		return ToolResult{Output: summary + "\n" + diff.Text}
	})
}
