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
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// CanonicalPath resolves symlinks even when the final file or some parent
// directories do not exist yet: it walks up until EvalSymlinks succeeds and
// re-appends the missing tail. On unexpected errors (TS throws) it falls
// back to the cleaned absolute path.
func CanonicalPath(path string) string {
	current, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	var missing []string
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			if len(missing) == 0 {
				return resolved
			}
			return filepath.Join(append([]string{resolved}, missing...)...)
		}
		if !isMissingError(err) {
			// TS rethrows non-ENOENT/ENOTDIR errors; Go cannot, so return
			// the best-effort absolute path.
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			abs, _ := filepath.Abs(path)
			return abs
		}
		missing = append([]string{filepath.Base(current)}, missing...)
		current = parent
	}
}

// isMissingError reports whether err is ENOENT or ENOTDIR, the two codes
// the TS canonicalPath retry loop tolerates.
func isMissingError(err error) bool {
	var pathErr *os.PathError
	if !errors.As(err, &pathErr) {
		return false
	}
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ENOTDIR)
}

// IsPathWithin reports whether path is root itself or located under root.
// The check is purely lexical (filepath.Rel), mirroring the TS original.
func IsPathWithin(root, path string) bool {
	child, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return child != ".." &&
		!strings.HasPrefix(child, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(child)
}

// CompactPath replaces the home directory prefix with "~" for display.
func CompactPath(path string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	if path == home {
		return "~"
	}
	if strings.HasPrefix(path, home+string(filepath.Separator)) {
		return "~/" + path[len(home)+1:]
	}
	return path
}
