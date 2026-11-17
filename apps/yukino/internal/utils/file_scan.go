package utils

import (
	"os"
	"path/filepath"
	"strings"
)

// Shallow workspace file scan shared by the terminal @-mention completion
// and the remote server's browser completion endpoint.
//
// scanSkipDirs mirrors tools.SkipDirs (SKIP_DIRS); duplicated locally because
// tools imports utils (Go import-cycle ban). Scan errors are ignored silently:
// utils cannot import the logger (logger → storage → utils cycle).
var scanSkipDirs = map[string]bool{
	".agents": true, ".git": true, ".yukino": true, ".next": true,
	".venv": true, ".mypy_cache": true, "__pycache__": true, "dist": true,
	"node_modules": true,
}

// ScanCwdFiles lists cwd-relative file paths (max entries, skipping
// hidden/SKIP_DIRS).
func ScanCwdFiles(root string, max int) []string {
	if max <= 0 {
		max = DefaultScanMaxFiles
	}
	var out []string
	visited := 0
	budget := MinScanVisitedBudget
	if max*ScanVisitedBudgetMultiplier > budget {
		budget = max * ScanVisitedBudgetMultiplier
	}
	var walk func(dir, rel string)
	walk = func(dir, rel string) {
		if len(out) >= max || visited >= budget {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if len(out) >= max || visited >= budget {
				return
			}
			visited++
			name := entry.Name()
			if strings.HasPrefix(name, ".") || scanSkipDirs[name] {
				continue
			}
			full := filepath.Join(dir, name)
			relPath := name
			if rel != "" {
				relPath = rel + "/" + name
			}
			info, err := os.Lstat(full)
			if err != nil {
				continue
			}
			isDir := false
			if info.Mode()&os.ModeSymlink != 0 {
				if resolved, err := os.Stat(full); err == nil && resolved.Mode().IsRegular() {
					out = append(out, relPath)
				}
				continue
			}
			if !info.IsDir() && !info.Mode().IsRegular() {
				continue
			}
			isDir = info.IsDir()
			if isDir {
				walk(full, relPath)
			} else {
				out = append(out, relPath)
			}
		}
	}
	walk(root, "")
	return out
}

// FilterFileMatches filters scanned files the way the terminal @-mention
// dropdown does: prefix matches first, then substring matches, capped.
func FilterFileMatches(files []string, query string, limit int) []string {
	if limit <= 0 {
		limit = DefaultFileMatchLimit
	}
	q := strings.ToLower(query)
	if q == "" {
		if len(files) > limit {
			return files[:limit]
		}
		return append([]string(nil), files...)
	}
	var pre, sub []string
	for _, f := range files {
		lower := strings.ToLower(f)
		if strings.HasPrefix(lower, q) {
			pre = append(pre, f)
		} else if strings.Contains(lower, q) {
			sub = append(sub, f)
		}
	}
	combined := append(pre, sub...)
	if len(combined) > limit {
		combined = combined[:limit]
	}
	return combined
}
