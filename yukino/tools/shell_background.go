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
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Shared background-execution plumbing for the backgroundable tools (Bash,
// PowerShell): the file-descriptor output mode, the size watchdog constants,
// result/notification formatting, and the host wiring helpers.

const (
	// BackgroundNotificationChars is the notification body budget: larger
	// outputs stay on disk and only a preview travels in the notification.
	BackgroundNotificationChars = 30_000
	// BackgroundMaxOutputBytes: a backgrounded command may fill up to 5GB
	// before the size watchdog kills it. Foreground keeps the historical
	// 10MB cap (MaxShellOutputBytes).
	BackgroundMaxOutputBytes = int64(5) * 1024 * 1024 * 1024
	// SizeWatchdogInterval is how often the output-file size is polled.
	SizeWatchdogInterval = 500 * time.Millisecond
	// killGrace is the grace period between the graceful kill and the
	// forced-kill escalation.
	killGrace = 3 * time.Second
	// toolResultPreviewChars is the preview size quoted for outputs that
	// stay on disk.
	toolResultPreviewChars = 2000
)

// BackgroundReason records why a command moved to the background.
type BackgroundReason string

const (
	BackgroundExplicit BackgroundReason = "explicit"
	BackgroundUser     BackgroundReason = "user"
	BackgroundTimeout  BackgroundReason = "timeout"
)

// BackgroundTaskOptions mirrors the TS CreateTaskOptions carried into
// task-manager create(): the spawning tool_use id, the id prefix and the task
// kind.
type BackgroundTaskOptions struct {
	OriginToolCallID string
	IDPrefix         string
	Kind             string
}

// BackgroundTaskManager is the minimal subset of *subagent.TaskManager that
// the background shell plumbing needs. It is defined here instead of
// importing internal/yukino/subagent because subagent imports tools — a
// reverse reference would create a cycle (same pattern as MCPTool).
// *subagent.TaskManager satisfies this interface naturally.
//
// DrainNotifications is deliberately excluded: its return type references
// subagent.TaskNotification, which cannot be named here without the import
// cycle; draining notifications is the host agent loop's job.
type BackgroundTaskManager interface {
	CreateTask(name string, opts BackgroundTaskOptions) string
	SetRunning(id string, cancel context.CancelFunc)
	SetCompleted(id, output string)
	SetFailed(id, errMsg string)
	// SetTaskFailure records a deliberately formatted failure output (TS
	// TaskFailure): a killed shell's captured output replaces the generic
	// "Stopped by user" placeholder even when the task is already cancelled.
	SetTaskFailure(id, output string)
}

// bgManagerCtxKey carries the per-run background task manager through
// context.Context (TS: ctx.taskManager on the ToolContext).
type bgManagerCtxKey struct{}

// ContextWithBackgroundTaskManager attaches a per-run background task manager
// to ctx. Passing a nil manager explicitly disables backgrounding for this
// run and blocks the tools' fallback to their host-wired instance manager
// (TS: `ctx.taskManager === null` in bash.ts; spawn.ts passes null for
// in-process teammate turns).
func ContextWithBackgroundTaskManager(ctx context.Context, mgr BackgroundTaskManager) context.Context {
	return context.WithValue(ctx, bgManagerCtxKey{}, &mgr)
}

// resolveBackgroundTaskManager mirrors the TS precedence (bash.ts:206-210):
// a ctx-carried manager — including an explicit nil — wins over the
// tool-instance manager.
func resolveBackgroundTaskManager(ctx context.Context, instance BackgroundTaskManager) BackgroundTaskManager {
	if ptr, ok := ctx.Value(bgManagerCtxKey{}).(*BackgroundTaskManager); ok {
		return *ptr
	}
	return instance
}

// BackgroundTaskManagerFromContext returns the per-run manager attached with
// ContextWithBackgroundTaskManager and whether the key is present (the value
// may be a deliberate nil). Teams' TaskStop uses it to prefer the loop's own
// registry over the host-level one (TS task-stop.ts: ctx.taskManager?.get).
func BackgroundTaskManagerFromContext(ctx context.Context) (BackgroundTaskManager, bool) {
	if ptr, ok := ctx.Value(bgManagerCtxKey{}).(*BackgroundTaskManager); ok {
		return *ptr, true
	}
	return nil, false
}

// backgroundTasksEnabled reports whether the background subsystem is enabled;
// it can be disabled wholesale with YUKINO_DISABLE_BACKGROUND_TASKS=1 (schema
// parameter removed, timeouts kill, manual backgrounding becomes a no-op).
func backgroundTasksEnabled() bool {
	return os.Getenv("YUKINO_DISABLE_BACKGROUND_TASKS") != "1"
}

// shellExit carries the terminal facts about the child process, consumed to
// build results and notifications.
type shellExit struct {
	code       int
	hasCode    bool // false when the process was signalled or wait failed
	signal     string
	aborted    bool
	timedOut   bool
	sizeKilled bool
	spawnError string
}

// isAutobackgroundingAllowed reports whether a command may be *automatically*
// backgrounded on timeout. Bare sleeps are killed instead: backgrounding one
// would just hold a task slot until session end. Explicit run_in_background
// and manual backgrounding are always honored regardless of this gate. Only
// the first token is considered: `sleep 60` should die on timeout, but
// `npm run build && sleep 1` is a real workload worth keeping alive.
func isAutobackgroundingAllowed(command string, disallowed map[string]bool) bool {
	trimmed := strings.TrimLeftFunc(command, unicode.IsSpace)
	first := trimmed
	if i := strings.IndexFunc(trimmed, unicode.IsSpace); i >= 0 {
		first = trimmed[:i]
	}
	if i := strings.LastIndex(first, "/"); i >= 0 {
		first = first[i+1:]
	}
	first = strings.TrimPrefix(strings.TrimPrefix(first, "\""), "'")
	first = strings.TrimSuffix(strings.TrimSuffix(first, "\""), "'")
	return !disallowed[strings.ToLower(first)]
}

func backgroundTaskName(command string) string {
	flat := strings.Join(strings.Fields(command), " ")
	runes := []rune(flat)
	if len(runes) > 80 {
		return string(runes[:77]) + "..."
	}
	return flat
}

func backgroundMessage(reason BackgroundReason, taskID string, timeout int) string {
	switch reason {
	case BackgroundExplicit:
		return fmt.Sprintf("Command running in background (task_id: %s). You will be notified when it completes; do not poll. Use TaskStop with task_id to kill it early.", taskID)
	case BackgroundTimeout:
		return fmt.Sprintf("Command exceeded its %ds timeout and was moved to the background (task_id: %s). It is still running — you will be notified when it completes.", timeout, taskID)
	case BackgroundUser:
		return fmt.Sprintf("Command was manually backgrounded by the user (task_id: %s). It is still running — you will be notified when it completes.", taskID)
	}
	return ""
}

// sliceUtf8Safe slices buf to at most maxBytes, ending on a UTF-8 character
// boundary.
func sliceUtf8Safe(buf []byte, maxBytes int) []byte {
	if len(buf) <= maxBytes {
		return buf
	}
	end := maxBytes
	// Landed on a continuation byte: back up to the start of the sequence and
	// drop it rather than emitting a broken character.
	for end > 0 && !utf8.RuneStart(buf[end]) {
		end--
	}
	return buf[:end]
}

// readOutputFile reads at most maxBytes of the output file; missing files
// read as empty.
func readOutputFile(path string, maxBytes int) (text string, size int64, truncated bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", 0, false
	}
	size = info.Size()
	readLen := size
	if int64(maxBytes)+1 < readLen {
		// One lookahead byte lets sliceUtf8Safe detect a cut inside a code point.
		readLen = int64(maxBytes) + 1
	}
	buf := make([]byte, readLen)
	n, _ := io.ReadFull(f, buf)
	// TS decodes the sliced buffer with Buffer.toString("utf-8") — Node's
	// WHATWG maximal-subpart replacement, not a raw byte cast.
	return decodeUTF8Lenient(sliceUtf8Safe(buf[:n], maxBytes)), size, size > int64(maxBytes)
}

