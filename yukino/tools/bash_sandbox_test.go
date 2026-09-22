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
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/sandbox"
)

// stubSandbox is a controllable sandbox.Sandbox for the fail-closed gate and
// argv passthrough tests.
type stubSandbox struct {
	available   bool
	prepareErr  error
	prepared    sandbox.PreparedCommand
	lastCommand string
	lastConfig  sandbox.Config
}

func (s *stubSandbox) Implementation() string { return "stub" }
func (s *stubSandbox) Available() bool        { return s.available }
func (s *stubSandbox) Prepare(command string, config sandbox.Config) (sandbox.PreparedCommand, error) {
	s.lastCommand = command
	s.lastConfig = config
	if s.prepareErr != nil {
		return sandbox.PreparedCommand{}, s.prepareErr
	}
	return s.prepared, nil
}

// TestBashFailClosedSandboxRequiredButNil: SandboxRequired with no configured
// sandbox must abort the command instead of running it unprotected
// (TS: bash.ts "sandbox is enabled but unavailable").
func TestBashFailClosedSandboxRequiredButNil(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "marker")
	tool := &BashTool{WorkDir: dir, SandboxRequired: true}
	res := tool.Execute(context.Background(), map[string]any{"command": "touch " + marker})
	if !res.IsError {
		t.Fatalf("result = %+v, want error", res)
	}
	want := "Error: sandbox is enabled but unavailable; command was not executed"
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("command ran without a sandbox despite SandboxRequired")
	}
}

// TestBashFailClosedSandboxUnavailable: a configured sandbox whose tooling is
// unavailable must abort the command (TS: bash.ts "<impl> sandbox is unavailable").
func TestBashFailClosedSandboxUnavailable(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "marker")
	tool := &BashTool{WorkDir: dir, Sandbox: &stubSandbox{available: false}}
	res := tool.Execute(context.Background(), map[string]any{"command": "touch " + marker})
	if !res.IsError {
		t.Fatalf("result = %+v, want error", res)
	}
	want := "Error: stub sandbox is unavailable; command was not executed"
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("command ran without a sandbox despite unavailable sandbox")
	}
}

// TestBashFailClosedPrepareError: a Prepare failure must abort the command
// (TS: bash.ts "Error preparing sandbox"), never fall back to unsandboxed.
func TestBashFailClosedPrepareError(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "marker")
	tool := &BashTool{WorkDir: dir, Sandbox: &stubSandbox{available: true, prepareErr: errors.New("boom")}}
	res := tool.Execute(context.Background(), map[string]any{"command": "touch " + marker})
	if !res.IsError {
		t.Fatalf("result = %+v, want error", res)
	}
	want := "Error preparing sandbox: boom"
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("command ran despite Prepare failure")
	}
}

// TestBashSandboxPreparedArgvIsExecuted: the process must be spawned from the
// prepared executable/argv directly, not via bash -c of the original command.
func TestBashSandboxPreparedArgvIsExecuted(t *testing.T) {
	skipWithoutPOSIXShell(t)
	stub := &stubSandbox{
		available: true,
		prepared:  sandbox.PreparedCommand{Executable: "bash", Args: []string{"-c", "echo SANDBOXED"}},
	}
	tool := &BashTool{WorkDir: t.TempDir(), Sandbox: stub}
	res := tool.Execute(context.Background(), map[string]any{"command": "echo ORIGINAL"})
	if res.IsError {
		t.Fatalf("result = %+v", res)
	}
	if !strings.Contains(res.Output, "SANDBOXED") {
		t.Errorf("output = %q, want SANDBOXED", res.Output)
	}
	// ORIGINAL may only appear in the "$ echo ORIGINAL" transcript header,
	// never as command output.
	if n := strings.Count(res.Output, "ORIGINAL"); n != 1 {
		t.Errorf("output = %q, want ORIGINAL only in the transcript header", res.Output)
	}
}

// TestBashSandboxCommandPassedVerbatim: shell metacharacters and real newlines
// reach Prepare unmodified — no intermediate shell may re-parse them.
func TestBashSandboxCommandPassedVerbatim(t *testing.T) {
	skipWithoutPOSIXShell(t)
	command := "echo $(whoami) `id`\ntrue"
	stub := &stubSandbox{
		available: true,
		prepared:  sandbox.PreparedCommand{Executable: "bash", Args: []string{"-c", ":"}},
	}
	tool := &BashTool{WorkDir: t.TempDir(), Sandbox: stub}
	if res := tool.Execute(context.Background(), map[string]any{"command": command}); res.IsError {
		t.Fatalf("result = %+v", res)
	}
	if stub.lastCommand != command {
		t.Errorf("Prepare received %q, want verbatim %q", stub.lastCommand, command)
	}
}

// TestBashBackgroundableFailClosedUnavailable: the backgroundable path fails
// closed before any output file or process is created.
func TestBashBackgroundableFailClosedUnavailable(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "marker")
	tool := &BashTool{WorkDir: dir, TaskManager: newFakeTaskManager(), Sandbox: &stubSandbox{available: false}}
	res := tool.Execute(context.Background(), map[string]any{"command": "touch " + marker})
	if !res.IsError {
		t.Fatalf("result = %+v, want error", res)
	}
	want := "Error: stub sandbox is unavailable; command was not executed"
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("command ran without a sandbox despite unavailable sandbox")
	}
}

// TestBashBackgroundableSandboxArgvAndOutputFileAllowWrite: the backgroundable
// path spawns the prepared argv and grants the spill file write access
// (TS: bash.ts allowWrite + outputFile.path) without mutating the base config.
func TestBashBackgroundableSandboxArgvAndOutputFileAllowWrite(t *testing.T) {
	skipWithoutPOSIXShell(t)
	stub := &stubSandbox{
		available: true,
		prepared:  sandbox.PreparedCommand{Executable: "bash", Args: []string{"-c", "echo BG-SANDBOXED"}},
	}
	tool := &BashTool{
		WorkDir:       t.TempDir(),
		TaskManager:   newFakeTaskManager(),
		Sandbox:       stub,
		SandboxConfig: &sandbox.Config{AllowWrite: []string{"/base"}, NetworkEnabled: true},
	}
	res := tool.Execute(context.Background(), map[string]any{"command": "echo ORIGINAL"})
	if res.IsError {
		t.Fatalf("result = %+v", res)
	}
	if !strings.Contains(res.Output, "BG-SANDBOXED") {
		t.Errorf("output = %q, want BG-SANDBOXED", res.Output)
	}
	if len(stub.lastConfig.AllowWrite) != 2 || stub.lastConfig.AllowWrite[0] != "/base" || stub.lastConfig.AllowWrite[1] == "" {
		t.Errorf("AllowWrite = %q, want [/base <output file>]", stub.lastConfig.AllowWrite)
	}
	if len(tool.SandboxConfig.AllowWrite) != 1 {
		t.Errorf("SandboxConfig.AllowWrite was mutated: %q", tool.SandboxConfig.AllowWrite)
	}
}

// TestBashWithoutSandboxRunsPlainBash: with no sandbox configured and not
// required, commands run directly under bash (no regression).
func TestBashWithoutSandboxRunsPlainBash(t *testing.T) {
	skipWithoutPOSIXShell(t)
	tool := &BashTool{WorkDir: t.TempDir()}
	res := tool.Execute(context.Background(), map[string]any{"command": "echo plain-ok"})
	if res.IsError {
		t.Fatalf("result = %+v", res)
	}
	if !strings.Contains(res.Output, "plain-ok") {
		t.Errorf("output = %q, want plain-ok", res.Output)
	}
}
