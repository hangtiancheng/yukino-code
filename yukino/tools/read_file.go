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
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/images"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

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
				"file_path": map[string]any{"type": "string", "description": "File path, absolute or relative to the Agent's working directory. Supports text and image files."},
				"offset":    map[string]any{"type": "integer", "description": "Number of text lines to skip (0-based). Use 0 for the first line, 100 for displayed line 101. Ignored for images.", "minimum": 0, "default": 0},
				"limit":     map[string]any{"type": "integer", "description": "Maximum number of text lines to return (default 2000), subject to a 50KB output limit. Ignored for images.", "minimum": 1, "default": 2000},
			},
			"required": []string{"file_path"},
		},
	}
}

// maxReadBytes mirrors the TS MAX_READ_BYTES output cap.
const maxReadBytes = 50 * 1024

func (t *ReadFileTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	requestedPath, _ := args["file_path"].(string)
	if requestedPath == "" {
		return ToolResult{Output: "Error: file_path is required", IsError: true}
	}

	filePath := ResolvePath(WorkDirFromContext(ctx), requestedPath)

	info, err := os.Stat(filePath)
	if os.IsNotExist(err) {
		return ToolResult{Output: fmt.Sprintf("Error: file not found: %s", filePath), IsError: true}
	}
	if err != nil {
		return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
	}
	if info.IsDir() {
		return ToolResult{Output: fmt.Sprintf("Error: %s is a directory, not a file. Use Glob to list directory contents.", filePath), IsError: true}
	}

	if images.IsImagePath(filePath) {
		return t.readImage(ctx, filePath, info)
	}

	offset := intArg(args, "offset", 0)
	limit := intArg(args, "limit", 2000)
	if offset < 0 || limit < 1 {
		return ToolResult{Output: "Error: offset must be >= 0 and limit must be >= 1", IsError: true}
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		log.Error("tool operation failed", "err", err)
		return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
	}

	// TS reads with readFileSync(filePath, "utf-8"): Node's WHATWG decoding
	// turns invalid byte runs into U+FFFD (one per maximal subpart) before the
	// line split and the byte-budget accounting.
	lines := strings.Split(decodeUTF8Lenient(data), "\n")
	if offset >= len(lines) {
		return ToolResult{Output: fmt.Sprintf("Error: offset %d is beyond end of file (%d lines total)", offset, len(lines)), IsError: true}
	}

	end := min(offset+limit, len(lines))
	var numbered []string
	outputBytes := 0
	for i := offset; i < end; i++ {
		numberedLine := fmt.Sprintf("%d\t%s", i+1, lines[i])
		lineBytes := len(numberedLine)
		if len(numbered) > 0 {
			lineBytes++ // newline separator
		}
		if outputBytes+lineBytes > maxReadBytes {
			if len(numbered) == 0 {
				return ToolResult{Output: fmt.Sprintf("Error: line %d exceeds the 50KB read limit; use Bash to inspect it in smaller chunks.", i+1), IsError: true}
			}
			break
		}
		numbered = append(numbered, numberedLine)
		outputBytes += lineBytes
	}

	// Re-stat after the read: if the file changed underneath us the cached state
	// would be stale and a following edit could clobber concurrent writes. TS
	// keeps this statSync inside the big try, so a stat failure also lands in
	// the logged "Error reading file:" catch.
	afterRead, err := os.Stat(filePath)
	if err != nil {
		log.Error("tool operation failed", "err", err)
		return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
	}
	if afterRead.ModTime() != info.ModTime() || afterRead.Size() != info.Size() {
		return ToolResult{Output: fmt.Sprintf("Error: %s changed while it was being read; read it again before editing.", filePath), IsError: true}
	}

	// Record file state for read-before-edit enforcement.
	if fsc := ResolveFileStateCache(ctx, t.FileStateCache); fsc != nil {
		fsc.Record(filePath, mtimeMs(info))
	}

	nextOffset := offset + len(numbered)
	remaining := len(lines) - nextOffset
	if remaining > 0 {
		numbered = append(numbered, fmt.Sprintf("[%d more lines in file. Use offset=%d to continue.]", remaining, nextOffset))
	}
	return ToolResult{Output: strings.Join(numbered, "\n")}
}

// readImage mirrors the TS readImage: load + compress the image, verify it did
// not change mid-read, then return a base64 image block alongside a short text
// label. The block flows to the model through ToolResult.ContentBlocks.
func (t *ReadFileTool) readImage(ctx context.Context, filePath string, info os.FileInfo) ToolResult {
	attachment, err := images.LoadImageAttachment(filePath)
	if err != nil {
		log.Error("image read failed", "err", err)
		return ToolResult{Output: fmt.Sprintf("Error reading image %s: %s", filepath.Base(filePath), err), IsError: true}
	}
	afterRead, statErr := os.Stat(filePath)
	if statErr != nil {
		// TS: the post-read statSync sits inside the try block, so a stat
		// failure surfaces as the same image-read error.
		log.Error("image read failed", "err", statErr)
		return ToolResult{Output: fmt.Sprintf("Error reading image %s: %s", filepath.Base(filePath), statErr), IsError: true}
	}
	if afterRead.ModTime() != info.ModTime() || afterRead.Size() != info.Size() {
		return ToolResult{Output: fmt.Sprintf("Error: %s changed while it was being read; read it again before editing.", filePath), IsError: true}
	}
	if fsc := ResolveFileStateCache(ctx, t.FileStateCache); fsc != nil {
		fsc.Record(filePath, mtimeMs(info))
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

// intArg mirrors the TS utils intArg: numbers go through Math.floor, numeric
// strings through Number.parseInt (so "12abc" parses as 12), anything else
// returns the default. Delegates to utils.IntArg, which is the shared port.
func intArg(args map[string]any, key string, def int) int {
	return utils.IntArg(args, key, def)
}

// boolArg mirrors the TS utils boolArg: booleans pass through; without a
// fallback, any non-boolean value goes through JS Boolean() truthiness
// (so replace_all: "yes" is true). Delegates to utils.BoolArg, the shared port.
func boolArg(args map[string]any, key string) bool {
	return utils.BoolArg(args, key)
}

// nonFiniteNumberArg reports whether the raw argument is a non-finite float.
// JSON cannot carry ±Inf/NaN, but in-process callers can inject them; TS's
// `!Number.isFinite(timeout)` check rejects those with the same error as a
// non-positive timeout, whereas int(math.Floor(±Inf)) saturates silently.
func nonFiniteNumberArg(args map[string]any, key string) bool {
	f, ok := args[key].(float64)
	return ok && (math.IsInf(f, 0) || math.IsNaN(f))
}