func unlinkQuiet(path string) {
	_ = os.Remove(path)
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

// createShellOutputFile creates the file that receives a command's
// stdout+stderr. Lives in the session tool-results directory (the established
// spill location, readable by the model for backgrounded commands); falls
// back to the OS temp dir when that directory cannot be created.
func createShellOutputFile(workDir, sessionID string) (string, *os.File, error) {
	fileName := fmt.Sprintf("shell-%s.output", randomHex(8))
	var candidates []string
	if workDir != "" {
		id := sessionID
		if id == "" {
			id = "default"
		}
		dir := filepath.Join(workDir, ".yukino", "sessions", id, "tool-results")
		if err := os.MkdirAll(dir, 0o755); err == nil {
			candidates = append(candidates, filepath.Join(dir, fileName))
		}
	}
	candidates = append(candidates, filepath.Join(os.TempDir(), fileName))

	var lastErr error = errors.New("no candidate output directory")
	for _, path := range candidates {
		f, err := openOutputFile(path)
		if err == nil {
			return path, f, nil
		}
		lastErr = err
	}
	return "", nil, lastErr
}

// formatFinalResult builds the foreground tool result from exit facts and the
// captured output. Shared verbatim by the inline foreground path and the
// background task notification body, so both report identically. prompt is
// the tool's shell marker ("$ " for Bash, "PS> " for PowerShell).
func formatFinalResult(prompt, command string, exit shellExit, merged string, truncated bool, timeout int) ToolResult {
	if exit.spawnError != "" {
		return ToolResult{Output: fmt.Sprintf("Error executing command: %s", exit.spawnError), IsError: true}
	}
	if exit.aborted || exit.timedOut {
		captured := ""
		if merged != "" || truncated {
			captured = formatShellOutput(prompt, command, merged, "", truncated)
		}
		errMsg := "Error: command interrupted"
		if !exit.aborted {
			errMsg = fmt.Sprintf("Error: command timed out after %ds", timeout)
		}
		if captured != "" {
			errMsg = captured + "\n" + errMsg
		}
		return ToolResult{Output: errMsg, IsError: true}
	}

	exitCode := exit.code
	if !exit.hasCode {
		exitCode = 0
	}
	output := formatShellOutput(prompt, command, merged, "", truncated)

	if !truncated {
		if exitCode != 0 {
			if hint := exitCodeHint(command, exitCode); hint != "" {
				output += fmt.Sprintf("\nExit code %d (%s)", exitCode, hint)
			} else {
				output += fmt.Sprintf("\nExit code %d", exitCode)
			}
		}
		if !exit.hasCode {
			if exit.signal != "" {
				output += fmt.Sprintf("\nProcess terminated by %s", exit.signal)
			} else {
				output += "\nProcess terminated unexpectedly"
			}
		}
	}

	return ToolResult{Output: output, IsError: truncated || exitCode != 0 || !exit.hasCode}
}

// buildPersistedOutputPreview renders the <persisted-output> wrapper quoting
// the on-disk location plus a short preview.
func buildPersistedOutputPreview(totalBytes int64, preview, spillPath string) string {
	var msg strings.Builder
	msg.WriteString("<persisted-output>\n")
	fmt.Fprintf(&msg, "Output too large (%dKB). Full content saved to:\n%s\n\n", totalBytes/1024, spillPath)
	msg.WriteString("Preview (first 2KB):\n")
	msg.WriteString(preview)
	if totalBytes > toolResultPreviewChars {
		msg.WriteString("\n...")
	}
	msg.WriteString("\n</persisted-output>")
	return msg.String()
}

// buildBackgroundBody builds the notification body for a finished background
// command from the output file. Small outputs are inlined and the file is
// deleted; large outputs keep the file on disk and the notification carries
// its path with a preview, so the full text stays readable via ReadFile
// without ever loading it into memory here.
func buildBackgroundBody(prompt, command string, exit shellExit, outputPath string, timeout int) ToolResult {
	var size int64
	if info, err := os.Stat(outputPath); err == nil {
		size = info.Size()
	}

	var result ToolResult
	if size <= BackgroundNotificationChars {
		text, _, truncated := readOutputFile(outputPath, MaxShellOutputBytes)
		result = formatFinalResult(prompt, command, exit, text, truncated, timeout)
		unlinkQuiet(outputPath)
	} else {
		header := formatFinalResult(prompt, command, exit, "", false, timeout)
		preview, _, _ := readOutputFile(outputPath, toolResultPreviewChars)
		result = ToolResult{
			Output:  header.Output + "\n" + buildPersistedOutputPreview(size, preview, outputPath),
			IsError: header.IsError,
		}
	}

	if exit.sizeKilled {
		result.Output += "\nBackground command killed: output file exceeded 5GB"
		result.IsError = true
	}
	return result
}

// foregroundSet tracks running foreground executions eligible for manual
// backgrounding (the Ctrl+B equivalent), per backgroundable tool instance.
type foregroundSet struct {
	mu      sync.Mutex
	entries map[string]func() bool
	nextID  int
}

func newForegroundSet() *foregroundSet {
	return &foregroundSet{entries: make(map[string]func() bool)}
}

func (s *foregroundSet) add(prefix string, background func() bool) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	key := fmt.Sprintf("%s-%d", prefix, s.nextID)
	s.entries[key] = background
	return key
}

