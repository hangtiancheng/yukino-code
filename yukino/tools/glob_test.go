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
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setupGlobTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := []string{
		"main.go",
		"cmd/cli/main.go",
		"internal/agents/agent.go",
		"internal/agents/agent_test.go",
		"docs/readme.md",
	}
	for _, rel := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestGlobDoubleStarPattern(t *testing.T) {
	// Before the fix, `**/*.go` returned "No files matched the pattern."
	// because filepath.Match doesn't understand `**`. Verify the fix
	// recursively matches .go files at every depth.
	root := setupGlobTree(t)
	tool := &GlobTool{}
	res := tool.Execute(context.Background(), map[string]any{
		"pattern": "**/*.go",
		"path":    root,
	})
	// filepath.Rel returns backslash-separated paths on Windows; normalize to
	// forward slashes before comparing.
	output := strings.ReplaceAll(res.Output, "\\", "/")
	for _, want := range []string{"main.go", "cmd/cli/main.go", "internal/agents/agent.go", "internal/agents/agent_test.go"} {
		if !strings.Contains(output, want) {
			t.Errorf("expected %q in output, got:\n%s", want, output)
		}
	}
	if strings.Contains(res.Output, "readme.md") {
		t.Errorf("readme.md should NOT match **/*.go")
	}
}

func TestGlobPlainPatternStillWorks(t *testing.T) {
	root := setupGlobTree(t)
	tool := &GlobTool{}
	res := tool.Execute(context.Background(), map[string]any{
		"pattern": "*.go",
		"path":    root,
	})
	if res.IsError {
		t.Fatalf("glob errored: %s", res.Output)
	}
	// Plain `*.go` matches only top-level + same base name match at each dir.
	if !strings.Contains(res.Output, "main.go") {
		t.Errorf("plain pattern should still match base names, got:\n%s", res.Output)
	}
}

// A symlink pointing at a file must be returned: node-glob's follow:false only
// prevents descending into symlinked directories (N-4).
func TestGlobKeepsFileSymlinks(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "links"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "links", "target.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "links", "target.txt"), filepath.Join(root, "links", "alias.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	res := (&GlobTool{}).Execute(context.Background(), map[string]any{"pattern": "*.txt", "path": root})
	if !strings.Contains(res.Output, "links/alias.txt") {
		t.Errorf("symlink to a file must match, got:\n%s", res.Output)
	}
}

