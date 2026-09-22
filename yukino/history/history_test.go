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

package history

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fileLines(t *testing.T, dir string) int {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, filename))
	if err != nil {
		t.Fatalf("read history file: %v", err)
	}
	return len(strings.Split(strings.TrimSpace(string(raw)), "\n"))
}

// TestAppendKeepsBounded mirrors the TS test: 250 appends keep both the
// return value and the file at MaxHistoryEntries.
func TestAppendKeepsBounded(t *testing.T) {
	dir := t.TempDir()
	var retained []string
	for i := 0; i < 250; i++ {
		retained = Append(dir, fmt.Sprintf("prompt-%d", i))
	}
	if len(retained) != MaxHistoryEntries {
		t.Fatalf("retained len = %d, want %d", len(retained), MaxHistoryEntries)
	}
	if retained[0] != "prompt-50" || retained[len(retained)-1] != "prompt-249" {
		t.Errorf("retained window = [%s .. %s], want [prompt-50 .. prompt-249]",
			retained[0], retained[len(retained)-1])
	}
	if got := Load(dir); !reflect.DeepEqual(got, retained) {
		t.Errorf("Load() differs from retained (len %d vs %d)", len(got), len(retained))
	}
	if n := fileLines(t, dir); n != MaxHistoryEntries {
		t.Errorf("file lines = %d, want %d", n, MaxHistoryEntries)
	}
}

// TestLoadFiltersMalformed mirrors the TS test: bad JSON, empty text and
// non-string text lines are dropped.
func TestLoadFiltersMalformed(t *testing.T) {
	dir := t.TempDir()
	lines := []string{
		`{"text":"first"}`,
		"not-json",
		`{"text":""}`,
		`{"text":123}`,
		`{"other":1}`,
		`{"text":"last","extra":"kept loose"}`,
	}
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	want := []string{"first", "last"}
	if got := Load(dir); !reflect.DeepEqual(got, want) {
		t.Errorf("Load() = %v, want %v", got, want)
	}
}

// TestAppendDedupesAndRewritesLegacy mirrors the TS test: appending the
// latest entry is a no-op content-wise but rewrites oversized legacy files.
func TestAppendDedupesAndRewritesLegacy(t *testing.T) {
	dir := t.TempDir()
	var legacy []string
	for i := 0; i < 250; i++ {
		legacy = append(legacy, fmt.Sprintf(`{"text":"prompt-%d"}`, i))
	}
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(strings.Join(legacy, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	retained := Append(dir, "prompt-249")
	if len(retained) != MaxHistoryEntries {
		t.Fatalf("retained len = %d, want %d", len(retained), MaxHistoryEntries)
	}
	if retained[len(retained)-1] != "prompt-249" {
		t.Errorf("last = %q, want prompt-249", retained[len(retained)-1])
	}
	if retained[len(retained)-2] == "prompt-249" {
		t.Error("duplicate of the latest entry must not be appended")
	}
	if n := fileLines(t, dir); n != MaxHistoryEntries {
		t.Errorf("file lines = %d, want %d", n, MaxHistoryEntries)
	}
}

func TestAppendDedupesLatestOnly(t *testing.T) {
	dir := t.TempDir()
	Append(dir, "a")
	Append(dir, "a") // duplicate of latest: skipped
	retained := Append(dir, "b")
	want := []string{"a", "b"}
	if !reflect.DeepEqual(retained, want) {
		t.Errorf("retained = %v, want %v", retained, want)
	}
	// Non-adjacent duplicates are kept.
	retained = Append(dir, "a")
	want = []string{"a", "b", "a"}
	if !reflect.DeepEqual(retained, want) {
		t.Errorf("retained = %v, want %v", retained, want)
	}
}

func TestLoadMissingAndEmpty(t *testing.T) {
	if got := Load(filepath.Join(t.TempDir(), "nope")); len(got) != 0 {
		t.Errorf("Load(missing) = %v, want empty", got)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := Load(dir); len(got) != 0 {
		t.Errorf("Load(empty) = %v, want empty", got)
	}
}

func TestAppendCreatesDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "deep")
	retained := Append(dir, "first")
	if len(retained) != 1 || retained[0] != "first" {
		t.Errorf("retained = %v", retained)
	}
	if got := Load(dir); !reflect.DeepEqual(got, []string{"first"}) {
		t.Errorf("Load() = %v", got)
	}
}
