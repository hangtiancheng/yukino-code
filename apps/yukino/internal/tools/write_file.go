package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/file_history"
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
				"file_path": map[string]any{"type": "string", "description": WriteFileFilePathDescription},
				"content":   map[string]any{"type": "string", "description": WriteFileContentDescription},
			},
			"required": []string{"file_path", "content"},
		},
	}
}

func (t *WriteFileTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	cache := fileCacheForContext(ctx, t.FileStateCache)
	history := fileHistoryForContext(ctx, t.FileHistory)
	requestedPath, _ := args["file_path"].(string)
	if requestedPath == "" {
		return ToolResult{Output: "Error: file_path is required", IsError: true}
	}
	content, ok := args["content"].(string)
	if !ok {
		return ToolResult{Output: "Error: content is required", IsError: true}
	}
	path := toolPath(ctx, requestedPath)
	return withFileMutation(ctx, t.Name(), args, path, func() ToolResult {
		if ctx.Err() != nil {
			return ToolResult{Output: OperationInterruptedError, IsError: true}
		}
		check := func() *ToolResult {
			_, err := os.Stat(path)
			if cache != nil && (err == nil || cache.Has(path)) {
				if ok, message := cache.Check(path); !ok {
					return &ToolResult{Output: message, IsError: true}
				}
			}
			return nil
		}
		if blocked := check(); blocked != nil {
			return *blocked
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return ToolResult{Output: fmt.Sprintf("Error writing file: %s", err), IsError: true}
		}
		if ctx.Err() != nil {
			return ToolResult{Output: OperationInterruptedError, IsError: true}
		}
		if blocked := check(); blocked != nil {
			return *blocked
		}
		if history != nil {
			history.TrackEdit(path)
		}
		if err := writeFileAtomically(ctx, path, content); err != nil {
			if ctx.Err() != nil {
				return ToolResult{Output: OperationInterruptedError, IsError: true}
			}
			return ToolResult{Output: fmt.Sprintf("Error writing file: %s", err), IsError: true}
		}
		if cache != nil {
			cache.Update(path)
		}
		lines := 0
		if content != "" {
			lines = strings.Count(strings.TrimSuffix(content, "\n"), "\n") + 1
		}
		return ToolResult{Output: fmt.Sprintf("Successfully wrote to %s (%d lines)", path, lines)}
	})
}
