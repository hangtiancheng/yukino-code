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
	"errors"
	"fmt"
	"sync"

	"github.com/hangtiancheng/yukino-code/yukino/sandbox"
)

const maxTimeout = 600

// disallowedBashAutoBackground: bare sleeps are killed on timeout instead of
// auto-backgrounded — backgrounding one would just hold a task slot until
// session end.
var disallowedBashAutoBackground = map[string]bool{"sleep": true}

type BashTool struct {
	WorkDir string
	Sandbox sandbox.Sandbox // OS-level sandbox instance; nil means disabled.
	// SandboxConfig carries the sandbox path and network permissions. nil
	// selects the TS constructor default
	// ({allowWrite: [], denyWrite: [], networkEnabled: true}) — a zero-value
	// struct would silently flip the network default to blocked.
	SandboxConfig *sandbox.Config

	// SandboxRequired makes sandboxing mandatory even when no Sandbox was
	// configured: commands fail closed instead of running unprotected. A
	// non-nil Sandbox is always mandatory — a missing or unavailable sandbox
	// aborts the command rather than silently degrading to unsandboxed
	// execution (TS: bash.ts sandboxRequired).
	SandboxRequired bool

	// SessionID identifies the session spill directory that receives shell
	// output files (".yukino/sessions/<id>/tool-results"); empty falls back
	// to the "default" session directory, then the OS temp dir.
	SessionID string

	// TaskManager is the background task registry, injected by the host —
	// the same instance the Agent tool uses, so completion notifications
	// share one drain and task cancellation covers both. When nil, Bash is
	// foreground-only with the legacy in-memory behaviour: run_in_background
	// disappears from the schema and timeouts kill.
	TaskManager BackgroundTaskManager

	fgOnce sync.Once
	fg     *foregroundSet
}

func (t *BashTool) Name() string { return "Bash" }

func (t *BashTool) Description() string { return BashDescription }

func (t *BashTool) Category() ToolCategory { return CategoryCommand }

// IsConcurrencySafe allows read-only commands to run concurrently with other
// read-only tools; mutating commands must run exclusively.
//
// Commands like ls, cat, and git status mutate no external state, just like
// ReadFile, so there is no risk of interference. Commands like rm, mv, and
// npm install would break the model-intended execution order if run concurrently.
// The check reuses the safe-command allowlist; redirections, pipes, command
// chaining, and command substitution are all excluded.
func (t *BashTool) IsConcurrencySafe(args map[string]any) bool {
	cmd, ok := args["command"].(string)
	return ok && IsSafeCommand(cmd)
}

// SetBackgroundTaskManager injects the shared background task registry
// (BackgroundableTool).
func (t *BashTool) SetBackgroundTaskManager(mgr BackgroundTaskManager) { t.TaskManager = mgr }

// BackgroundEnabled reports whether the background subsystem is available:
// a task manager is wired and not disabled via YUKINO_DISABLE_BACKGROUND_TASKS.
func (t *BashTool) BackgroundEnabled() bool {
	return t.TaskManager != nil && backgroundTasksEnabled()
}

// HasForegroundTasks reports whether at least one foreground Bash command runs.
func (t *BashTool) HasForegroundTasks() bool { return t.foreground().hasAny() }

// BackgroundForegroundTasks moves every running foreground Bash command to
// the background and returns how many were actually backgrounded.
func (t *BashTool) BackgroundForegroundTasks() int { return t.foreground().backgroundAll() }

func (t *BashTool) foreground() *foregroundSet {
	t.fgOnce.Do(func() { t.fg = newForegroundSet() })
	return t.fg
}

// sandboxMandatory reports whether the command must run inside the OS sandbox:
// a configured Sandbox is always mandatory, and SandboxRequired additionally
// demands a sandbox when none was configured (TS: bash.ts execute gate
// `sandboxRequired || sandbox`).
func (t *BashTool) sandboxMandatory() bool { return t.SandboxRequired || t.Sandbox != nil }

// sandboxAvailabilityError fails closed when a mandatory sandbox is missing or
// unavailable (TS: bash.ts "sandbox is enabled but unavailable" / "<impl>
// sandbox is unavailable" errors). nil means the sandbox can be used.
func (t *BashTool) sandboxAvailabilityError() error {
	if t.Sandbox == nil {
		return errors.New("sandbox is enabled but unavailable; command was not executed")
	}
	if !t.Sandbox.Available() {
		return fmt.Errorf("%s sandbox is unavailable; command was not executed", t.Sandbox.Implementation())
	}
	return nil
}

