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
	"path/filepath"
	"sync"
)

// pathQueue serializes mutations for one canonical path. waiters is guarded by
// fileQueuesMu and counts goroutines that have claimed this queue but not yet
// finished; the queue is dropped from the map when the count hits zero so the
// map does not grow without bound.
type pathQueue struct {
	mu      sync.Mutex
	waiters int
}

var (
	fileQueuesMu sync.Mutex
	fileQueues   = make(map[string]*pathQueue)
)

// canonicalPath resolves filePath to an absolute, symlink-free key so that
// different spellings of the same file share one queue. Falls back to the
// parent directory's real path (for files that do not exist yet) and finally
// to the plain absolute path.
func canonicalPath(filePath string) string {
	absolutePath, err := filepath.Abs(filePath)
	if err != nil {
		absolutePath = filePath
	}
	if resolved, err := filepath.EvalSymlinks(absolutePath); err == nil {
		return resolved
	}
	if resolvedDir, err := filepath.EvalSymlinks(filepath.Dir(absolutePath)); err == nil {
		return filepath.Join(resolvedDir, filepath.Base(absolutePath))
	}
	return absolutePath
}

// withFileMutationQueue serializes mutations targeting the same resolved path.
// Operations on different paths run concurrently.
func withFileMutationQueue(filePath string, operation func() ToolResult) ToolResult {
	key := canonicalPath(filePath)

	fileQueuesMu.Lock()
	q := fileQueues[key]
	if q == nil {
		q = &pathQueue{}
		fileQueues[key] = q
	}
	q.waiters++
	fileQueuesMu.Unlock()

	q.mu.Lock()
	defer func() {
		q.mu.Unlock()
		fileQueuesMu.Lock()
		q.waiters--
		if q.waiters == 0 {
			delete(fileQueues, key)
		}
		fileQueuesMu.Unlock()
	}()
	return operation()
}
