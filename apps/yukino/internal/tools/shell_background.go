package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/sandbox"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tool_result"
)

const MaxShellOutputBytes = 10 * 1024 * 1024
const MaxShellOutputFileBytes = int64(5) * 1024 * 1024 * 1024

type shellExit struct {
	code                          int
	signal                        string
	aborted, timedOut, sizeKilled bool
	spawnError                    string
}

func createShellOutputFile(sessionID string) (*os.File, error) {
	name := "shell-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16] + ".output"
	var paths []string
	if dir, err := tool_result.SpillDir(sessionID); err == nil {
		if storage.MkdirPrivateSync(dir) == nil {
			paths = append(paths, filepath.Join(dir, name))
		}
	}
	paths = append(paths, filepath.Join(os.TempDir(), name))
	var last error
	for _, path := range paths {
		file, err := storage.OpenPrivateFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND|os.O_EXCL)
		if err == nil {
			return file, nil
		}
		last = err
	}
	return nil, last
}
func readOutputFile(path string, maxBytes int, tail bool) (string, int64, bool) {
	file, err := storage.OpenPrivateFile(path, os.O_RDONLY)
	if err != nil {
		return "", 0, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, false
	}
	size := info.Size()
	offset := int64(0)
	if tail {
		offset = max(int64(0), size-int64(maxBytes))
	}
	data := make([]byte, min(size-offset, int64(maxBytes+1)))
	n, _ := file.ReadAt(data, offset)
	data = data[:n]
	if offset > 0 {
		for len(data) > 0 && !utf8.RuneStart(data[0]) {
			data = data[1:]
		}
	}
	return strings.ToValidUTF8(takeUTF8Prefix(string(data), maxBytes), "�"), size, size > int64(maxBytes)
}
func formatShellResult(prompt, command string, exit shellExit, merged string, timeout int) ToolResult {
	if exit.spawnError != "" {
		return ToolResult{Output: "Error executing command: " + exit.spawnError, IsError: true}
	}
	if exit.aborted || exit.timedOut {
		message := "Error: command interrupted"
		if !exit.aborted {
			message = fmt.Sprintf("Error: command timed out after %ds", timeout)
		}
		if merged != "" {
			message = prompt + command + "\n" + merged + "\n" + message
		}
		return ToolResult{Output: message, IsError: true}
	}
	output := prompt + command + "\n" + merged
	if exit.code > 0 {
		output += fmt.Sprintf("\nExit code %d", exit.code)
		if hint := exitCodeHint(command, exit.code); hint != "" {
			output += " (" + hint + ")"
		}
	}
	if exit.code < 0 {
		output += "\nProcess terminated"
		if exit.signal != "" {
			output += " by " + exit.signal
		} else {
			output += " unexpectedly"
		}
	}
	if exit.sizeKilled {
		output += "\nCommand killed: output file exceeded 5GB"
	}
	return ToolResult{Output: output, IsError: exit.code != 0 || exit.sizeKilled}
}
func buildShellResult(prompt, command string, exit shellExit, path string, timeout, inlineLimit int, annotate func(string) string) ToolResult {
	info, err := os.Stat(path)
	size := int64(0)
	if err == nil {
		size = info.Size()
	}
	limit := inlineLimit
	if size > int64(limit) {
		limit = tool_result.ToolResultPreviewChars
	}
	text, actual, truncated := readOutputFile(path, limit, false)
	if annotate != nil {
		text = annotate(text)
	}
	if size <= int64(inlineLimit) && !truncated {
		_ = os.Remove(path)
		return formatShellResult(prompt, command, exit, text, timeout)
	}
	result := formatShellResult(prompt, command, exit, "", timeout)
	result.Output += "\n" + tool_result.BuildPersistedOutputPreview(int(actual), takeUTF8Prefix(text, tool_result.ToolResultPreviewChars), path, "bytes")
	return result
}
func backgroundMessage(reason, id string, timeout int) string {
	switch reason {
	case "timeout":
		return fmt.Sprintf("Command exceeded its %ds timeout and was moved to the background (task_id: %s). It is still running — you will be notified when it completes.", timeout, id)
	case "user":
		return fmt.Sprintf("Command was manually backgrounded by the user (task_id: %s). It is still running — you will be notified when it completes.", id)
	default:
		return fmt.Sprintf("Command running in background (task_id: %s). You will be notified when it completes; do not poll. Use TaskStop with task_id to kill it early.", id)
	}
}
func executeShell(ctx context.Context, name, prompt string, args map[string]any, fallback BackgroundTaskManager, state *shellState, defaultCwd string, prepare func(string, string, string) (sandbox.PreparedCommand, error)) ToolResult {
	command, _ := args["command"].(string)
	if command == "" {
		return ToolResult{Output: "Error: command is required", IsError: true}
	}
	timeout, valid := shellTimeout(args)
	if !valid {
		return ToolResult{Output: "Error: timeout must be a finite number greater than 0 seconds", IsError: true}
	}
	if ctx.Err() != nil {
		return ToolResult{Output: "Error: command interrupted", IsError: true}
	}
	cwd := workingDirectory(ctx)
	execution, hasExecution := ctx.Value(executionContextKey{}).(ExecutionContext)
	if !hasExecution && defaultCwd != "" {
		cwd = defaultCwd
	}
	// The workspace mutation lock is held until the command's process exits, not
	// merely until executeShell returns, so a command moved to the background
	// keeps serializing later workspace mutations (the reference releases via
	// done.then(release), where done resolves on process exit). The release is
	// idempotent; the deferred call covers the early-return paths that precede
	// the wait goroutine.
	var releaseWorkspace func()
	processStarted := false
	defer func() {
		if !processStarted && releaseWorkspace != nil {
			releaseWorkspace()
		}
	}()
	if !IsSafeCommand(command) {
		release, err := AcquireWorkspaceMutation(ctx, cwd)
		if err != nil {
			return ToolResult{Output: "Error: command interrupted", IsError: true}
		}
		releaseWorkspace = release
	}
	if denied := checkExecutionPermission(ctx, name, args); denied != nil {
		return *denied
	}
	file, err := createShellOutputFile(execution.SessionID)
	if err != nil {
		return ToolResult{Output: "Error creating output file: " + err.Error(), IsError: true}
	}
	path := file.Name()
	prepared, err := prepare(command, cwd, filepath.Dir(path))
	if err != nil {
		file.Close()
		os.Remove(path)
		message := "Error preparing sandbox: " + err.Error()
		if strings.Contains(err.Error(), "command was not executed") {
			message = "Error: " + err.Error()
		}
		return ToolResult{Output: message, IsError: true}
	}
	cleanup := func(result ToolResult) ToolResult {
		if prepared.Cleanup != nil {
			if err := prepared.Cleanup(); err != nil {
				result.Output += "\nError cleaning up sandbox: " + err.Error()
				result.IsError = true
			}
		}
		return result
	}
	if ctx.Err() != nil {
		file.Close()
		os.Remove(path)
		return cleanup(ToolResult{Output: "Error: command interrupted", IsError: true})
	}
	cmd := exec.Command(prepared.Executable, prepared.Args...)
	cmd.Dir = cwd
	cmd.Env = prepared.Env
	cmd.Stdin = nil
	cmd.Stdout = file
	cmd.Stderr = file
	prepareShellProcess(cmd)
	if err := cmd.Start(); err != nil {
		file.Close()
		os.Remove(path)
		hint := ""
		if name == "PowerShell" && runtime.GOOS != "windows" {
			if _, lookErr := exec.LookPath(prepared.Executable); lookErr != nil {
				hint = " (pwsh is required on macOS/Linux — install PowerShell Core)"
			}
		}
		return cleanup(ToolResult{Output: "Error executing command: " + err.Error() + hint, IsError: true})
	}
	file.Close()
	done := make(chan error, 1)
	var exited atomic.Bool
	unregisterExit := RegisterExitCleanup(func() {
		if !exited.Load() {
			killShellProcess(cmd, true)
		}
	})
	processStarted = true
	go func() {
		err := cmd.Wait()
		exited.Store(true)
		unregisterExit()
		if releaseWorkspace != nil {
			releaseWorkspace()
		}
		done <- err
	}()
	manager := TaskManagerForContext(ctx, fallback)
	requests := make(chan backgroundRequest, 1)
	var foregroundID uint64
	if manager != nil {
		state.mu.Lock()
		state.next++
		foregroundID = state.next
		if state.foreground == nil {
			state.foreground = map[uint64]chan backgroundRequest{}
		}
		state.foreground[foregroundID] = requests
		state.mu.Unlock()
		// On exit the entry is dropped and any request still buffered is
		// acknowledged false, so a concurrent Ctrl+B never counts a command
		// that already finished and never waits on a lost acknowledgement.
		defer func() {
			state.mu.Lock()
			delete(state.foreground, foregroundID)
			state.mu.Unlock()
			for {
				select {
				case pending := <-requests:
					pending.ack <- false
				default:
					return
				}
			}
		}()
	}
	timer := time.NewTimer(time.Duration(timeout) * time.Second)
	defer timer.Stop()
	timeoutCh := timer.C
	if execution.ShellTimeoutDisabled {
		timeoutCh = nil
	}
	watchdog := time.NewTicker(500 * time.Millisecond)
	defer watchdog.Stop()
	var escalation *time.Timer
	var escalationCh <-chan time.Time
	defer func() {
		if escalation != nil {
			escalation.Stop()
		}
	}()
	terminating := false
	exit := shellExit{}
	terminate := func() {
		if terminating {
			return
		}
		terminating = true
		killShellProcess(cmd, false)
		escalation = time.NewTimer(3 * time.Second)
		escalationCh = escalation.C
	}
	runBackground := func(reason string) (ToolResult, bool) {
		if manager == nil || terminating {
			return ToolResult{}, false
		}
		flat := strings.Join(strings.Fields(command), " ")
		if len(flat) > 80 {
			flat = flat[:77] + "..."
		}
		prefix := "bash"
		if name == "PowerShell" {
			prefix = "ps"
		}
		stop := make(chan struct{}, 1)
		id, err := manager.Create(flat, func(id string) (string, error) {
			ticker := time.NewTicker(500 * time.Millisecond)
			defer ticker.Stop()
			final := shellExit{}
			killed := false
			for {
				select {
				case <-stop:
					if !killed {
						killShellProcess(cmd, true)
						killed = true
					}
				case <-ticker.C:
					if info, err := os.Stat(path); err == nil && info.Size() > MaxShellOutputFileBytes && !killed {
						final.sizeKilled = true
						killShellProcess(cmd, true)
						killed = true
					}
				case err := <-done:
					if err != nil {
						final.code = cmd.ProcessState.ExitCode()
						final.signal = shellExitSignal(cmd)
					}
					result := cleanup(buildShellResult(prompt, command, final, path, timeout, 30000, prepared.AnnotateOutput))
					if result.IsError {
						return "", &TaskFailure{Output: result.Output}
					}
					return result.Output, nil
				}
			}
		}, func() {
			select {
			case stop <- struct{}{}:
			default:
			}
		}, TaskOptions{Kind: "shell", IDPrefix: prefix, OriginToolCallID: execution.ToolCallID})
		if err != nil {
			return ToolResult{Output: "Error starting background task: " + err.Error(), IsError: true}, false
		}
		return ToolResult{Output: backgroundMessage(reason, id, timeout)}, true
	}
	if requested, _ := args["run_in_background"].(bool); requested {
		if result, ok := runBackground("explicit"); ok {
			return result
		}
	}
	abortCh := ctx.Done()
	lastSize := int64(0)
	for {
		select {
		case err := <-done:
			if err != nil {
				exit.code = cmd.ProcessState.ExitCode()
				exit.signal = shellExitSignal(cmd)
			}
			return cleanup(buildShellResult(prompt, command, exit, path, timeout, MaxShellOutputBytes, prepared.AnnotateOutput))
		case request := <-requests:
			result, ok := runBackground(request.reason)
			request.ack <- ok
			if ok {
				return result
			}
		case <-abortCh:
			exit.aborted = true
			abortCh = nil
			terminate()
		case <-timeoutCh:
			timeoutCh = nil
			if result, ok := runBackground("timeout"); ok {
				return result
			}
			exit.timedOut = true
			terminate()
		case <-escalationCh:
			escalationCh = nil
			killShellProcess(cmd, true)
		case <-watchdog.C:
			if info, err := os.Stat(path); err == nil {
				if execution.OnOutput != nil && info.Size() != lastSize {
					lastSize = info.Size()
					text, _, _ := readOutputFile(path, 50*1024, true)
					func() { defer func() { recover() }(); execution.OnOutput(text) }()
				}
				if info.Size() > MaxShellOutputFileBytes {
					exit.sizeKilled = true
					terminate()
				}
			}
		}
	}
}