func (t *BashTool) Schema() map[string]any {
	properties := map[string]any{
		"command": map[string]any{"type": "string", "description": "Shell command to execute"},
		"timeout": map[string]any{"type": "integer", "description": "Timeout in seconds (max 600)", "default": 120},
	}
	description := t.Description()
	if t.BackgroundEnabled() {
		properties["run_in_background"] = map[string]any{
			"type":        "boolean",
			"description": "Run the command in the background. Returns a task ID immediately; the result arrives later as a task notification.",
			"default":     false,
		}
		description += "\n" + BashBackgroundDescription
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

func (t *BashTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	command, _ := args["command"].(string)
	if command == "" {
		return ToolResult{Output: "Error: command is required", IsError: true}
	}

	// TS bash.ts:206-210 — a per-run manager carried on the tool context
	// takes precedence over the host-wired instance manager (an explicit nil
	// disables backgrounding for the run).
	mgr := resolveBackgroundTaskManager(ctx, t.TaskManager)
	return t.executeBackgroundable(ctx, command, args, mgr)
}

// executeBackgroundable runs the command through the shared background
// plumbing: output streams directly into a spill file, run_in_background is
// honored, and a foreground command that exceeds its timeout is moved to the
// background automatically instead of being killed (unless it is a bare
// sleep). TS takes this same path regardless of whether a task manager is
// wired; with none, backgrounding simply stays unavailable.
func (t *BashTool) executeBackgroundable(ctx context.Context, command string, args map[string]any, mgr BackgroundTaskManager) ToolResult {
	timeout := intArg(args, "timeout", 120)
	if nonFiniteNumberArg(args, "timeout") || timeout <= 0 {
		return ToolResult{Output: "Error: timeout must be a finite number greater than 0 seconds", IsError: true}
	}
	if timeout > maxTimeout {
		timeout = maxTimeout
	}
	runInBackground := boolArg(args, "run_in_background") && backgroundTasksEnabled()

	// TS: cwd and the spill directory come from the per-call tool context
	// (ctx.workDir / ctx.sessionId); forked and sub-agent registries share
	// this tool instance while running against a different workspace, so the
	// struct field is only a fallback for calls without a ctx workDir.
	workDir := WorkDirFromContext(ctx)
	if workDir == "" {
		workDir = t.WorkDir
	}
	sessionID := t.SessionID
	if id, ok := SessionIDFromContext(ctx); ok {
		sessionID = id
	}

	cfg := shellRunConfig{
		prompt:                   "$ ",
		executable:               "bash",
		args:                     []string{"-c", command},
		command:                  command,
		workDir:                  workDir,
		sessionID:                sessionID,
		toolCallID:               ToolCallIDFromContext(ctx),
		timeout:                  timeout,
		disallowedAutoBackground: disallowedBashAutoBackground,
		idPrefix:                 "bash",
	}
	if t.sandboxMandatory() {
		// Fail closed: a mandatory but missing/unavailable sandbox aborts the
		// command instead of silently running it unprotected (TS: bash.ts).
		if err := t.sandboxAvailabilityError(); err != nil {
			return ToolResult{Output: "Error: " + err.Error(), IsError: true}
		}
		cfg.prepare = func(outputPath string) (string, []string, error) {
			// TS default: writes unrestricted except for the deny list, network
			// enabled.
			sc := sandbox.Config{NetworkEnabled: true}
			if t.SandboxConfig != nil {
				sc = *t.SandboxConfig
			}
			// The child writes its output file directly; grant write access to
			// that path even under a strict AllowWrite config.
			sc.AllowWrite = append(append([]string{}, sc.AllowWrite...), outputPath)
			prepared, err := t.Sandbox.Prepare(command, sc)
			if err != nil {
				return "", nil, err
			}
			// Spawn the sandbox tool directly with its argv; never re-quote
			// into a shell string (would re-parse outside the sandbox).
			return prepared.Executable, prepared.Args, nil
		}
	}
	return runShellCommand(ctx, cfg, mgr, t.foreground(), runInBackground)
}
