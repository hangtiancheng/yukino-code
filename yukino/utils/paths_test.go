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

package utils

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// realTempDir returns the symlink-resolved temp dir (macOS /var -> /private/var).
func realTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", dir, err)
	}
	return resolved
}

func TestCanonicalPath(t *testing.T) {
	real := realTempDir(t)

	t.Run("existing file resolves", func(t *testing.T) {
		file := filepath.Join(real, "f.txt")
		if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := CanonicalPath(file); got != file {
			t.Errorf("CanonicalPath(existing) = %q, want %q", got, file)
		}
	})

	t.Run("missing tail under symlinked parent resolves", func(t *testing.T) {
		target := filepath.Join(real, "target")
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(real, "link")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(target, "a", "b")
		if got := CanonicalPath(filepath.Join(link, "a", "b")); got != want {
			t.Errorf("CanonicalPath(symlink/missing) = %q, want %q", got, want)
		}
	})

	t.Run("fully missing path stays absolute", func(t *testing.T) {
		want := filepath.Join(real, "does", "not", "exist")
		if got := CanonicalPath(want); got != want {
			t.Errorf("CanonicalPath(missing) = %q, want %q", got, want)
		}
	})

	t.Run("relative path is made absolute", func(t *testing.T) {
		wd, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		resolvedWd, err := filepath.EvalSymlinks(wd)
		if err != nil {
			t.Fatal(err)
		}
		if got := CanonicalPath("sub/dir"); got != filepath.Join(resolvedWd, "sub/dir") {
			t.Errorf("CanonicalPath(relative) = %q", got)
		}
	})
}

func TestIsPathWithin(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "root")
	tests := []struct {
		name string
		path string
		want bool
	}{
		{"root itself", root, true},
		{"child", filepath.Join(root, "a"), true},
		{"deep child", filepath.Join(root, "a", "b", "c"), true},
		{"dot resolves to root", filepath.Join(root, "."), true},
		{"parent escape", filepath.Join(root, ".."), false},
		{"grandparent escape", filepath.Join(root, "..", ".."), false},
		{"sibling", root + "-other", false},
		{"escape via subdir", filepath.Join(root, "a", "..", ".."), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsPathWithin(root, tt.path); got != tt.want {
				t.Errorf("IsPathWithin(%q, %q) = %v, want %v", root, tt.path, got, tt.want)
			}
		})
	}
}

func TestCompactPath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("no home directory available")
	}
	tests := []struct {
		path string
		want string
	}{
		{home, "~"},
		{home + string(filepath.Separator) + "proj", "~" + string(filepath.Separator) + "proj"},
		{filepath.Join(home, "a", "b"), "~/a/b"},
		{"/other/path", "/other/path"},
		{home + "-suffix", home + "-suffix"},
	}
	for _, tt := range tests {
		if got := CompactPath(tt.path); got != tt.want {
			t.Errorf("CompactPath(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestRandomVerbs(t *testing.T) {
	for i := 0; i < 50; i++ {
		v := RandomVerb()
		if !contains(spinnerVerbs, v) {
			t.Fatalf("RandomVerb() = %q, not in spinnerVerbs", v)
		}
		c := RandomCompletionVerb()
		if !contains(completionVerbs, c) {
			t.Fatalf("RandomCompletionVerb() = %q, not in completionVerbs", c)
		}
	}
}

func TestVerbListsMatchTS(t *testing.T) {
	// Spot-check list sizes and boundary entries against src/utils/verbs.ts.
	if len(spinnerVerbs) != 104 {
		t.Errorf("spinnerVerbs len = %d, want 104", len(spinnerVerbs))
	}
	if len(completionVerbs) != 20 {
		t.Errorf("completionVerbs len = %d, want 20", len(completionVerbs))
	}
	for _, want := range []string{"Accomplishing", "Be-bopping'", "Flambéing", "Zigzagging"} {
		if !contains(spinnerVerbs, want) {
			t.Errorf("spinnerVerbs missing %q", want)
		}
	}
	for _, v := range spinnerVerbs {
		if strings.TrimSpace(v) != v {
			t.Errorf("spinnerVerbs entry %q has stray whitespace", v)
		}
	}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
