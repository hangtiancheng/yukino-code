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

// Package logger is a port of src/logger/index.ts from the TypeScript
// reference implementation, rebuilt on log/slog. A single root logger
// writes warn-and-above JSONL entries to .yukino/logs/<session>.jsonl.
// Every handle — the package-level Logger and CreateChildLogger results —
// resolves its destination at call time, so handles stay valid across
// InitLogger calls and silently discard records before initialization:
// the Go analogue of the TS silent-fallback Proxy.
package logger

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Mode is the execution mode, written into the base field of every log entry.
type Mode string

const (
	ModeTerminal Mode = "terminal"
	ModeRemote   Mode = "remote"
	ModeTeammate Mode = "teammate"
)

// Options configures InitLogger. Port of InitLoggerOptions.
type Options struct {
	// SessionID is the session ID, used as the log filename and a base field.
	SessionID string
	// Mode is the execution mode. Empty defaults to ModeTerminal.
	Mode Mode
	// WorkDir is the working directory; defaults .yukino/logs/ root.
	WorkDir string
	// LogDir overrides the log directory (teammates use
	// ~/.yukino/teams/<team>/logs/).
	LogDir string
	// SkipCleanup: subprocesses pass true to skip expired-log cleanup
	// (avoid multi-process races).
	SkipCleanup bool
	// Stdout mirrors JSONL to stdout in addition to the log file. Only safe
	// in remote mode (UI owns stdout; teammates use it for IPC).
	Stdout bool
}

// logLevel: only warnings and errors are recorded, by design.
const logLevel = slog.LevelWarn

var (
	mu    sync.Mutex
	state *loggerState
)

// loggerState is the live root destination. nil before InitLogger and after
// CloseLogger — the silent-fallback condition.
type loggerState struct {
	file    *os.File
	base    []slog.Attr
	handler slog.Handler
}

// Logger is the global logger handle. Records are discarded until
// InitLogger runs (pre-init logs are dropped; startup errors should go to
// stderr directly), mirroring the TS silent-fallback proxy.
var Logger = slog.New(newDynamicHandler(nil, nil))

// InitLogger initializes the root logger: creates the log directory and
// file, and routes all subsequent records through it. Re-initializing
// closes the previous file first (guards against fd leaks). When called by
// the main process (SkipCleanup false), expired-log cleanup runs in the
// background. Returns the global Logger handle.
func InitLogger(opts Options) (*slog.Logger, error) {
	mu.Lock()
	defer mu.Unlock()
	closeLocked()

	logPath := resolveLogPath(opts)
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return Logger, err
	}
	ensureYukinoGitignore(logPath)
	// Append mode: multi-process safe, supports resume.
	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return Logger, err
	}

	var w io.Writer = file
	if opts.Stdout {
		w = io.MultiWriter(file, os.Stdout)
	}
	mode := opts.Mode
	if mode == "" {
		mode = ModeTerminal
	}
	state = &loggerState{
		file: file,
		base: []slog.Attr{
			slog.String("sessionId", opts.SessionID),
			slog.String("mode", string(mode)),
		},
		handler: slog.NewJSONHandler(w, &slog.HandlerOptions{Level: logLevel}),
	}

	if !opts.SkipCleanup {
		workDir := opts.WorkDir
		if workDir == "" {
			workDir, _ = os.Getwd()
		}
		go cleanExpiredLogs(workDir)
	}
	return Logger, nil
}

// CloseLogger closes the log file and returns every handle to the silent
// fallback. Go has no process-exit hook (TS registers closeLogger on
// process.on('exit')); callers should defer it at shutdown. Safe to call
// when uninitialized.
func CloseLogger() {
	mu.Lock()
	defer mu.Unlock()
	closeLocked()
}

func closeLocked() {
	if state == nil {
		return
	}
	// slog's JSONHandler writes synchronously — no buffer to flush.
	_ = state.file.Close()
	state = nil
}

// CreateChildLogger returns a module-scoped child logger, e.g.
// CreateChildLogger("session"). The handle resolves the current root at
// call time, so it stays valid across InitLogger/CloseLogger cycles (port
// of the TS cached-child Proxy).
func CreateChildLogger(module string) *slog.Logger {
	return Logger.With("module", module)
}

var nonNameSegment = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// SanitizeNameSegment sanitizes a filename segment to prevent path
// traversal (member names, etc.).
func SanitizeNameSegment(name string) string {
	cleaned := nonNameSegment.ReplaceAllString(name, "_")
	if cleaned == "" {
		return "unnamed"
	}
	return cleaned
}

// resolveLogPath computes the log file path.
func resolveLogPath(opts Options) string {
	dir := opts.LogDir
	if dir == "" {
		workDir := opts.WorkDir
		if workDir == "" {
			workDir, _ = os.Getwd()
		}
		dir = filepath.Join(workDir, ".yukino", "logs")
	}
	return filepath.Join(dir, opts.SessionID+".jsonl")
}

// ensureYukinoGitignore writes a self-ignoring .gitignore ("*") into the
// nearest .yukino ancestor of the log file, so the runtime directory never
// gets committed. Existing files are left untouched; failures are non-fatal.
func ensureYukinoGitignore(logPath string) {
	dir := filepath.Dir(logPath)
	for filepath.Base(dir) != ".yukino" {
		parent := filepath.Dir(dir)
		if parent == dir {
			return // no .yukino ancestor (custom LogDir outside .yukino)
		}
		dir = parent
	}
	// O_EXCL: create only if missing, so user edits are never clobbered.
	f, err := os.OpenFile(filepath.Join(dir, ".gitignore"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return // already exists or unwritable — logging proceeds
	}
	_, _ = f.WriteString("*\n")
	_ = f.Close()
}

// logRetention mirrors the TS 30-day expired-log window.
const logRetention = 30 * 24 * time.Hour

// cleanExpiredLogs scans the project .yukino/logs/ and all team-specific
// ~/.yukino/teams/<team>/logs/ directories, removing .jsonl files whose
// mtime is older than 30 days. Returns the count removed; failures are
// silent.
func cleanExpiredLogs(workDir string) int {
	removed := cleanDir(filepath.Join(workDir, ".yukino", "logs"))

	home, err := os.UserHomeDir()
	if err != nil {
		return removed
	}
	teamsDir := filepath.Join(home, ".yukino", "teams")
	teams, err := os.ReadDir(teamsDir)
	if err != nil {
		return removed // no teams directory
	}
	for _, team := range teams {
		removed += cleanDir(filepath.Join(teamsDir, team.Name(), "logs"))
	}
	return removed
}

// cleanDir removes expired .jsonl files in a single directory.
func cleanDir(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0 // missing or unreadable directory
	}
	now := time.Now()
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := os.Stat(path)
		if err != nil || now.Sub(info.ModTime()) <= logRetention {
			continue
		}
		if os.Remove(path) == nil {
			removed++
		}
	}
	return removed
}
