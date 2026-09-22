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
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// MaxIncludeDepth is the maximum nesting depth for @include directives.
const MaxIncludeDepth = 5

// InstructionSource is one loaded instruction file.
type InstructionSource struct {
	Path    string
	Content string
}

// LoadInstructions discovers and concatenates project & user instruction files.
//
// Discovery order (each later layer is appended later, so model attention prioritises it):
//  1. User global: ~/.yukino/AGENTS.md
//  2. Project: walk from git root down to workDir, picking up AGENTS.md and
//     .yukino/AGENTS.md in each directory (so the file closest to cwd wins)
//
// @-include directives:
//   - @./relative/path, @~/home/path, or @/absolute/path
//   - Resolved relative to the including file's directory
//   - Skipped inside fenced code blocks
//   - Cycle-safe (same absolute path is never included twice)
func LoadInstructions(workDir string) string {
	sources := DiscoverInstructions(workDir)
	if len(sources) == 0 {
		return ""
	}
	var parts []string
	for _, s := range sources {
		// Prefer relative paths as labels for better readability.
		label := s.Path
		rel, err := filepath.Rel(workDir, s.Path)
		if err != nil {
			log.Error("memory operation failed", "err", err)
			// Fallback to absolute path
		} else if !strings.HasPrefix(rel, "..") {
			label = rel
		}
		parts = append(parts, fmt.Sprintf("Contents of %s:\n\n%s", label, strings.TrimRight(s.Content, "\n")))
	}
	return strings.Join(parts, "\n\n---\n\n")
}

// DiscoverInstructions returns the loaded source files in priority order
// (lowest priority first). Used by LoadInstructions and exposed for tests.
func DiscoverInstructions(workDir string) []InstructionSource {
	var sources []InstructionSource
	seen := map[string]bool{}

	// Determine project root for @include path boundary checks
	absWorkDir, _ := filepath.Abs(workDir)
	projectRoot := findGitRoot(absWorkDir)
	if projectRoot == "" {
		projectRoot = absWorkDir
	}

	if home, err := os.UserHomeDir(); err == nil {
		add(&sources, seen, filepath.Join(home, ".yukino", "AGENTS.md"), projectRoot)
	} else {
		// Skip if $HOME is unavailable (TS logs and continues).
		log.Error("memory operation failed", "err", err)
	}
	for _, dir := range projectInstructionDirs(workDir) {
		add(&sources, seen, filepath.Join(dir, "AGENTS.md"), projectRoot)
		// Same-named file under .yukino/: for projects that want instructions in .gitignore
		add(&sources, seen, filepath.Join(dir, ".yukino", "AGENTS.md"), projectRoot)
	}
	return sources
}

func add(out *[]InstructionSource, seen map[string]bool, path, projectRoot string) {
	abs, err := filepath.Abs(path)
	if err != nil {
		log.Error("memory operation failed", "err", err)
		return
	}
	if seen[abs] {
		return
	}
	// TS checks existsSync before reading: a missing file is skipped silently,
	// while a file that exists but fails to read logs.
	if _, err := os.Stat(abs); err != nil {
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		log.Error("memory operation failed", "err", err)
		return
	}
	seen[abs] = true
	content := expandIncludes(string(data), filepath.Dir(abs), projectRoot, seen, 0)
	*out = append(*out, InstructionSource{Path: abs, Content: content})
}