func (s *foregroundSet) remove(key string) {
	if key == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, key)
}

func (s *foregroundSet) hasAny() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries) > 0
}

// backgroundAll moves every running foreground command to the background and
// returns how many were actually backgrounded.
func (s *foregroundSet) backgroundAll() int {
	s.mu.Lock()
	fns := make([]func() bool, 0, len(s.entries))
	for _, fn := range s.entries {
		fns = append(fns, fn)
	}
	s.mu.Unlock()
	count := 0
	for _, fn := range fns {
		if fn() {
			count++
		}
	}
	return count
}

// shellRunConfig describes one backgroundable shell invocation.
type shellRunConfig struct {
	prompt     string // transcript marker: "$ " for Bash, "PS> " for PowerShell
	executable string
	args       []string
	command    string // the original command, for display
	workDir    string
	sessionID  string
	// toolCallID is the tool_use that started this command (TS ctx.toolCallId);
	// backgrounded tasks record it as their origin.
	toolCallID string
	timeout    int // seconds
	env        []string
	// disallowedAutoBackground gates *automatic* backgrounding on timeout.
	disallowedAutoBackground map[string]bool
	idPrefix                 string
	// notFoundHint is appended to spawn errors when the executable is
	// missing (e.g. pwsh not installed).
	notFoundHint string
	// prepare, when set, is called with the output file path after it is
	// created and may rewrite the executable/args (e.g. sandbox wrapping
	// that must grant write access to the output file).
	prepare func(outputPath string) (executable string, args []string, err error)
}

