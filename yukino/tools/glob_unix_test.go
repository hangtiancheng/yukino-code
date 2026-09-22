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

//go:build unix

package tools

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
)

// TS glob's nodir:true walk emits non-regular files too: the Dirent for a
// fifo is not isDirectory(), and the walker never stats children, so it
// passes the filter (glob walker.js matchCheckTest).
func TestGlobEmitsNonRegularFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "regular.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(root, "pipe.fifo"), 0o644); err != nil {
		t.Skipf("fifo creation unavailable: %v", err)
	}

	res := (&GlobTool{}).Execute(context.Background(), map[string]any{"pattern": "*", "path": root})
	if res.IsError {
		t.Fatalf("glob errored: %s", res.Output)
	}
	lines := strings.Split(res.Output, "\n")
	sort.Strings(lines)
	if len(lines) != 2 || lines[0] != "pipe.fifo" || lines[1] != "regular.txt" {
		t.Errorf("the fifo and the regular file must both be emitted, got %v", lines)
	}
}
