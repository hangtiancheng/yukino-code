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
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/hangtiancheng/yukino-code/yukino/tools/go_glob"
)

type GlobTool struct{}

func (t *GlobTool) Name() string { return "Glob" }

func (t *GlobTool) Description() string { return GlobDescription }

func (t *GlobTool) Category() ToolCategory { return CategoryRead }

func (t *GlobTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "Filename glob relative to path, e.g. '**/*.ts' for recursive search or '*.{ts,tsx}' for direct children."},
				"path":    map[string]any{"type": "string", "description": "Search base, absolute or relative to the Agent's working directory (default '.'). Returned filenames are relative to this base.", "default": "."},
			},
			"required": []string{"pattern"},
		},
	}
}

// globMaxResults mirrors the TS maxResults cap.
const globMaxResults = 1000

func (t *GlobTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	pattern, _ := args["pattern"].(string)
	if pattern == "" {
		return ToolResult{Output: "Error: pattern is required", IsError: true}
	}

	pathArg, _ := args["path"].(string)
	if pathArg == "" {
		pathArg = "."
	}
	basePath := ResolvePath(WorkDirFromContext(ctx), pathArg)

	info, err := os.Stat(basePath)
	if err != nil || !info.IsDir() {
		return ToolResult{Output: fmt.Sprintf("Error: not a directory, scan '%s'", basePath), IsError: true}
	}

	// matchBase semantics (TS glob matchBase:true): patterns without "/" match
	// the basename at any depth; patterns with "/" match the base-relative path.
	matchBase := !strings.Contains(pattern, "/")

	// TS glob's cwd is stat-resolved (`statSync(basePath)` follows symlinks),
	// and its readdir descends a symlinked root; filepath.WalkDir lstats the
	// root and would treat a symlinked directory as a single leaf entry, so
	// walk the resolved root instead. Relative results are unaffected (they
	// are computed against the walk root either way).
	walkRoot := basePath
	if resolved, resolveErr := filepath.EvalSymlinks(basePath); resolveErr == nil {
		walkRoot = resolved
	}

	var matches []string
	walkErr := filepath.WalkDir(walkRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		// TS prunes via the `**/<name>/**` ignore patterns (glob.ts:45), which
		// match a bare entry of that name too — so any entry, file or
		// directory, whose name is in SKIP_DIRS is skipped. Only the walk root
		// itself is exempt: an explicitly requested skip directory is what the
		// caller asked for (ignore patterns match cwd-relative paths).
		if path != walkRoot && SkipDirs[d.Name()] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		// nodir:true + follow:false — glob's walker filters ONLY entries whose
		// readdir Dirent says directory (glob walker.js matchCheckTest); it
		// never lstats children, so file symlinks, symlinks to directories
		// (not descended), broken symlinks and non-regular files (fifo,
		// socket, device) are all emitted.
		if len(matches) >= globMaxResults {
			return filepath.SkipAll
		}
		rel, relErr := filepath.Rel(walkRoot, path)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		var matched bool
		if matchBase {
			matched, _ = go_glob.Match(pattern, filepath.Base(rel))
		} else {
			matched, _ = go_glob.Match(pattern, rel)
		}
		if matched {
			matches = append(matches, rel)
		}
		return nil
	})
	if walkErr != nil {
		log.Error("tool operation failed", "err", walkErr)
		return ToolResult{Output: fmt.Sprintf("Error: %s", walkErr), IsError: true}
	}

	if len(matches) == 0 {
		return ToolResult{Output: "No files matched the pattern."}
	}

	// Sort by modification time descending — most recently modified first —
	// with the name as tie-break (TS: mtime desc || localeCompare). mtimeMs is
	// computed exactly like Node's statSync().mtimeMs (sec*1000 + nsec/1e6);
	// float64(UnixNano)/1e6 would round through a 256ns grid instead.
	// localeCompare is ICU collation, approximated with the root-locale
	// collator. A failed stat sorts as oldest (mtime 0), like TS.
	collator := collate.New(language.Und)
	type entry struct {
		name  string
		mtime float64
	}
	entries := make([]entry, len(matches))
	for i, m := range matches {
		var mtime float64
		if fi, err := os.Stat(filepath.Join(basePath, m)); err == nil {
			mtime = mtimeMs(fi)
		}
		entries[i] = entry{name: m, mtime: mtime}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].mtime != entries[j].mtime {
			return entries[i].mtime > entries[j].mtime
		}
		return collator.CompareString(entries[i].name, entries[j].name) < 0
	})
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.name
	}

	output := strings.Join(names, "\n")
	if len(names) >= globMaxResults {
		output += fmt.Sprintf("\n(Results limited to %d files. Use a more specific pattern.)", globMaxResults)
	}
	return ToolResult{Output: output}
}