// shellState is the mutable state of one running shell command.
type shellState struct {
	cfg     shellRunConfig
	cmd     *exec.Cmd
	outPath string
	mgr     BackgroundTaskManager
	fg      *foregroundSet

	mu            sync.Mutex
	aborted       bool
	terminating   bool
	settled       bool
	backgrounded  bool
	sizeKilled    bool
	timedOut      bool
	fgKey         string
	escalateTimer *time.Timer

	exitCh       chan shellExit
	resultCh     chan ToolResult
	stop         chan struct{}
	stopOnce     sync.Once
	timeoutTimer *time.Timer
}

// runShellCommand spawns the command with stdout+stderr writing directly into
// the output file: output never flows through the parent process, so
// backgrounding is a bookkeeping switch — no re-spawn, no buffer handover.
// It blocks until the call settles: either the inline completion or an early
// "moved to background" message.
func runShellCommand(ctx context.Context, cfg shellRunConfig, mgr BackgroundTaskManager, fg *foregroundSet, wantBackground bool) ToolResult {
	if ctx.Err() != nil {
		return ToolResult{Output: "Error: command interrupted", IsError: true}
	}

	outPath, outFile, err := createShellOutputFile(cfg.workDir, cfg.sessionID)
	if err != nil {
		return ToolResult{Output: fmt.Sprintf("Error creating output file: %s", err), IsError: true}
	}

	executable, execArgs := cfg.executable, cfg.args
	if cfg.prepare != nil {
		executable, execArgs, err = cfg.prepare(outPath)
		if err != nil {
			outFile.Close()
			unlinkQuiet(outPath)
			return ToolResult{Output: fmt.Sprintf("Error preparing sandbox: %s", err), IsError: true}
		}
	}

	cmd := exec.Command(executable, execArgs...)
	if cfg.workDir != "" {
		cmd.Dir = cfg.workDir
	}
	if len(cfg.env) > 0 {
		cmd.Env = append(os.Environ(), cfg.env...)
	}
	// stdout and stderr share one append-mode fd: each write lands on disk
	// atomically and the streams interleave chronologically.
	cmd.Stdout = outFile
	cmd.Stderr = outFile
	setDetachedProcess(cmd)

	if err := cmd.Start(); err != nil {
		outFile.Close()
		unlinkQuiet(outPath)
		msg := err.Error()
		if errors.Is(err, exec.ErrNotFound) && cfg.notFoundHint != "" {
			msg += cfg.notFoundHint
		}
		return ToolResult{Output: fmt.Sprintf("Error executing command: %s", msg), IsError: true}
	}
	// The child holds a dup of the descriptor; drop our handle so the file
	// can be unlinked independently of the process lifetime.
	outFile.Close()

	st := &shellState{
		cfg:      cfg,
		cmd:      cmd,
		outPath:  outPath,
		mgr:      mgr,
		fg:       fg,
		exitCh:   make(chan shellExit, 1),
		resultCh: make(chan ToolResult, 1),
		stop:     make(chan struct{}),
	}

	backgroundAvailable := mgr != nil && backgroundTasksEnabled()
	autoBackgroundAllowed := backgroundAvailable &&
		isAutobackgroundingAllowed(cfg.command, cfg.disallowedAutoBackground)

	// The process is gone for good when Wait returns: stop the size watchdog
	// and any pending kill escalation so no timer outlives the command.
	go func() {
		waitErr := cmd.Wait()
		var exit shellExit
		var exitErr *exec.ExitError
		if waitErr != nil {
			if errors.As(waitErr, &exitErr) {
				exit.code = exitErr.ExitCode()
				exit.hasCode = exit.code >= 0
				exit.signal = processExitSignal(exitErr)
			} else {
				exit.spawnError = waitErr.Error()
			}
		} else {
			exit.hasCode = true
		}
		st.mu.Lock()
		exit.aborted = st.aborted
		exit.timedOut = st.timedOut
		exit.sizeKilled = st.sizeKilled
		st.mu.Unlock()
		st.cleanupAfterExit()
		st.settleForeground(exit)
		st.exitCh <- exit
	}()

	// The child writes directly to the output file, so size is enforced by
	// polling stat(): foreground keeps the historical 10MB cap, backgrounded
	// commands get the 5GB ceiling.
	go func() {
		ticker := time.NewTicker(SizeWatchdogInterval)
		defer ticker.Stop()
		for {
			select {
			case <-st.stop:
				return
			case <-ticker.C:
				info, err := os.Stat(outPath)
				if err != nil {
					continue
				}
				st.mu.Lock()
				bg := st.backgrounded
				st.mu.Unlock()
				capLimit := int64(MaxShellOutputBytes)
				if bg {
					capLimit = BackgroundMaxOutputBytes
				}
				if info.Size() > capLimit {
					st.mu.Lock()
					st.sizeKilled = bg
					st.mu.Unlock()
					st.terminate()
					return
				}
			}
		}
	}()

	// Caller cancellation interrupts the command — unless it has already been
	// moved to the background, which outlives the caller's context.
	go func() {
		select {
		case <-st.stop:
		case <-ctx.Done():
			st.mu.Lock()
			if st.backgrounded || st.settled {
				st.mu.Unlock()
				return
			}
			st.aborted = true
			st.mu.Unlock()
			st.terminate()
		}
	}()

	// The timer and foreground-set registrations must be published under
	// st.mu: the Wait goroutine reads both fields (cleanupAfterExit,
	// settleForeground) and a command that exits before this point would
	// otherwise race with the unsynchronized writes. When the command has
	// already settled, skip the timer and drop the foreground entry instead
	// of leaking registrations nobody will clean up.
	st.mu.Lock()
	if !st.settled && !st.backgrounded {
		st.timeoutTimer = time.AfterFunc(time.Duration(cfg.timeout)*time.Second, func() {
			// Auto-background on timeout when allowed; otherwise hard-kill.
			if autoBackgroundAllowed && st.backgroundExecution(BackgroundTimeout) {
				return
			}
			st.mu.Lock()
			if st.settled || st.backgrounded {
				st.mu.Unlock()
				return
			}
			st.timedOut = true
			st.mu.Unlock()
			st.terminate()
		})
	}
	st.mu.Unlock()

	if backgroundAvailable {
		key := fg.add(cfg.idPrefix, func() bool { return st.backgroundExecution(BackgroundUser) })
		st.mu.Lock()
		settled := st.settled || st.backgrounded
		if !settled {
			st.fgKey = key
		}
		st.mu.Unlock()
		if settled {
			fg.remove(key)
		}
	}

	if wantBackground && backgroundAvailable {
		// If the command ends before it can be backgrounded, backgroundExecution
		// returns false and the actual result is reported instead.
		st.backgroundExecution(BackgroundExplicit)
	}
	return <-st.resultCh
}