// expandIncludes expands @include directives. projectRoot is used for boundary checks
// to prevent escaping to arbitrary locations outside the project directory via ../.
//
// Line handling mirrors TS exactly: the content is split on "\n" and the
// output lines are joined back with "\n", so a file without a trailing
// newline stays without one and CRLF files keep their "\r" line endings.
func expandIncludes(content, baseDir, projectRoot string, seen map[string]bool, depth int) string {
	if depth > MaxIncludeDepth {
		return content
	}
	lines := strings.Split(content, "\n")
	out := make([]string, 0, len(lines))
	inCode := false
	for _, line := range lines {
		// TS line.trim() uses the JS whitespace set (U+FEFF included, U+0085
		// excluded), so an include line guarded by a BOM still expands.
		trimmed := trimJSSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inCode = !inCode
			out = append(out, line)
			continue
		}
		if !inCode {
			if includePath := parseInclude(trimmed); includePath != "" {
				resolved := resolveInclude(includePath, baseDir)
				if resolved != "" {
					abs, err := filepath.Abs(resolved)
					if err != nil {
						log.Error("memory operation failed", "err", err)
						out = append(out, line)
						continue
					}
					if !seen[abs] {
						// @include path boundary check: do not allow escaping outside project and user home
						if !isIncludeAllowed(abs, projectRoot) {
							out = append(out, "<!-- @include skipped: path outside project -->")
							continue
						}
						data, err := os.ReadFile(abs)
						if err == nil {
							seen[abs] = true
							out = append(out, fmt.Sprintf("<!-- included from %s -->", includePath))
							out = append(out, expandIncludes(string(data), filepath.Dir(abs), projectRoot, seen, depth+1))
							continue
						}
						// On read failure, keep the original line visible to the user
						log.Error("memory operation failed", "err", err)
					}
				}
				// Unresolvable or already included; keep the original line
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// isIncludeAllowed checks whether the resolved absolute path of an @include is within the allowed scope.
// Allowed scope: the project directory (projectRoot) and its subdirectories, as well as .yukino/ under the user's home directory.
// This prevents arbitrary path traversal via @../../etc/passwd and similar patterns.
func isIncludeAllowed(absPath, projectRoot string) bool {
	// Paths within the project directory are always allowed
	if projectRoot != "" && strings.HasPrefix(absPath, projectRoot+string(filepath.Separator)) {
		return true
	}
	if absPath == projectRoot {
		return true
	}
	// .yukino/ under user home is also allowed (global instruction file includes)
	if home, err := os.UserHomeDir(); err == nil {
		yukinoDir := filepath.Join(home, ".yukino")
		if strings.HasPrefix(absPath, yukinoDir+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// isJSSpace mirrors the JS \s class (ECMA-262 WhiteSpace + LineTerminator):
// the Unicode space separators plus TAB/LF/VT/FF/CR, NBSP and U+FEFF — but
// NOT U+0085 (NEL), which unicode.IsSpace includes and JS \s does not. It is
// the predicate behind String.prototype.trim and the \s regex class.
func isJSSpace(r rune) bool {
	return r == 0xFEFF || (unicode.IsSpace(r) && r != 0x85)
}

// trimJSSpace mirrors String.prototype.trim, which strips the JS \s set.
func trimJSSpace(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

// parseInclude returns the include path for a line of the form
// "@./path", "@~/path", or "@/abs/path", else "". Other @-tokens (e.g.
// @username) are ignored to avoid false positives.
func parseInclude(trimmed string) string {
	if !strings.HasPrefix(trimmed, "@") || strings.HasPrefix(trimmed, "@@") {
		return ""
	}
	rest := strings.TrimPrefix(trimmed, "@")
	if rest == "" {
		return ""
	}
	// Cannot contain whitespace (excludes cases like @username); TS tests
	// against the JS \s class, which includes U+FEFF (TS instructions.ts:220).
	if strings.IndexFunc(rest, isJSSpace) >= 0 {
		return ""
	}
	switch {
	case strings.HasPrefix(rest, "./"), strings.HasPrefix(rest, "../"),
		strings.HasPrefix(rest, "~/"), strings.HasPrefix(rest, "/"):
		return rest
	}
	return ""
}

func resolveInclude(p, baseDir string) string {
	if strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			log.Error("memory operation failed", "err", err)
			return ""
		}
		return filepath.Join(home, p[2:])
	}
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(baseDir, p)
}

// projectInstructionDirs returns directories from git root down to workDir.
// If workDir is not inside a git repo, only [workDir] is returned.
func projectInstructionDirs(workDir string) []string {
	abs, err := filepath.Abs(workDir)
	if err != nil {
		log.Error("memory operation failed", "err", err)
		return []string{workDir}
	}
	root := findGitRoot(abs)
	if root == "" {
		return []string{abs}
	}
	var dirs []string
	cur := abs
	for {
		dirs = append([]string{cur}, dirs...)
		if cur == root {
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return dirs
}

func findGitRoot(start string) string {
	cur := start
	for {
		if info, err := os.Stat(filepath.Join(cur, ".git")); err == nil {
			_ = info
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return ""
		}
		cur = parent
	}
}
