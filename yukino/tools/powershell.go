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
	"os/exec"
	"runtime"
	"sync"
)

// disallowedPowerShellAutoBackground: Start-Sleep (and its built-in `sleep`
// alias) is killed on timeout instead of auto-backgrounded — backgrounding
// one would just hold a task slot until session end. Mirrors Bash's
// bare-sleep blocklist.
var disallowedPowerShellAutoBackground = map[string]bool{"start-sleep": true, "sleep": true}

// resolvePowerShellExecutable picks the PowerShell binary for the platform:
// powershell.exe on Windows, pwsh (PowerShell Core) elsewhere. Off Windows it
// probes PATH and falls back to a classic `powershell` binary when pwsh is
// not installed; when neither exists it still returns "pwsh" so the spawn
// error carries the install hint.
func resolvePowerShellExecutable(goos string, lookPath func(string) (string, error)) string {
	if goos == "windows" {
		return "powershell.exe"
	}
	if _, err := lookPath("pwsh"); err == nil {
		return "pwsh"
	}
	if _, err := lookPath("powershell"); err == nil {
		return "powershell"
	}
	return "pwsh"
}

// powerShellInvocation builds the executable, argument vector and spawn-miss
// hint for one command, mirroring the platform split in the TS tool: Windows
// gets -ExecutionPolicy Bypass plus a UTF-8 output-encoding preamble.
func powerShellInvocation(goos, command string, lookPath func(string) (string, error)) (executable string, args []string, notFoundHint string) {
	shellCommand := command
	if goos == "windows" {
		shellCommand = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n" + command
		return resolvePowerShellExecutable(goos, lookPath),
			[]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", shellCommand},
			""
	}
	return resolvePowerShellExecutable(goos, lookPath),
		[]string{"-NoProfile", "-NonInteractive", "-Command", shellCommand},
		" (pwsh is required on macOS/Linux — install PowerShell Core)"
}

// PowerShellTool executes commands in PowerShell. It shares the background
// plumbing with BashTool: same schema gating, timeout auto-background and
// manual backgrounding contract.
type PowerShellTool struct {
	// WorkDir is the working directory for spawned shells; empty inherits
	// the server process directory.
	WorkDir string
	// SessionID identifies the session spill directory for output files.
	SessionID string
	// TaskManager is the background task registry, injected by the host —
	// same contract as BashTool.TaskManager. When nil, PowerShell is
	// foreground-only: run_in_background disappears from the schema and
	// timeouts kill.
	TaskManager BackgroundTaskManager
	// LookPath overrides executable discovery (tests); nil uses exec.LookPath.
	LookPath func(string) (string, error)

	fgOnce sync.Once
	fg     *foregroundSet
}

func (t *PowerShellTool) Name() string { return "PowerShell" }

func (t *PowerShellTool) Description() string { return PowerShellDescription }

func (t *PowerShellTool) Category() ToolCategory { return CategoryCommand }

// SetBackgroundTaskManager injects the shared background task registry
// (BackgroundableTool).
func (t *PowerShellTool) SetBackgroundTaskManager(mgr BackgroundTaskManager) { t.TaskManager = mgr }

// BackgroundEnabled reports whether the background subsystem is available.
func (t *PowerShellTool) BackgroundEnabled() bool {
	return t.TaskManager != nil && backgroundTasksEnabled()
}

// HasForegroundTasks reports whether at least one foreground PowerShell
// command runs.
func (t *PowerShellTool) HasForegroundTasks() bool { return t.foreground().hasAny() }

// BackgroundForegroundTasks moves every running foreground PowerShell command
// to the background and returns how many were actually backgrounded.
func (t *PowerShellTool) BackgroundForegroundTasks() int { return t.foreground().backgroundAll() }

func (t *PowerShellTool) foreground() *foregroundSet {
	t.fgOnce.Do(func() { t.fg = newForegroundSet() })
	return t.fg
}

func (t *PowerShellTool) lookPath() func(string) (string, error) {
	if t.LookPath != nil {
		return t.LookPath
	}
	return exec.LookPath
}

func (t *PowerShellTool) Schema() map[string]any {
	properties := map[string]any{
		"command": map[string]any{"type": "string", "description": "PowerShell command to execute"},
		"timeout": map[string]any{"type": "integer", "description": "Timeout in seconds (max 600)", "default": 120},
	}
	description := t.Description()
	if t.BackgroundEnabled() {
		properties["run_in_background"] = map[string]any{
			"type":        "boolean",
			"description": "Run the command in the background. Returns a task ID immediately; the result arrives later as a task notification.",
			"default":     false,
		}
		description += "\n" + PowerShellBackgroundDescription
	}
	return map[string]any{
		"name":        t.Name(),
		"description": description,
		"input_schema": map[string]any{
			"type":       "object",
			"properties": properties,
			"required":   []string{"command"},
		},
	}
}

func (t *PowerShellTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	command, _ := args["command"].(string)
	if command == "" {
		return ToolResult{Output: "Error: command is required", IsError: true}
	}

	timeout := intArg(args, "timeout", 120)
	if nonFiniteNumberArg(args, "timeout") || timeout <= 0 {
		return ToolResult{Output: "Error: timeout must be a finite number greater than 0 seconds", IsError: true}
	}
	if timeout > maxTimeout {
		timeout = maxTimeout
	}
	runInBackground := boolArg(args, "run_in_background") && backgroundTasksEnabled()

	// No OS-sandbox wrapping here: the seatbelt/bwrap wrappers are
	// bash-specific, and Windows — this tool's primary platform — has no OS
	// sandbox support anyway.
	executable, shellArgs, notFoundHint := powerShellInvocation(runtime.GOOS, command, t.lookPath())

	// TS: cwd and the spill directory come from the per-call tool context
	// (ctx.workDir / ctx.sessionId); shared instances running against a
	// different workspace resolve per call, so the struct field is only a
	// fallback for calls without a ctx workDir.
	workDir := WorkDirFromContext(ctx)
	if workDir == "" {
		workDir = t.WorkDir
	}
	sessionID := t.SessionID
	if id, ok := SessionIDFromContext(ctx); ok {
		sessionID = id
	}

	cfg := shellRunConfig{
		prompt:                   "PS> ",
		executable:               executable,
		args:                     shellArgs,
		command:                  command,
		workDir:                  workDir,
		sessionID:                sessionID,
		toolCallID:               ToolCallIDFromContext(ctx),
		timeout:                  timeout,
		disallowedAutoBackground: disallowedPowerShellAutoBackground,
		idPrefix:                 "ps",
		notFoundHint:             notFoundHint,
	}
	// TS powershell.ts — a per-run manager carried on the tool context takes
	// precedence over the host-wired instance manager (an explicit nil
	// disables backgrounding for the run).
	return runShellCommand(ctx, cfg, resolveBackgroundTaskManager(ctx, t.TaskManager), t.foreground(), runInBackground)
}