// TS glob's nodir:true filter only excludes entries whose readdir Dirent says
// directory (glob walker.js matchCheckTest); children are never lstat'd, so
// symlinks to directories and broken symlinks are still EMITTED — while the
// walk never descends into symlinked directories (follow:false).
func TestGlobEmitsDirSymlinksAndBrokenSymlinks(t *testing.T) {
	root := t.TempDir()
	realDir := filepath.Join(root, "realdir")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(realDir, "inner.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realDir, filepath.Join(root, "linkdir")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "nowhere.txt"), filepath.Join(root, "broken.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	res := (&GlobTool{}).Execute(context.Background(), map[string]any{"pattern": "*", "path": root})
	if res.IsError {
		t.Fatalf("glob errored: %s", res.Output)
	}
	lines := strings.Split(res.Output, "\n")
	have := map[string]bool{}
	for _, l := range lines {
		have[strings.TrimSpace(l)] = true
	}
	if !have["linkdir"] {
		t.Errorf("symlink to a directory must be emitted (nodir only filters Dirent directories), got:\n%s", res.Output)
	}
	if !have["broken.txt"] {
		t.Errorf("broken symlink must be emitted (the walk never lstats children), got:\n%s", res.Output)
	}
	// inner.txt under the REAL dir is emitted (matchBase "*" hits any depth);
	// what must not happen is descending INTO the symlinked directory.
	if have["linkdir/inner.txt"] {
		t.Errorf("symlinked directories must not be descended (follow:false), got:\n%s", res.Output)
	}
}

// TS glob's cwd is stat-resolved, so a symlinked root is searched as the
// directory it points at; WalkDir would treat it as a leaf entry.
func TestGlobSearchesSymlinkedRoot(t *testing.T) {
	root := t.TempDir()
	realDir := filepath.Join(root, "real")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(realDir, "x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(realDir, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	res := (&GlobTool{}).Execute(context.Background(), map[string]any{"pattern": "*.txt", "path": link})
	if !strings.Contains(res.Output, "x.txt") {
		t.Errorf("symlinked root must be searched like its target, got:\n%s", res.Output)
	}
}

// An explicitly requested skip directory is searched: TS only filters entries
// below the walk root, so Glob{path: ".git"} must not prune its own root (N-7).
func TestGlobSearchesRequestedSkipDirectory(t *testing.T) {
	root := t.TempDir()
	gitDir := filepath.Join(root, ".git")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "config"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := (&GlobTool{}).Execute(context.Background(), map[string]any{"pattern": "config", "path": gitDir})
	if strings.Contains(res.Output, "No files matched") {
		t.Errorf("explicitly requested skip directory must be searched, got:\n%s", res.Output)
	}
}

// TS prunes via `**/<name>/**` ignore patterns, which also match a bare file
// entry carrying a skip-dir name (glob.ts:45).
func TestGlobSkipsFilesNamedLikeSkipDirs(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "dist"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "keep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := (&GlobTool{}).Execute(context.Background(), map[string]any{"pattern": "*", "path": root})
	if strings.Contains(res.Output, "dist") {
		t.Errorf("a file named like a skip dir must be pruned, got:\n%s", res.Output)
	}
	if !strings.Contains(res.Output, "keep.txt") {
		t.Errorf("regular files must still match, got:\n%s", res.Output)
	}
}

// Equal mtimes are tie-broken with localeCompare semantics (glob.ts:140), not
// byte order: ICU collation sorts "a.txt" before "B.txt" while byte order
// puts "B.txt" (0x42) first.
func TestGlobTieBreakUsesCollation(t *testing.T) {
	root := t.TempDir()
	files := []string{"B.txt", "a.txt"}
	mtime := time.Unix(1700000000, 0)
	for _, name := range files {
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}

	res := (&GlobTool{}).Execute(context.Background(), map[string]any{"pattern": "*.txt", "path": root})
	lines := strings.Split(res.Output, "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 matches, got:\n%s", res.Output)
	}
	if lines[0] != "a.txt" || lines[1] != "B.txt" {
		t.Errorf("collation tie-break must sort a.txt before B.txt, got %v", lines)
	}
}

// Sub-millisecond mtime differences must order results: TS compares float
// mtimeMs, so a 100µs gap is significant where UnixMilli truncation hid it.
func TestGlobSubMillisecondMtimeOrdering(t *testing.T) {
	root := t.TempDir()
	older := filepath.Join(root, "older.txt")
	newer := filepath.Join(root, "newer.txt")
	for _, p := range []string{older, newer} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Unix(1700000000, 0)
	if err := os.Chtimes(older, base, base); err != nil {
		t.Skipf("filesystem does not keep nanosecond mtimes: %v", err)
	}
	if err := os.Chtimes(newer, base, base.Add(100*time.Microsecond)); err != nil {
		t.Skipf("filesystem does not keep nanosecond mtimes: %v", err)
	}
	// Verify the filesystem actually retained the sub-millisecond gap.
	fiOld, err1 := os.Stat(older)
	fiNew, err2 := os.Stat(newer)
	if err1 != nil || err2 != nil || !fiNew.ModTime().After(fiOld.ModTime()) {
		t.Skip("filesystem truncated the sub-millisecond mtime gap")
	}

	res := (&GlobTool{}).Execute(context.Background(), map[string]any{"pattern": "*.txt", "path": root})
	lines := strings.Split(res.Output, "\n")
	if len(lines) != 2 || lines[0] != "newer.txt" {
		t.Errorf("newer.txt (100µs ahead) must sort first, got:\n%s", res.Output)
	}
}
