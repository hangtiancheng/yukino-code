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
	"os"
	"path/filepath"
	"sync"
)

// FileStateCache tracks which files have been read and their modification
// times, enforcing a "read-before-edit" discipline to prevent blind overwrites.
type FileStateCache struct {
	mu      sync.Mutex
	entries map[string]float64 // path → mtime in milliseconds (TS: mtimeMs float)
}

func NewFileStateCache() *FileStateCache {
	return &FileStateCache{
		entries: make(map[string]float64),
	}
}

// mtimeMs converts a file's modification time to fractional milliseconds with
// the same computation Node uses for stat().mtimeMs (sec*1000 + nsec/1e6 as a
// float64), so sub-millisecond rewrites invalidate the cache exactly like TS.
func mtimeMs(info os.FileInfo) float64 {
	mt := info.ModTime()
	return float64(mt.Unix())*1000 + float64(mt.Nanosecond())/1e6
}

// Record stores the file mtime after a successful read.
func (c *FileStateCache) Record(filePath string, mtime float64) {
	abs := normalizePath(filePath)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[abs] = mtime
}

// Has reports whether the file is tracked in the cache (TS: has).
func (c *FileStateCache) Has(filePath string) bool {
	abs := normalizePath(filePath)
	c.mu.Lock()
	defer c.mu.Unlock()
	_, exists := c.entries[abs]
	return exists
}

// Check verifies that a file has been read and hasn't been modified since.
// Returns (true, "") if OK, or (false, errorMessage) if the edit should be
// blocked. Mirrors the TS check: a stat failure is fail-closed (the file was
// deleted or became inaccessible, so it must be re-read), and any mtime change
// — newer or older, e.g. a git checkout rewinding it — invalidates the read.
func (c *FileStateCache) Check(filePath string) (bool, string) {
	abs := normalizePath(filePath)
	c.mu.Lock()
	cachedMtime, exists := c.entries[abs]
	c.mu.Unlock()

	if !exists {
		return false, "Error: file has not been read yet, read it first before editing."
	}

	info, err := os.Stat(abs)
	if err != nil {
		fileStateCacheLog.Error("file state cache operation failed", "err", err)
		return false, "Error: file was deleted or is no longer accessible; read it again before editing."
	}
	if mtimeMs(info) != cachedMtime {
		return false, "Error: file has been modified since last read, read it again before editing."
	}

	return true, ""
}

// Update refreshes the cache entry after a successful edit or write. If the
// file can no longer be stat'd, the entry is removed so the next edit requires
// a fresh read (TS: update).
func (c *FileStateCache) Update(filePath string) {
	abs := normalizePath(filePath)
	info, err := os.Stat(abs)
	if err != nil {
		// TS logs the stat failure before dropping the entry.
		fileStateCacheLog.Error("file state cache operation failed", "err", err)
		c.mu.Lock()
		delete(c.entries, abs)
		c.mu.Unlock()
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[abs] = mtimeMs(info)
}

func normalizePath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return abs
}
