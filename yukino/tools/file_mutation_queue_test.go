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
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestWithFileMutationQueueSerializesSamePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")

	var mu sync.Mutex
	running, maxRunning, completed := 0, 0, 0
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result := withFileMutationQueue(path, func() ToolResult {
				mu.Lock()
				running++
				if running > maxRunning {
					maxRunning = running
				}
				mu.Unlock()

				time.Sleep(2 * time.Millisecond)

				mu.Lock()
				running--
				completed++
				mu.Unlock()
				return ToolResult{Output: "done"}
			})
			if result.Output != "done" {
				t.Errorf("operation result = %+v", result)
			}
		}()
	}
	wg.Wait()

	if maxRunning != 1 {
		t.Errorf("max concurrent operations on one path = %d, want 1", maxRunning)
	}
	if completed != 8 {
		t.Errorf("completed = %d, want 8", completed)
	}

	fileQueuesMu.Lock()
	leaked := len(fileQueues)
	fileQueuesMu.Unlock()
	if leaked != 0 {
		t.Errorf("queue map leaked %d entries after all operations finished", leaked)
	}
}

func TestWithFileMutationQueueDifferentPathsRunConcurrently(t *testing.T) {
	dir := t.TempDir()
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan struct{}, 2)

	for i := range 2 {
		go func(i int) {
			withFileMutationQueue(filepath.Join(dir, fmt.Sprintf("f%d.txt", i)), func() ToolResult {
				started <- struct{}{}
				<-release
				done <- struct{}{}
				return ToolResult{}
			})
		}(i)
	}

	// If the two paths shared a queue, the second operation could not start
	// before the first released it and this would time out.
	for range 2 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("operations on different paths did not run concurrently")
		}
	}
	close(release)
	for range 2 {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("operation did not finish after release")
		}
	}
}

func TestCanonicalPathResolvesSymlinksAndRelatives(t *testing.T) {
	dir := t.TempDir()
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	aliasDir := filepath.Join(dir, "alias")
	if err := os.Symlink(realDir, aliasDir); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	real := canonicalPath(filepath.Join(realDir, "file.txt"))
	alias := canonicalPath(filepath.Join(aliasDir, "file.txt"))
	if real != alias {
		t.Errorf("symlink alias resolved differently:\n%s\n%s", real, alias)
	}

	// A nonexistent file still resolves against the real parent directory.
	if got := canonicalPath(filepath.Join(aliasDir, "missing.txt")); got != filepath.Join(filepath.Dir(real), "missing.txt") {
		t.Errorf("canonicalPath(missing) = %s", got)
	}

	// Relative paths resolve against the working directory.
	if got := canonicalPath("relative-file.txt"); filepath.IsAbs(got) == false {
		t.Errorf("canonicalPath(relative) = %s, want absolute", got)
	}
}