// terminate kills the child's whole process tree, escalating to a forced kill
// after the grace period.
func (st *shellState) terminate() {
	st.mu.Lock()
	if st.terminating {
		st.mu.Unlock()
		return
	}
	st.terminating = true
	st.mu.Unlock()

	killProcessTree(st.cmd, false)
	timer := time.AfterFunc(killGrace, func() { killProcessTree(st.cmd, true) })
	st.mu.Lock()
	st.escalateTimer = timer
	st.mu.Unlock()
}

// cleanupAfterExit stops timers that must not outlive the process.
func (st *shellState) cleanupAfterExit() {
	st.mu.Lock()
	if st.timeoutTimer != nil {
		st.timeoutTimer.Stop()
	}
	if st.escalateTimer != nil {
		st.escalateTimer.Stop()
	}
	st.mu.Unlock()
	st.stopOnce.Do(func() { close(st.stop) })
}

// settleForeground completes a foreground call: read the output back
// (capped), inline it, and delete the now-redundant file.
func (st *shellState) settleForeground(exit shellExit) {
	st.mu.Lock()
	if st.settled || st.backgrounded {
		// backgroundExecution moved the command to the background (its task
		// runner owns the completion from here).
		st.mu.Unlock()
		return
	}
	st.settled = true
	if st.timeoutTimer != nil {
		st.timeoutTimer.Stop()
	}
	key := st.fgKey
	st.fgKey = ""
	st.mu.Unlock()
	st.fg.remove(key)

	text, _, truncated := readOutputFile(st.outPath, MaxShellOutputBytes)
	result := formatFinalResult(st.cfg.prompt, st.cfg.command, exit, text, truncated, st.cfg.timeout)
	unlinkQuiet(st.outPath)
	st.resultCh <- result
}

