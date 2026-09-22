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
	"reflect"
	"strings"
	"testing"
)

func lookPathStub(available ...string) func(string) (string, error) {
	set := make(map[string]bool, len(available))
	for _, name := range available {
		set[name] = true
	}
	return func(name string) (string, error) {
		if set[name] {
			return "/usr/bin/" + name, nil
		}
		return "", exec.ErrNotFound
	}
}

func TestResolvePowerShellExecutable(t *testing.T) {
	cases := []struct {
		goos      string
		available []string
		want      string
	}{
		{"windows", nil, "powershell.exe"},
		{"windows", []string{"pwsh"}, "powershell.exe"},
		{"darwin", []string{"pwsh"}, "pwsh"},
		{"linux", []string{"powershell"}, "powershell"},
		{"linux", []string{"pwsh", "powershell"}, "pwsh"},
		{"darwin", nil, "pwsh"},
	}
	for _, tc := range cases {
		got := resolvePowerShellExecutable(tc.goos, lookPathStub(tc.available...))
		if got != tc.want {
			t.Errorf("resolvePowerShellExecutable(%q, %v) = %q, want %q",
				tc.goos, tc.available, got, tc.want)
		}
	}
}

func TestPowerShellInvocation(t *testing.T) {
	miss := lookPathStub()

	exe, args, hint := powerShellInvocation("windows", "Get-Process", miss)
	if exe != "powershell.exe" {
		t.Errorf("windows executable = %q", exe)
	}
	wantArgs := []string{
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nGet-Process",
	}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Errorf("windows args = %v", args)
	}
	if hint != "" {
		t.Errorf("windows hint = %q, want empty", hint)
	}

	exe, args, hint = powerShellInvocation("darwin", "Get-Process", miss)
	if exe != "pwsh" {
		t.Errorf("darwin executable = %q", exe)
	}
	wantArgs = []string{"-NoProfile", "-NonInteractive", "-Command", "Get-Process"}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Errorf("darwin args = %v", args)
	}
	if !strings.Contains(hint, "pwsh is required on macOS/Linux") {
		t.Errorf("darwin hint = %q", hint)
	}
}

func TestPowerShellToolSchemaGating(t *testing.T) {
	tool := &PowerShellTool{}

	schema := tool.Schema()
	props := schema["input_schema"].(map[string]any)["properties"].(map[string]any)
	if _, ok := props["run_in_background"]; ok {
		t.Error("run_in_background must not appear without a task manager")
	}
	if strings.Contains(schema["description"].(string), "run_in_background") {
		t.Error("description must not advertise backgrounding without a task manager")
	}

	tool.TaskManager = newFakeTaskManager()
	t.Setenv("YUKINO_DISABLE_BACKGROUND_TASKS", "")
	if !tool.BackgroundEnabled() {
		t.Error("BackgroundEnabled() = false with a manager and no env disable")
	}
	schema = tool.Schema()
	props = schema["input_schema"].(map[string]any)["properties"].(map[string]any)
	if _, ok := props["run_in_background"]; !ok {
		t.Error("run_in_background must appear when backgrounding is available")
	}
	if !strings.Contains(schema["description"].(string), "run_in_background") {
		t.Error("description must advertise backgrounding when available")
	}

	t.Setenv("YUKINO_DISABLE_BACKGROUND_TASKS", "1")
	if tool.BackgroundEnabled() {
		t.Error("YUKINO_DISABLE_BACKGROUND_TASKS=1 must disable backgrounding")
	}
	schema = tool.Schema()
	props = schema["input_schema"].(map[string]any)["properties"].(map[string]any)
	if _, ok := props["run_in_background"]; ok {
		t.Error("run_in_background must disappear when backgrounding is disabled")
	}
}

// TestPowerShellToolExecuteValidation covers the guards that return before any
// process is spawned.
func TestPowerShellToolExecuteValidation(t *testing.T) {
	tool := &PowerShellTool{}

	result := tool.Execute(context.Background(), map[string]any{})
	if !result.IsError || result.Output != "Error: command is required" {
		t.Errorf("missing command = %+v", result)
	}

	result = tool.Execute(context.Background(), map[string]any{"command": "Get-Process", "timeout": 0.0})
	if !result.IsError || !strings.Contains(result.Output, "timeout must be a finite number greater than 0 seconds") {
		t.Errorf("zero timeout = %+v", result)
	}
}

func TestBashToolExecuteValidation(t *testing.T) {
	tool := &BashTool{TaskManager: newFakeTaskManager()}

	result := tool.Execute(context.Background(), map[string]any{})
	if !result.IsError || result.Output != "Error: command is required" {
		t.Errorf("missing command = %+v", result)
	}

	result = tool.Execute(context.Background(), map[string]any{"command": "echo hi", "timeout": -1.0})
	if !result.IsError || !strings.Contains(result.Output, "timeout must be a finite number greater than 0 seconds") {
		t.Errorf("negative timeout = %+v", result)
	}
}
