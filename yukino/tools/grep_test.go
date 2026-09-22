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
)

func writeGrepFile(t *testing.T, root, rel, content string) string {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// A direct file path is searched regardless of `include`; the filter only
// applies while walking a directory (N-3, TS grep.ts:256-259).
func TestGrepDirectFileSkipsIncludeFilter(t *testing.T) {
	root := t.TempDir()
	file := writeGrepFile(t, root, "a.ts", "needle\n")

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"path":    file,
		"include": "*.py",
	})
	if res.IsError {
		t.Fatalf("grep errored: %s", res.Output)
	}
	if !strings.Contains(res.Output, "needle") {
		t.Errorf("direct file must be searched without the include filter, got:\n%s", res.Output)
	}
}

// The include filter still applies when walking a directory.
func TestGrepDirectoryStillAppliesIncludeFilter(t *testing.T) {
	root := t.TempDir()
	writeGrepFile(t, root, "a.ts", "needle\n")
	writeGrepFile(t, root, "b.py", "needle\n")

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"path":    root,
		"include": "*.py",
	})
	if !strings.Contains(res.Output, "b.py") {
		t.Errorf("included file must match, got:\n%s", res.Output)
	}
	if strings.Contains(res.Output, "a.ts") {
		t.Errorf("non-included file must be skipped during the walk, got:\n%s", res.Output)
	}
}

// A symlinked file is searched but symlinked directories are not descended
// (TS grep.ts:213-223).
func TestGrepFollowsFileSymlinks(t *testing.T) {
	root := t.TempDir()
	target := writeGrepFile(t, root, "target.ts", "needle\n")
	if err := os.Symlink(target, filepath.Join(root, "alias.ts")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"path":    root,
	})
	if !strings.Contains(res.Output, "alias.ts") {
		t.Errorf("symlinked file must be searched, got:\n%s", res.Output)
	}
}

// An explicitly requested skip directory is searched; only entries below the
// walk root are filtered (N-7, TS walks the children of searchPath).
func TestGrepSearchesRequestedSkipDirectory(t *testing.T) {
	root := t.TempDir()
	gitDir := filepath.Join(root, ".git")
	writeGrepFile(t, root, ".git/config", "needle\n")

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"path":    gitDir,
	})
	if res.IsError {
		t.Fatalf("grep errored: %s", res.Output)
	}
	if strings.Contains(res.Output, "No matches found.") {
		t.Errorf("explicitly requested skip directory must be searched, got:\n%s", res.Output)
	}
}

// Skipped directories are still pruned when they are reached from above.
func TestGrepPrunesSkipDirectoriesInWalk(t *testing.T) {
	root := t.TempDir()
	writeGrepFile(t, root, ".git/config", "needle\n")
	writeGrepFile(t, root, "src/main.ts", "needle\n")

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"path":    root,
	})
	if strings.Contains(res.Output, ".git") {
		t.Errorf(".git must be pruned during a normal walk, got:\n%s", res.Output)
	}
	if !strings.Contains(res.Output, "src/main.ts") {
		t.Errorf("regular files must still be searched, got:\n%s", res.Output)
	}
}

// TS skips any entry whose name is in SKIP_DIRS before stat (grep.ts:203) —
// including plain files that happen to carry a skip-dir name.
func TestGrepSkipsFilesNamedLikeSkipDirs(t *testing.T) {
	root := t.TempDir()
	writeGrepFile(t, root, "dist", "needle\n")
	writeGrepFile(t, root, "src/main.ts", "needle\n")

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"path":    root,
	})
	if strings.Contains(res.Output, "dist") {
		t.Errorf("a file named like a skip dir must be skipped, got:\n%s", res.Output)
	}
	if !strings.Contains(res.Output, "src/main.ts") {
		t.Errorf("regular files must still be searched, got:\n%s", res.Output)
	}
}

// TS reads the file and splits on "\n" (grep.ts:242): CRLF lines keep their
// trailing \r in the reported match, and a trailing newline yields a final
// empty token that patterns matching the empty string can hit.
func TestGrepSplitSemanticsMatchTS(t *testing.T) {
	root := t.TempDir()
	writeGrepFile(t, root, "crlf.txt", "needle\r\nsecond\r\n")

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"path":    filepath.Join(root, "crlf.txt"),
	})
	if !strings.Contains(res.Output, "crlf.txt:1:needle\r") {
		t.Errorf("CRLF line must keep its trailing \\r like TS split(\"\\n\"), got:\n%q", res.Output)
	}

	// A pattern matching the empty string hits the phantom final line (4th
	// token of "a\nb\n" split: ["a","b",""]) — TS reports it, scanners don't.
	writeGrepFile(t, root, "empty-tail.txt", "a\nb\n")
	res = (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "^$",
		"path":    filepath.Join(root, "empty-tail.txt"),
	})
	if !strings.Contains(res.Output, "empty-tail.txt:3:") {
		t.Errorf("trailing empty token must be matchable like TS, got:\n%q", res.Output)
	}
}

// TS rewrites \w/\d to Unicode property escapes before compiling
// (grep.ts toUnicodePattern), so "\w+" matches CJK text.
func TestGrepUnicodeWordRewrite(t *testing.T) {
	root := t.TempDir()
	writeGrepFile(t, root, "cjk.txt", "你好世界\n")

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": `\w+`,
		"path":    filepath.Join(root, "cjk.txt"),
	})
	if res.IsError {
		t.Fatalf("grep errored: %s", res.Output)
	}
	if !strings.Contains(res.Output, "cjk.txt:1:你好世界") {
		t.Errorf("\\w must match CJK like the TS Unicode rewrite, got:\n%s", res.Output)
	}
}

// TS decodes file bytes with buf.toString("utf-8"): Node/V8 follow the
// WHATWG maximal-subpart rule (one U+FFFD per invalid subpart). ED A0 80
// (a surrogate encoded as UTF-8) yields THREE replacements, where
// strings.ToValidUTF8 would collapse the run into one.
func TestGrepWhatwgMaximalSubpartDecoding(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "utf8.txt")
	content := append([]byte("a"), 0xED, 0xA0, 0x80)
	content = append(content, 'b', '\n')
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": `a.+b`,
		"path":    path,
	})
	if res.IsError {
		t.Fatalf("grep errored: %s", res.Output)
	}
	want := "utf8.txt:1:a\uFFFD\uFFFD\uFFFDb"
	if !strings.HasSuffix(res.Output, want) {
		t.Errorf("output = %q, want it to end with %q (maximal-subpart rule)", res.Output, want)
	}
}

// A pattern the Unicode rewrite cannot compile falls back to the original
// pattern (TS: the non-u-mode retry), and a hopeless pattern errors with the
// TS wording.
func TestGrepRegexFallbackAndError(t *testing.T) {
	root := t.TempDir()
	writeGrepFile(t, root, "a.txt", "interface{\n")

	res := (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "interface{",
		"path":    root,
	})
	if res.IsError {
		t.Fatalf("literal brace pattern must compile in RE2: %s", res.Output)
	}

	res = (&GrepTool{}).Execute(context.Background(), map[string]any{
		"pattern": "([unclosed",
		"path":    root,
	})
	if !res.IsError || res.Output != "Error: invalid regex pattern: ([unclosed" {
		t.Errorf("expected the TS invalid-pattern error, got: %#v", res)
	}
}
