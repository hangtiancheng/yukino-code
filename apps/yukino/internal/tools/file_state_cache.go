package tools

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

type FileStateCache struct {
	mu      sync.Mutex
	entries map[string]int64
}

func NewFileStateCache() *FileStateCache {
	return &FileStateCache{
		entries: make(map[string]int64),
	}
}

func (c *FileStateCache) Record(filePath string, mtime int64) {
	abs := normalizePath(filePath)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[abs] = mtime
}

func (c *FileStateCache) Check(filePath string) (bool, string) {
	abs := normalizePath(filePath)
	c.mu.Lock()
	cachedMtime, exists := c.entries[abs]
	c.mu.Unlock()

	if !exists {
		return false, FileNotReadError
	}

	info, err := os.Stat(abs)
	if err != nil {
		return false, FileDeletedError
	}
	currentMtime := info.ModTime().UnixMilli()
	if currentMtime != cachedMtime {
		return false, FileModifiedError
	}

	return true, ""
}

func (c *FileStateCache) Update(filePath string) {
	abs := normalizePath(filePath)
	info, err := os.Stat(abs)
	if err != nil {
		c.Delete(abs)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[abs] = info.ModTime().UnixMilli()
}

func normalizePath(p string) string {
	if canonical, err := utils.CanonicalPath(p, 0); err == nil {
		return canonical
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return abs
}

func (c *FileStateCache) Has(path string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.entries[normalizePath(path)]
	return ok
}

func (c *FileStateCache) Delete(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, normalizePath(path))
}

func (c *FileStateCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	clear(c.entries)
}
