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
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/tools/go_glob"
)

type GrepTool struct{}

func (t *GrepTool) Name() string { return "Grep" }

func (t *GrepTool) Description() string { return GrepDescription }

func (t *GrepTool) Category() ToolCategory { return CategoryRead }

func (t *GrepTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "Case-insensitive regular expression matched against each line. Escape backslashes in JSON; use ReadFile for surrounding context."},
				"path":    map[string]any{"type": "string", "description": "Directory or file, absolute or relative to the Agent's working directory (default '.'). Narrow the path to reduce output.", "default": "."},
				"include": map[string]any{"type": "string", "description": "Optional filename glob. Bare patterns such as '*.ts' match at any depth; patterns with '/' match paths relative to the Agent's working directory."},
			},
			"required": []string{"pattern"},
		},
	}
}

// grepMaxResults mirrors the TS MAX_RESULTS cap.
const grepMaxResults = 500

// JS regexes keep \w/\d ASCII-only even in u-mode, unlike ripgrep whose
// defaults are Unicode-aware, so TS rewrites them to property-escape
// equivalents before compiling (grep.ts toUnicodePattern) — "\w+" matches
// Chinese text there. RE2 supports the same property escapes, so the rewrite
// is ported for \w/\W/\d/\D. \b/\B are left as RE2's native ASCII boundaries:
// the TS Unicode rewrite needs lookbehind/lookahead, which RE2 does not have
// (documented dialect residual).
const grepWordClass = `\p{L}\p{M}\p{N}_`

var (
	grepTopLevelRewrites = map[byte]string{
		'w': "[" + grepWordClass + "]",
		'W': "[^" + grepWordClass + "]",
		'd': `\p{Nd}`,
		'D': `\P{Nd}`,
	}
	// Inside a character class only \w/\d are expanded (TS IN_CLASS): \b means
	// backspace there and complements cannot be inlined.
	grepInClassRewrites = map[byte]string{
		'w': grepWordClass,
		'd': `\p{Nd}`,
	}
)

// toUnicodePattern ports TS grep.ts toUnicodePattern for the RE2-expressible
// subset. \x{FFFF} hex escapes pass through unchanged — RE2 parses them
// natively, and out-of-range values fail compilation like TS u-mode.
func toUnicodePattern(pattern string) string {
	var out strings.Builder
	inClass := false
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		if ch == '\\' && i+1 < len(pattern) {
			next := pattern[i+1]
			rewrites := grepTopLevelRewrites
			if inClass {
				rewrites = grepInClassRewrites
			}
			if rep, ok := rewrites[next]; ok {
				out.WriteString(rep)
			} else {
				out.WriteByte(ch)
				out.WriteByte(next)
			}
			i++
			continue
		}
		if ch == '[' && !inClass {
			inClass = true
		} else if ch == ']' && inClass {
			inClass = false
		}
		out.WriteByte(ch)
	}
	return out.String()
}

