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
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// MemoryHeader is one scanned memory file's metadata (TS manager.ts:103-111).
type MemoryHeader struct {
	Filename    string // path relative to memoryDir
	FilePath    string // absolute path
	Scope       string // "user" or "project"; empty for callers that don't care
	MtimeMs     int64  // modification time, ms since epoch
	Description string // frontmatter description; "" if absent
	Type        string // frontmatter type; defaults to "reference"
}

// MaxMemoryFiles caps the number of memories surfaced to the model
// (TS manager.ts:457 slices scanned headers at MAX_ENTRYPOINT_LINES).
const MaxMemoryFiles = 200

// ScanMemoryFiles scans a memory directory's TOP LEVEL for .md files
// (TS manager.ts:425-458 uses readdirSync — subdirectories are not
// traversed), reads their frontmatter, and returns a header list sorted
// newest-first (capped at MaxMemoryFiles). Shared by FindRelevantMemories
// (query-time recall) and the extraction manifest.
//
// Files are read sequentially in directory order, then stable-sorted by
// mtime — the same order TS's synchronous scan + stable sort produces, so
// equal-mtime ties keep the scan order deterministically. Per-file errors
// are dropped (a file that won't open shouldn't tank the whole scan) and
// logged once per fingerprint change.
func ScanMemoryFiles(ctx context.Context, memoryDir string, scope string) ([]MemoryHeader, error) {
	// TS: existsSync(dir) guard returns [] silently; readdir failures log.
	if _, err := os.Stat(memoryDir); err != nil {
		return nil, nil
	}
	entries, err := os.ReadDir(memoryDir)
	if err != nil {
		log.Error("memory operation failed", "err", err, "path", memoryDir)
		return nil, nil
	}
	var mdFiles []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".md") || name == AutoMemEntrypointName {
			continue
		}
		mdFiles = append(mdFiles, filepath.Join(memoryDir, name))
	}

	results := make([]MemoryHeader, 0, len(mdFiles))
	for _, filePath := range mdFiles {
		if err := ctx.Err(); err != nil {
			break
		}
		hdr, ok := readMemoryHeader(filePath, memoryDir)
		if !ok {
			continue
		}
		hdr.Scope = scope
		results = append(results, hdr)
	}

	// Stable sort mirrors TS sort stability for equal mtimes.
	sort.SliceStable(results, func(i, j int) bool {
		return results[i].MtimeMs > results[j].MtimeMs
	})
	if len(results) > MaxMemoryFiles {
		results = results[:MaxMemoryFiles]
	}
	return results, nil
}

// readMemoryHeader parses one file into a MemoryHeader (TS
// manager.ts:441-453 — same full readMemory parse, so malformed
// frontmatter excludes the file here too).
func readMemoryHeader(filePath, memoryDir string) (MemoryHeader, bool) {
	mf, mtimeMs, ok := readMemoryFile(filePath)
	if !ok {
		return MemoryHeader{}, false
	}
	rel, err := filepath.Rel(memoryDir, filePath)
	if err != nil || rel == "" {
		rel = filepath.Base(filePath)
	}
	return MemoryHeader{
		Filename:    rel,
		FilePath:    filePath,
		MtimeMs:     mtimeMs,
		Description: mf.Description,
		Type:        mf.Type,
	}, true
}

// FormatMemoryManifest formats memory headers as a text manifest: one
// line per file with [scope] [type] path (timestamp): description
// (TS manager.ts:487-509). Used by the recall selector prompt.
func FormatMemoryManifest(memories []MemoryHeader) string {
	if len(memories) == 0 {
		return ""
	}
	var b strings.Builder
	for i, m := range memories {
		if i > 0 {
			b.WriteByte('\n')
		}
		var tag string
		if m.Type != "" {
			tag = fmt.Sprintf("[%s] ", m.Type)
		}
		var scope string
		if m.Scope != "" {
			scope = fmt.Sprintf("[%s-scope] ", m.Scope)
		}
		ts := time.UnixMilli(m.MtimeMs).UTC().Format("2006-01-02T15:04:05.000Z")
		path := m.FilePath
		if path == "" {
			path = m.Filename
		}
		if m.Description != "" {
			fmt.Fprintf(&b, "- %s%s%s (%s): %s", scope, tag, path, ts, m.Description)
		} else {
			fmt.Fprintf(&b, "- %s%s%s (%s)", scope, tag, path, ts)
		}
	}
	return b.String()
}
