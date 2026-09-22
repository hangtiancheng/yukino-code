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

package session

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CleanExpiredSessions deletes session .jsonl files whose last modification
// time is older than maxSessionAgeDays, together with each session's
// tool-results spill directory. Best-effort: failures are logged and skipped
// (TS: cleanExpiredSessions log.error sites). Returns the number of session
// files removed.
//
// ListSessions already drops expired entries opportunistically; this function
// is the explicit sweep (TS: session.cleanExpiredSessions) and additionally
// reclaims the spill directory that ListSessions leaves behind.
func CleanExpiredSessions(workDir string) int {
	dir := sessionsDir(workDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		// TS guards with existsSync (a missing dir silently returns 0) and
		// logs a readdir failure of an existing dir.
		if !os.IsNotExist(err) {
			log.Error("session operation failed", "err", err)
		}
		return 0
	}

	cutoff := time.Now().AddDate(0, 0, -maxSessionAgeDays)
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			log.Error("session operation failed", "err", err)
			continue
		}
		if !info.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
			// TS logs and silently skips if deletion fails.
			log.Error("session operation failed", "err", err)
			continue
		}
		removed++
		// Remove the session's subdirectory in one recursive pass: it holds
		// the tool-results spill files written by spillDir() (TS: rmSync of
		// join(dir, id), recursive), so a single RemoveAll covers both. The
		// TS rmSync failure is a silent noop.
		id := strings.TrimSuffix(e.Name(), ".jsonl")
		_ = os.RemoveAll(filepath.Join(dir, id))
	}
	return removed
}