func (t *GrepTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	pattern, _ := args["pattern"].(string)
	if pattern == "" {
		return ToolResult{Output: "Error: pattern is required", IsError: true}
	}

	workDir := WorkDirFromContext(ctx)
	pathArg, _ := args["path"].(string)
	if pathArg == "" {
		pathArg = "."
	}
	searchPath := ResolvePath(workDir, pathArg)
	include, _ := args["include"].(string)

	// Case-insensitive matching with the TS Unicode rewrite (grep.ts:154-169):
	// compile the rewritten pattern first; if the rewrite does not compile,
	// fall back to the original pattern like the TS non-u-mode retry.
	re, err := regexp.Compile("(?i)" + toUnicodePattern(pattern))
	if err != nil {
		re, err = regexp.Compile("(?i)" + pattern)
		if err != nil {
			log.Error("tool operation failed", "err", err)
			return ToolResult{Output: fmt.Sprintf("Error: invalid regex pattern: %s", pattern), IsError: true}
		}
	}

	// include filter (TS: Minimatch dot:true, matchBase:true). Bare patterns
	// match the basename at any depth; patterns with "/" match the
	// workDir-relative path.
	includeMatchBase := include != "" && !strings.Contains(include, "/")
	matchesInclude := func(fullPath string) bool {
		if include == "" {
			return true
		}
		rel := fullPath
		if workDir != "" {
			if r, relErr := filepath.Rel(workDir, fullPath); relErr == nil {
				rel = filepath.ToSlash(r)
			}
		} else {
			rel = filepath.ToSlash(fullPath)
		}
		if includeMatchBase {
			ok, _ := go_glob.Match(include, filepath.Base(rel))
			return ok
		}
		ok, _ := go_glob.Match(include, rel)
		return ok
	}

	var results []string
	searchFile := func(filePath string) {
		data, err := os.ReadFile(filePath)
		if err != nil {
			log.Error("tool operation failed", "err", err)
			return
		}

		// NUL byte in the first 8KB → binary (ripgrep heuristic); skip it.
		head := data
		if len(head) > 8192 {
			head = head[:8192]
		}
		if bytes.IndexByte(head, 0) >= 0 {
			return
		}

		rel := filePath
		if workDir != "" {
			if r, relErr := filepath.Rel(workDir, filePath); relErr == nil {
				rel = filepath.ToSlash(r)
			}
		} else {
			rel = filepath.ToSlash(filePath)
		}

		// TS: buf.toString("utf-8").split("\n") — Node decodes with the
		// WHATWG maximal-subpart rule (one U+FFFD per invalid subpart), a
		// trailing "\n" yields one final empty token, and "\r" stays on the
		// line. bufio.Scanner would strip \r, drop the trailing empty token
		// and cap line length, so split the whole buffer instead.
		lines := strings.Split(decodeUTF8Lenient(data), "\n")
		for i, line := range lines {
			if len(results) >= grepMaxResults {
				break
			}
			if re.MatchString(line) {
				results = append(results, fmt.Sprintf("%s:%d:%s", rel, i+1, line))
			}
		}
	}

	// walk mirrors the TS walk(): readdir failure logs and skips the
	// directory, per-entry lstat failure logs and skips the entry, symlinks
	// are followed to files only (symlinked directories are never descended —
	// that is what makes cycles harmless), and SKIP_DIRS names are skipped
	// before any stat. os.ReadDir follows the symlink of the root itself,
	// exactly like readdir(searchPath) does in TS.
	var walk func(dir string)
	walk = func(dir string) {
		if len(results) >= grepMaxResults {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			log.Error("tool operation failed", "err", err)
			return
		}
		for _, entry := range entries {
			if len(results) >= grepMaxResults {
				return
			}
			if SkipDirs[entry.Name()] {
				continue
			}
			fullPath := filepath.Join(dir, entry.Name())
			info, err := entry.Info()
			if err != nil {
				log.Error("tool operation failed", "err", err)
				continue
			}
			if info.Mode()&os.ModeSymlink != 0 {
				info, err = os.Stat(fullPath)
				if err != nil {
					log.Error("tool operation failed", "err", err)
					continue
				}
			}
			if info.IsDir() {
				walk(fullPath)
			} else if info.Mode().IsRegular() {
				if !matchesInclude(fullPath) {
					continue
				}
				searchFile(fullPath)
			}
		}
	}

	pathInfo, err := os.Stat(searchPath)
	if err != nil {
		log.Error("tool operation failed", "err", err)
		return ToolResult{Output: fmt.Sprintf("Error: %s", err), IsError: true}
	}
	if pathInfo.Mode().IsRegular() {
		// A direct file path is searched without the include filter; `include`
		// only applies while walking a directory (TS: grep.ts walk-only filter,
		// and the tool description says exactly that).
		searchFile(searchPath)
	} else {
		walk(searchPath)
	}

	if len(results) == 0 {
		return ToolResult{Output: "No matches found."}
	}
	output := strings.Join(results, "\n")
	if len(results) >= grepMaxResults {
		output += fmt.Sprintf("\n\n(results truncated at %d matches)", grepMaxResults)
	}
	return ToolResult{Output: output}
}