// backgroundExecution moves the running command to the background. Returns
// false when the command already finished, a kill is underway, or
// backgrounding is unavailable.
func (st *shellState) backgroundExecution(reason BackgroundReason) bool {
	st.mu.Lock()
	// `terminating` means a kill is already underway (abort, hard timeout,
	// output cap): such a command must report its terminal result inline,
	// not slip into the background between terminate() and exit.
	if st.backgrounded || st.settled || st.terminating || st.mgr == nil || !backgroundTasksEnabled() {
		st.mu.Unlock()
		return false
	}
	st.backgrounded = true
	st.settled = true
	// The command now outlives both its foreground timeout and the caller's
	// context: only task cancellation or session shutdown can kill it.
	if st.timeoutTimer != nil {
		st.timeoutTimer.Stop()
	}
	key := st.fgKey
	st.fgKey = ""
	st.mu.Unlock()
	st.fg.remove(key)

	taskID := st.mgr.CreateTask(backgroundTaskName(st.cfg.command), BackgroundTaskOptions{
		OriginToolCallID: st.cfg.toolCallID,
		IDPrefix:         st.cfg.idPrefix,
		Kind:             "shell",
	})
	st.mgr.SetRunning(taskID, context.CancelFunc(func() { killProcessTree(st.cmd, true) }))

	go func() {
		exit := <-st.exitCh
		body := buildBackgroundBody(st.cfg.prompt, st.cfg.command, exit, st.outPath, st.cfg.timeout)
		if body.IsError {
			// TS throws TaskFailure(body.output) here: the captured output and
			// exit facts replace the generic "Stopped by user" placeholder even
			// when the task was cancelled.
			st.mgr.SetTaskFailure(taskID, body.Output)
		} else {
			st.mgr.SetCompleted(taskID, body.Output)
		}
	}()

	st.resultCh <- ToolResult{Output: backgroundMessage(reason, taskID, st.cfg.timeout)}
	return true
}

