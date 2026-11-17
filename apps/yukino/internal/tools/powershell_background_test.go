package tools_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// Mirrors tests/powershell-background.test.ts: the suite is skipped when pwsh
// is unavailable (Windows ships powershell.exe, so the probe only gates
// macOS/Linux hosts without PowerShell Core).

var (
	pwshProbeOnce sync.Once
	pwshProbeOK   bool
)

func pwshAvailable() bool {
	pwshProbeOnce.Do(func() {
		if runtime.GOOS == "windows" {
			pwshProbeOK = true
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		pwshProbeOK = exec.CommandContext(ctx, "pwsh", "-NoProfile", "-NonInteractive", "-Command", "exit 0").Run() == nil
	})
	return pwshProbeOK
}

func skipWithoutPwsh(t *testing.T) {
	t.Helper()
	if !pwshAvailable() {
		t.Skip("pwsh is not available on this host")
	}
}

func psContext(t *testing.T) context.Context {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	return tools.WithExecutionContext(context.Background(), tools.ExecutionContext{WorkDir: t.TempDir()})
}

var taskIDPattern = regexp.MustCompile(`task_id: (ps-\d+)\)`)

func taskIDFrom(t *testing.T, output string) string {
	t.Helper()
	match := taskIDPattern.FindStringSubmatch(output)
	if match == nil {
		t.Fatalf("expected a task_id in: %s", output)
	}
	return match[1]
}

func waitTask(t *testing.T, tasks *subagent.TaskManager, id string) tools.BackgroundTask {
	t.Helper()
	task, timedOut, err := tasks.Wait(context.Background(), id, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if timedOut || task == nil {
		t.Fatalf("task %s did not finish in time", id)
	}
	return *task
}

func TestPowerShellSchemaGatesBackgroundOnTaskManager(t *testing.T) {
	schemaJSON := func(tool *tools.PowerShellTool) string {
		data, err := json.Marshal(tool.Schema())
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if strings.Contains(schemaJSON(&tools.PowerShellTool{}), "run_in_background") {
		t.Fatal("bare tool must not expose run_in_background")
	}
	withManager := &tools.PowerShellTool{TaskManager: subagent.NewTaskManager()}
	if !strings.Contains(schemaJSON(withManager), "run_in_background") {
		t.Fatal("tool with a task manager must expose run_in_background")
	}
}

func TestPowerShellForegroundFdMode(t *testing.T) {
	skipWithoutPwsh(t)
	ps := &tools.PowerShellTool{}
	result := ps.Execute(psContext(t), map[string]any{"command": "Write-Output ps-fg"})
	if result.IsError {
		t.Fatal(result.Output)
	}
	if !strings.Contains(result.Output, "PS> ") || !strings.Contains(result.Output, "ps-fg") {
		t.Fatal(result.Output)
	}
}

func TestPowerShellLargeForegroundOutput(t *testing.T) {
	skipWithoutPwsh(t)
	for _, code := range []int{0, 7} {
		t.Run("exit-"+strconv.Itoa(code), func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			ctx := tools.WithExecutionContext(context.Background(), tools.ExecutionContext{
				WorkDir:   t.TempDir(),
				SessionID: "large-powershell-output",
			})
			ps := &tools.PowerShellTool{}
			result := ps.Execute(ctx, map[string]any{
				"command": fmt.Sprintf("[Console]::Write(('x' * 12000000)); [System.Threading.Thread]::Sleep(1100); [Console]::Write('finished'); exit %d", code),
				"timeout": 20,
			})
			if code == 0 && result.IsError {
				t.Fatal(result.Output)
			}
			if code != 0 && (!result.IsError || !strings.Contains(result.Output, "Exit code 7")) {
				t.Fatal(result.Output)
			}
			if !strings.Contains(result.Output, "<persisted-output>") {
				t.Fatal(result.Output)
			}
			if len(result.Output) >= 10000 {
				t.Fatalf("inline output too large: %d chars", len(result.Output))
			}
			match := regexp.MustCompile(`Full content saved to:\n([^\n]+)`).FindStringSubmatch(result.Output)
			if match == nil {
				t.Fatal("missing persisted output path")
			}
			path := match[1]
			defer os.Remove(path)
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Size() != 12000008 {
				t.Fatalf("persisted size = %d, want 12000008", info.Size())
			}
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			tail := make([]byte, 8)
			if _, err := file.ReadAt(tail, info.Size()-8); err != nil {
				t.Fatal(err)
			}
			if string(tail) != "finished" {
				t.Fatalf("tail = %q, want finished", tail)
			}
		})
	}
}

func TestPowerShellRunInBackgroundNotifies(t *testing.T) {
	skipWithoutPwsh(t)
	tasks := subagent.NewTaskManager()
	ps := &tools.PowerShellTool{TaskManager: tasks}
	result := ps.Execute(psContext(t), map[string]any{"command": "Write-Output ps-bg", "run_in_background": true})
	if result.IsError {
		t.Fatal(result.Output)
	}
	if !strings.Contains(result.Output, "do not poll") {
		t.Fatal(result.Output)
	}
	taskID := taskIDFrom(t, result.Output)
	task := waitTask(t, tasks, taskID)
	if task.Status != "completed" {
		t.Fatalf("status = %s (%s)", task.Status, task.Output)
	}
	notifications, err := tasks.DrainNotifications()
	if err != nil {
		t.Fatal(err)
	}
	parts := make([]string, 0, len(notifications))
	for _, notification := range notifications {
		parts = append(parts, subagent.FormatAgentTaskNotification(notification))
	}
	xml := strings.Join(parts, "\n")
	if !strings.Contains(xml, fmt.Sprintf(`task_id="%s" status="completed"`, taskID)) {
		t.Fatal(xml)
	}
	if !strings.Contains(xml, "ps-bg") {
		t.Fatal(xml)
	}
}

func TestPowerShellBackgroundNonZeroExitFails(t *testing.T) {
	skipWithoutPwsh(t)
	tasks := subagent.NewTaskManager()
	ps := &tools.PowerShellTool{TaskManager: tasks}
	result := ps.Execute(psContext(t), map[string]any{"command": "exit 3", "run_in_background": true})
	if result.IsError {
		t.Fatal(result.Output)
	}
	task := waitTask(t, tasks, taskIDFrom(t, result.Output))
	if task.Status != "failed" {
		t.Fatalf("status = %s", task.Status)
	}
	if !strings.Contains(task.Output, "Exit code 3") {
		t.Fatal(task.Output)
	}
	if strings.Contains(task.Output, "Error: task failed") {
		t.Fatal(task.Output)
	}
}

func TestPowerShellTimeoutMovesToBackground(t *testing.T) {
	skipWithoutPwsh(t)
	tasks := subagent.NewTaskManager()
	ps := &tools.PowerShellTool{TaskManager: tasks}
	result := ps.Execute(psContext(t), map[string]any{
		"command": "[System.Threading.Thread]::Sleep(1500); Write-Output late-ps",
		"timeout": 1,
	})
	if result.IsError {
		t.Fatal(result.Output)
	}
	if !strings.Contains(result.Output, "moved to the background") {
		t.Fatal(result.Output)
	}
	task := waitTask(t, tasks, taskIDFrom(t, result.Output))
	if task.Status != "completed" {
		t.Fatalf("status = %s (%s)", task.Status, task.Output)
	}
	if !strings.Contains(task.Output, "late-ps") {
		t.Fatal(task.Output)
	}
}

func TestPowerShellStartSleepTimeoutBackgrounds(t *testing.T) {
	skipWithoutPwsh(t)
	tasks := subagent.NewTaskManager()
	defer func() { _ = tasks.StopAll(context.Background()) }()
	ps := &tools.PowerShellTool{TaskManager: tasks}
	result := ps.Execute(psContext(t), map[string]any{"command": "Start-Sleep 5", "timeout": 1})
	if result.IsError {
		t.Fatal(result.Output)
	}
	if !strings.Contains(result.Output, "moved to the background") {
		t.Fatal(result.Output)
	}
	task := tasks.Get(taskIDFrom(t, result.Output))
	if task == nil || task.Status != "running" {
		t.Fatalf("task = %+v", task)
	}
}

func TestPowerShellManualBackground(t *testing.T) {
	skipWithoutPwsh(t)
	tasks := subagent.NewTaskManager()
	defer func() { _ = tasks.StopAll(context.Background()) }()
	ps := &tools.PowerShellTool{TaskManager: tasks}
	ctx := psContext(t)
	pending := make(chan tools.ToolResult, 1)
	go func() {
		pending <- ps.Execute(ctx, map[string]any{
			"command": "Start-Sleep -Milliseconds 1500; Write-Output ps-manual",
			"timeout": 30,
		})
	}()
	deadline := time.Now().Add(15 * time.Second)
	for !ps.HasForegroundTasks() {
		if time.Now().After(deadline) {
			t.Fatal("foreground command never registered")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if count := ps.BackgroundForegroundTasks(); count != 1 {
		t.Fatalf("backgrounded = %d, want 1", count)
	}
	if ps.HasForegroundTasks() {
		t.Fatal("foreground set must be empty after backgrounding")
	}
	result := <-pending
	if result.IsError {
		t.Fatal(result.Output)
	}
	if !strings.Contains(result.Output, "manually backgrounded by the user") {
		t.Fatal(result.Output)
	}
	task := waitTask(t, tasks, taskIDFrom(t, result.Output))
	if task.Status != "completed" {
		t.Fatalf("status = %s (%s)", task.Status, task.Output)
	}
	if !strings.Contains(task.Output, "ps-manual") {
		t.Fatal(task.Output)
	}
}

func TestPowerShellStopKillsProcessTree(t *testing.T) {
	skipWithoutPwsh(t)
	tasks := subagent.NewTaskManager()
	ps := &tools.PowerShellTool{TaskManager: tasks}
	result := ps.Execute(psContext(t), map[string]any{"command": "Start-Sleep 30", "run_in_background": true})
	if result.IsError {
		t.Fatal(result.Output)
	}
	taskID := taskIDFrom(t, result.Output)
	if task := tasks.Get(taskID); task == nil || task.Status != "running" {
		t.Fatalf("task = %+v", task)
	}
	stopped := time.Now()
	ok, err := tasks.Stop(taskID)
	if err != nil || !ok {
		t.Fatalf("stop = %v, %v", ok, err)
	}
	task := waitTask(t, tasks, taskID)
	if elapsed := time.Since(stopped); elapsed >= 3*time.Second {
		t.Fatalf("stop took %v, want < 3s", elapsed)
	}
	if task.Status != "cancelled" {
		t.Fatalf("status = %s", task.Status)
	}
}

// TestShellTimeoutParsing pins the reference intArg semantics shared by Bash
// and PowerShell: numeric-literal strings parse, fractional values truncate
// (so 0.5 is invalid, not a 1s floor), non-finite or unrecognized values
// fall back to the 120s default, and the result clamps to 600.
func TestShellTimeoutParsing(t *testing.T) {
	ctx := tools.WithExecutionContext(context.Background(), tools.ExecutionContext{WorkDir: t.TempDir()})
	cases := []struct {
		timeout   any
		wantError string
	}{
		{timeout: "30", wantError: ""},
		{timeout: " 45 ", wantError: ""},
		{timeout: "1e2", wantError: ""},
		{timeout: 0.5, wantError: "greater than 0"},
		{timeout: "0.5", wantError: "greater than 0"},
		{timeout: "-3", wantError: "greater than 0"},
		{timeout: "abc", wantError: ""},
		{timeout: true, wantError: ""},
		{timeout: 5000, wantError: ""},
	}
	for _, tc := range cases {
		tool := &tools.BashTool{}
		result := tool.Execute(ctx, map[string]any{"command": "true", "timeout": tc.timeout})
		if tc.wantError == "" {
			if strings.Contains(result.Output, "greater than 0") {
				t.Fatalf("timeout %#v: unexpected invalid error: %s", tc.timeout, result.Output)
			}
			continue
		}
		if !result.IsError || !strings.Contains(result.Output, tc.wantError) {
			t.Fatalf("timeout %#v: got %#v, want the invalid-timeout error", tc.timeout, result)
		}
	}
}
