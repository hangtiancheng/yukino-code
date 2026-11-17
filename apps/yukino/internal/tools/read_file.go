package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/images"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

var log = logger.CreateChildLogger("tools")

type ReadFileTool struct {
	FileStateCache *FileStateCache
}

func (t *ReadFileTool) Name() string        { return "ReadFile" }
func (t *ReadFileTool) Description() string { return ReadFileDescription }

func (t *ReadFileTool) Category() ToolCategory { return CategoryRead }

func (t *ReadFileTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path": map[string]any{"type": "string", "description": ReadFileFilePathDescription},
				"offset":    map[string]any{"type": "integer", "description": ReadFileOffsetDescription, "minimum": 0, "default": 0},
				"limit":     map[string]any{"type": "integer", "description": ReadFileLimitDescription, "minimum": 1, "default": DefaultReadLimit},
			},
			"required": []string{"file_path"},
		},
	}
}

func (t *ReadFileTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	cache := fileCacheForContext(ctx, t.FileStateCache)
	requestedPath, _ := args["file_path"].(string)
	if requestedPath == "" {
		return ToolResult{Output: "Error: file_path is required", IsError: true}
	}
	path := toolPath(ctx, requestedPath)
	if ctx.Err() != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return ToolResult{Output: fmt.Sprintf("Error: file not found: %s", path), IsError: true}
	}
	if err != nil {
		return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
	}
	if info.IsDir() {
		return ToolResult{Output: fmt.Sprintf("Error: %s is a directory, not a file. Use Glob to list directory contents.", path), IsError: true}
	}
	if !info.Mode().IsRegular() {
		return ToolResult{Output: fmt.Sprintf("Error: %s is not a regular file", path), IsError: true}
	}
	isImage := images.IsImagePath(path)
	if !isImage {
		sniffed, ok, err := images.SniffFileMediaType(ctx, path)
		if err != nil {
			if ctx.Err() != nil {
				return ToolResult{Output: OperationInterruptedError, IsError: true}
			}
			return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
		}
		isImage = ok && sniffed != ""
	}
	if isImage {
		return t.readImage(ctx, path, info)
	}
	if info.Size() > MaxReadFileBytes {
		return ToolResult{Output: fmt.Sprintf("Error: %s is %d bytes, over the %d-byte read limit. Use Grep with a pattern, or Bash with head/tail/sed, to inspect parts of it.", path, info.Size(), MaxReadFileBytes), IsError: true}
	}
	offset, limit := intArg(args, "offset", 0), intArg(args, "limit", DefaultReadLimit)
	if offset < 0 || limit < 1 {
		return ToolResult{Output: "Error: offset must be >= 0 and limit must be >= 1", IsError: true}
	}
	if storage.IsPrivateStatePath(path) {
		if err := storage.ProtectPrivateFileSync(path); err != nil {
			return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
	}
	lines := strings.Split(strings.ToValidUTF8(string(data), "�"), "\n")
	if offset >= len(lines) {
		return ToolResult{Output: fmt.Sprintf("Error: offset %d is beyond end of file (%d lines total)", offset, len(lines)), IsError: true}
	}
	numbered := make([]string, 0, min(limit, len(lines)-offset))
	outputBytes := 0
	for i := offset; i < len(lines) && i-offset < limit; i++ {
		line := fmt.Sprintf("%d\t%s", i+1, lines[i])
		n := len(line)
		if len(numbered) > 0 {
			n++
		}
		if n+outputBytes > MaxReadBytes {
			if len(numbered) == 0 {
				return ToolResult{Output: fmt.Sprintf("Error: line %d exceeds the 50KB read limit; use Bash to inspect it in smaller chunks.", i+1), IsError: true}
			}
			break
		}
		numbered = append(numbered, line)
		outputBytes += n
	}
	after, err := os.Stat(path)
	if err != nil {
		return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
	}
	if !after.ModTime().Equal(info.ModTime()) || after.Size() != info.Size() {
		return ToolResult{Output: fmt.Sprintf("Error: %s changed while it was being read; read it again before editing.", path), IsError: true}
	}
	if ctx.Err() != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	if cache != nil {
		cache.Record(path, info.ModTime().UnixMilli())
	}
	next := offset + len(numbered)
	if remaining := len(lines) - next; remaining > 0 {
		numbered = append(numbered, fmt.Sprintf("[%d more lines in file. Use offset=%d to continue.]", remaining, next))
	}
	return ToolResult{Output: strings.Join(numbered, "\n")}
}

func (t *ReadFileTool) readImage(ctx context.Context, path string, info os.FileInfo) ToolResult {
	cache := fileCacheForContext(ctx, t.FileStateCache)
	attachment, err := images.LoadImageAttachment(ctx, path)
	if err == nil {
		after, statErr := os.Stat(path)
		if statErr != nil {
			log.Error(map[string]any{"err": statErr}, "image read failed")
			if ctx.Err() != nil {
				return ToolResult{Output: OperationInterruptedError, IsError: true}
			}
			return ToolResult{Output: fmt.Sprintf("Error reading image %s: %s", filepath.Base(path), statErr), IsError: true}
		}
		if !after.ModTime().Equal(info.ModTime()) || after.Size() != info.Size() {
			return ToolResult{Output: fmt.Sprintf("Error: %s changed while it was being read; read it again before editing.", path), IsError: true}
		}
		if ctx.Err() != nil {
			return ToolResult{Output: OperationInterruptedError, IsError: true}
		}
		if cache != nil {
			cache.Record(path, info.ModTime().UnixMilli())
		}
		imageBlock := map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": string(attachment.MediaType),
				"data":       attachment.Data,
			},
		}
		return ToolResult{
			Output:        fmt.Sprintf("[Image: %s]", attachment.MediaType),
			ContentBlocks: []map[string]any{imageBlock},
		}
	}
	if ctx.Err() != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	log.Error(map[string]any{"err": err}, "image read failed")
	return ToolResult{Output: fmt.Sprintf("Error reading image %s: %s", filepath.Base(path), err), IsError: true}
}

func intArg(args map[string]any, key string, def int) int {
	v, ok := args[key]
	if !ok {
		return def
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return def
}