// BackgroundableTool is the subset of a tool instance the host wiring below
// needs.
type BackgroundableTool interface {
	Tool
	SetBackgroundTaskManager(mgr BackgroundTaskManager)
	BackgroundEnabled() bool
	HasForegroundTasks() bool
	BackgroundForegroundTasks() int
}

// BackgroundableToolNames lists the tools that support background execution,
// in manual-background priority order.
var BackgroundableToolNames = []string{"Bash", "PowerShell"}

// AttachBackgroundTaskManager shares one background task registry across every
// backgroundable tool in the registry, so run_in_background, manual
// backgrounding and timeout auto-background deliver results through the same
// task-notification drain as background agents.
func AttachBackgroundTaskManager(registry *Registry, mgr BackgroundTaskManager) {
	for _, name := range BackgroundableToolNames {
		if tool, ok := registry.Get(name).(BackgroundableTool); ok {
			tool.SetBackgroundTaskManager(mgr)
		}
	}
}

// HasAnyForegroundTasks reports whether any backgroundable tool has a running
// foreground task; gates the manual-background handler so it stays inert when
// nothing is running.
func HasAnyForegroundTasks(registry *Registry) bool {
	for _, name := range BackgroundableToolNames {
		if tool, ok := registry.Get(name).(BackgroundableTool); ok && tool.HasForegroundTasks() {
			return true
		}
	}
	return false
}

// BackgroundAllForegroundTasks moves every running foreground task of every
// backgroundable tool to the background and returns how many were
// backgrounded.
func BackgroundAllForegroundTasks(registry *Registry) int {
	count := 0
	for _, name := range BackgroundableToolNames {
		if tool, ok := registry.Get(name).(BackgroundableTool); ok {
			count += tool.BackgroundForegroundTasks()
		}
	}
	return count
}
