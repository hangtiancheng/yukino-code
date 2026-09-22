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

package consolidation

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
	"unicode"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

var log = logger.CreateChildLogger("memory")

const lockFileName = ".consolidate-lock"

// holderStaleMs is the maximum lock hold time; after this, the lock is considered expired even if the PID is still alive (prevents PID reuse)
const holderStaleMs = 60 * 60 * 1000

func lockPath(memoryDir string) string {
	return filepath.Join(memoryDir, lockFileName)
}

// ReadLastConsolidatedAt returns the timestamp of the last consolidation completion (lock file mtime).
// Returns 0 if the lock file does not exist or cannot be stat'ed — TS
// consolidation.ts:190-200 never throws here: existsSync is false for any
// stat error (including EPERM) and the statSync catch also yields 0, so an
// unreadable lock reads as "never consolidated" and the time gate passes.
// Cost per check: one stat call.
func ReadLastConsolidatedAt(memoryDir string) int64 {
	info, err := os.Stat(lockPath(memoryDir))
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}

// TryAcquireLock attempts to acquire the consolidation lock. On success returns the prior mtime
// (for rollback on failure); on failure returns -1 (another process holds it).
//
// Acquisition flow (TS consolidation.ts:205-243):
//  1. Read the lock file's mtime and PID. A read failure logs and leaves the
//     holder PID unknown — TS treats that as a dead holder (not a live one),
//     and the PID is parsed with JS parseInt leniency (leading digits count,
//     trailing junk stops the parse).
//  2. If the file exists, mtime is within 1 hour, and the parsed PID is alive
//     -> give up. TS checks liveness for ANY parsed PID, including 0 and
//     negatives (parseInt("0x42", 10) is 0, which signals the own group).
//  3. Otherwise write own PID
//  4. Read back to verify; if PID is not ours -> race lost (silent give-up,
//     no rollback — TS returns null)
func TryAcquireLock(memoryDir string) (priorMtime int64, err error) {
	path := lockPath(memoryDir)

	var mtimeMs int64
	var holderPid int
	var havePid, fileExists bool

	if info, statErr := os.Stat(path); statErr == nil {
		fileExists = true
		mtimeMs = info.ModTime().UnixMilli()
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			// TS catch: the error is logged and holderPid stays undefined, so
			// an unreadable lock is treated as abandoned.
			log.Error("failed to read consolidation lock file", "err", readErr)
		} else if pid, ok := jsParseInt(string(raw)); ok {
			holderPid, havePid = pid, true
		}
	}

	if fileExists && time.Now().UnixMilli()-mtimeMs < holderStaleMs {
		if havePid && isProcessRunning(holderPid) {
			return -1, nil
		}
	}

	// TS mkdirSync/writeFileSync throw instead of failing silently; the error
	// propagates to the MaybeRun caller.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return -1, fmt.Errorf("mkdir lock dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		return -1, fmt.Errorf("write lock: %w", err)
	}

	// Read-back verification. TS: any read failure or parseInt mismatch
	// returns null — a silent give-up without rollback.
	verify, err := os.ReadFile(path)
	if err != nil {
		return -1, nil
	}
	if pid, ok := jsParseInt(string(verify)); !ok || pid != os.Getpid() {
		return -1, nil
	}

	if fileExists {
		return mtimeMs, nil
	}
	return 0, nil
}

// jsParseInt mirrors JS parseInt(s, 10) as used on the lock file
// (consolidation.ts:214,235): skip leading JS whitespace, accept an optional
// sign, then take the longest run of decimal digits and stop at the first
// non-digit. "No digits" (JS NaN — which TS's Number.isFinite guard keeps out
// of holderPid) and values that overflow Go's int both report ok=false; an
// out-of-range PID can never be running, matching TS where process.kill on it
// throws.
func jsParseInt(s string) (int, bool) {
	runes := []rune(s)
	i := 0
	for i < len(runes) && isJSSpace(runes[i]) {
		i++
	}
	neg := false
	if i < len(runes) && (runes[i] == '+' || runes[i] == '-') {
		neg = runes[i] == '-'
		i++
	}
	start := i
	for i < len(runes) && runes[i] >= '0' && runes[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.Atoi(string(runes[start:i]))
	if err != nil {
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}

// isJSSpace mirrors the JS \s class used by String.prototype.trim and
// parseInt's whitespace skip: the Unicode space separators plus TAB/LF/VT/FF/
// CR, NBSP and U+FEFF — but not U+0085 (NEL), which unicode.IsSpace includes
// and JS \s does not.
func isJSSpace(r rune) bool {
	return r == 0xFEFF || (unicode.IsSpace(r) && r != 0x85)
}

// RollbackLock restores the lock file's mtime to pre-acquisition value, used for recovery after consolidation failure.
// When priorMtime is 0, the lock file is deleted directly.
func RollbackLock(memoryDir string, priorMtime int64) {
	path := lockPath(memoryDir)
	if priorMtime == 0 {
		// TS unlinkSync throws on ENOENT too and the catch logs every failure.
		if err := os.Remove(path); err != nil {
			log.Error("failed to rollback consolidation lock", "err", err)
		}
		return
	}
	// Clear PID to prevent our own PID from being mistaken as still holding
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		log.Error("failed to rollback consolidation lock", "err", err)
		return
	}
	t := time.UnixMilli(priorMtime)
	if err := os.Chtimes(path, t, t); err != nil {
		log.Error("failed to rollback consolidation lock", "err", err)
	}
}

// isProcessRunning is implemented in platform-specific files (lock_unix.go / lock_windows.go)
