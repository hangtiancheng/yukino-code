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
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTaskManager is a minimal in-test BackgroundTaskManager recording the
// lifecycle calls the shell plumbing makes.
type fakeTaskManager struct {
	mu    sync.Mutex
	order []string
	tasks map[string]*fakeTaskRecord
}

type fakeTaskRecord struct {
	id        string
	name      string
	running   bool
	completed bool
	failed    bool
	output    string
	cancel    context.CancelFunc
	done      chan struct{}
	opts      BackgroundTaskOptions
}

func newFakeTaskManager() *fakeTaskManager {
	return &fakeTaskManager{tasks: make(map[string]*fakeTaskRecord)}
}

func (m *fakeTaskManager) CreateTask(name string, opts BackgroundTaskOptions) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := fmt.Sprintf("task-%d", len(m.order)+1)
	m.tasks[id] = &fakeTaskRecord{id: id, name: name, done: make(chan struct{}), opts: opts}
	m.order = append(m.order, id)
	return id
}

func (m *fakeTaskManager) SetRunning(id string, cancel context.CancelFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if task, ok := m.tasks[id]; ok {
		task.running = true
		task.cancel = cancel
	}
}

func (m *fakeTaskManager) SetCompleted(id, output string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if task, ok := m.tasks[id]; ok && !task.completed && !task.failed {
		task.completed = true
		task.output = output
		close(task.done)
	}
}

func (m *fakeTaskManager) SetFailed(id, errMsg string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if task, ok := m.tasks[id]; ok && !task.completed && !task.failed {
		task.failed = true
		task.output = errMsg
		close(task.done)
	}
}

func (m *fakeTaskManager) SetTaskFailure(id, output string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if task, ok := m.tasks[id]; ok && !task.completed && !task.failed {
		task.failed = true
		task.output = output
		close(task.done)
	}
}

func (m *fakeTaskManager) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.order)
}

// waitDone blocks until the first created task reaches a terminal state.
func (m *fakeTaskManager) waitDone(t *testing.T, timeout time.Duration) *fakeTaskRecord {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		var task *fakeTaskRecord
		if len(m.order) > 0 {
			task = m.tasks[m.order[0]]
		}
		m.mu.Unlock()
		if task != nil {
			select {
			case <-task.done:
				return task
			case <-time.After(10 * time.Millisecond):
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no background task finished within %s", timeout)
	return nil
}

func skipWithoutPOSIXShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("requires a POSIX shell")
	}
}

func TestRunShellCommandForegroundCompletes(t *testing.T) {
	skipWithoutPOSIXShell(t)
	mgr := newFakeTaskManager()
	result := runShellCommand(context.Background(), shellRunConfig{
		prompt:     "$ ",
		executable: "sh",
		args:       []string{"-c", "echo hello"},
		command:    "echo hello",
		timeout:    30,
		idPrefix:   "test",
	}, mgr, newForegroundSet(), false)

	if result.IsError {
		t.Fatalf("result = %+v", result)
	}
	if !strings.HasPrefix(result.Output, "$ echo hello\n") || !strings.Contains(result.Output, "hello") {
		t.Errorf("output = %q", result.Output)
	}
	if mgr.count() != 0 {
		t.Error("a foreground run must not create background tasks")
	}
}

func TestRunShellCommandForegroundNonZeroExit(t *testing.T) {
	skipWithoutPOSIXShell(t)
	result := runShellCommand(context.Background(), shellRunConfig{
		prompt:     "$ ",
		executable: "sh",
		args:       []string{"-c", "exit 7"},
		command:    "exit 7",
		timeout:    30,
		idPrefix:   "test",
	}, newFakeTaskManager(), newForegroundSet(), false)

	if !result.IsError {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Output, "Exit code 7") {
		t.Errorf("output = %q", result.Output)
	}
}

func TestRunShellCommandExplicitBackground(t *testing.T) {
	skipWithoutPOSIXShell(t)
	mgr := newFakeTaskManager()
	result := runShellCommand(context.Background(), shellRunConfig{
		prompt:     "$ ",
		executable: "sh",
		args:       []string{"-c", "sleep 0.2; echo bg-done"},
		command:    "sleep 0.2; echo bg-done",
		timeout:    30,
		idPrefix:   "test",
	}, mgr, newForegroundSet(), true)

	if result.IsError {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Output, "Command running in background (task_id: ") {
		t.Errorf("output = %q", result.Output)
	}

	task := mgr.waitDone(t, 15*time.Second)
	if !task.completed {
		t.Errorf("task failed: %q", task.output)
	}
	if !strings.Contains(task.output, "bg-done") {
		t.Errorf("task output = %q", task.output)
	}
	if task.name != "sleep 0.2; echo bg-done" {
		t.Errorf("task name = %q", task.name)
	}
}

func TestRunShellCommandTimeoutAutoBackground(t *testing.T) {
	skipWithoutPOSIXShell(t)
	mgr := newFakeTaskManager()
	result := runShellCommand(context.Background(), shellRunConfig{
		prompt:     "$ ",
		executable: "sh",
		args:       []string{"-c", "sleep 1.4; echo late-done"},
		command:    "long-build",
		timeout:    1,
		idPrefix:   "test",
		// The display command's first token is not a bare sleep, so
		// auto-backgrounding is allowed even though the script sleeps.
		disallowedAutoBackground: map[string]bool{"sleep": true},
	}, mgr, newForegroundSet(), false)

	if result.IsError {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Output, "exceeded its 1s timeout and was moved to the background") {
		t.Errorf("output = %q", result.Output)
	}

	task := mgr.waitDone(t, 15*time.Second)
	if !task.completed || !strings.Contains(task.output, "late-done") {
		t.Errorf("task = %+v", task)
	}
}

func TestRunShellCommandBareSleepKilledOnTimeout(t *testing.T) {
	skipWithoutPOSIXShell(t)
	mgr := newFakeTaskManager()
	result := runShellCommand(context.Background(), shellRunConfig{
		prompt:                   "$ ",
		executable:               "sh",
		args:                     []string{"-c", "sleep 5"},
		command:                  "sleep 5",
		timeout:                  1,
		idPrefix:                 "test",
		disallowedAutoBackground: map[string]bool{"sleep": true},
	}, mgr, newForegroundSet(), false)

	if !result.IsError {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Output, "Error: command timed out after 1s") {
		t.Errorf("output = %q", result.Output)
	}
	if mgr.count() != 0 {
		t.Error("a killed bare sleep must not create a background task")
	}
}

func TestRunShellCommandManualBackground(t *testing.T) {
	skipWithoutPOSIXShell(t)
	mgr := newFakeTaskManager()
	fg := newForegroundSet()
	resultCh := make(chan ToolResult, 1)
	go func() {
		resultCh <- runShellCommand(context.Background(), shellRunConfig{
			prompt:     "$ ",
			executable: "sh",
			args:       []string{"-c", "sleep 1.2; echo manual-done"},
			command:    "sleep 1.2; echo manual-done",
			timeout:    30,
			idPrefix:   "test",
		}, mgr, fg, false)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for !fg.hasAny() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !fg.hasAny() {
		t.Fatal("foreground execution was not registered for manual backgrounding")
	}
	if n := fg.backgroundAll(); n != 1 {
		t.Errorf("backgroundAll() = %d, want 1", n)
	}

	select {
	case result := <-resultCh:
		if !strings.Contains(result.Output, "manually backgrounded by the user") {
			t.Errorf("output = %q", result.Output)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("manual backgrounding did not release the foreground call")
	}
	if fg.hasAny() {
		t.Error("foreground set must be empty after backgrounding")
	}

	task := mgr.waitDone(t, 15*time.Second)
	if !task.completed || !strings.Contains(task.output, "manual-done") {
		t.Errorf("task = %+v", task)
	}
}

func TestRunShellCommandContextCancel(t *testing.T) {
	skipWithoutPOSIXShell(t)
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan ToolResult, 1)
	go func() {
		resultCh <- runShellCommand(ctx, shellRunConfig{
			prompt:     "$ ",
			executable: "sh",
			args:       []string{"-c", "sleep 5"},
			command:    "sleep 5",
			timeout:    30,
			idPrefix:   "test",
		}, newFakeTaskManager(), newForegroundSet(), false)
	}()
	time.Sleep(150 * time.Millisecond)
	cancel()

	select {
	case result := <-resultCh:
		if !result.IsError || !strings.Contains(result.Output, "Error: command interrupted") {
			t.Errorf("result = %+v", result)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancellation did not interrupt the command")
	}
}

func TestIsAutobackgroundingAllowed(t *testing.T) {
	disallowed := map[string]bool{"sleep": true, "start-sleep": true}
	cases := []struct {
		command string
		want    bool
	}{
		{"sleep 60", false},
		{"  sleep 60", false},
		{"/bin/sleep 60", false},
		{"SLEEP 60", false},
		{"'sleep' 60", false},
		{`"sleep" 60`, false},
		{"Start-Sleep 60", false},
		{"npm run build && sleep 1", true},
		{"make test", true},
		{"echo sleep", true},
	}
	for _, tc := range cases {
		if got := isAutobackgroundingAllowed(tc.command, disallowed); got != tc.want {
			t.Errorf("isAutobackgroundingAllowed(%q) = %v, want %v", tc.command, got, tc.want)
		}
	}
}

func TestBackgroundTaskName(t *testing.T) {
	if got := backgroundTaskName("  echo   hi  "); got != "echo hi" {
		t.Errorf("backgroundTaskName() = %q", got)
	}
	long := strings.Repeat("x", 100)
	got := backgroundTaskName(long)
	if len([]rune(got)) != 80 || !strings.HasSuffix(got, "...") {
		t.Errorf("long name = %d runes, suffix %q", len([]rune(got)), got[77:])
	}
}

func TestBackgroundMessage(t *testing.T) {
	if got := backgroundMessage(BackgroundExplicit, "t1", 30); !strings.Contains(got, "task_id: t1") ||
		!strings.Contains(got, "Command running in background") {
		t.Errorf("explicit = %q", got)
	}
	if got := backgroundMessage(BackgroundTimeout, "t2", 45); !strings.Contains(got, "exceeded its 45s timeout") ||
		!strings.Contains(got, "task_id: t2") {
		t.Errorf("timeout = %q", got)
	}
	if got := backgroundMessage(BackgroundUser, "t3", 30); !strings.Contains(got, "manually backgrounded by the user") ||
		!strings.Contains(got, "task_id: t3") {
		t.Errorf("user = %q", got)
	}
}

func TestSliceUtf8Safe(t *testing.T) {
	buf := []byte("a日本😁z")
	cases := []struct {
		maxBytes int
		want     string
	}{
		{100, "a日本😁z"},
		{12, "a日本😁z"},
		{9, "a日本"},
		{8, "a日本"},
		{4, "a日"},
		{2, "a"},
		{1, "a"},
		{0, ""},
	}
	for _, tc := range cases {
		if got := string(sliceUtf8Safe(buf, tc.maxBytes)); got != tc.want {
			t.Errorf("sliceUtf8Safe(_, %d) = %q, want %q", tc.maxBytes, got, tc.want)
		}
	}
}

// TestReadOutputFileUTF8Boundary mirrors the TS shell-background test.
func TestReadOutputFileUTF8Boundary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "output")
	if err := os.WriteFile(path, []byte("a日本🙂z"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		limit int
		want  string
	}{
		{2, "a"},
		{4, "a日"},
		{6, "a日"},
		{9, "a日本"},
	}
	for _, tc := range cases {
		text, size, truncated := readOutputFile(path, tc.limit)
		if text != tc.want || size != 12 || !truncated {
			t.Errorf("readOutputFile(_, %d) = (%q, %d, %v), want (%q, 12, true)",
				tc.limit, text, size, truncated, tc.want)
		}
	}
	text, size, truncated := readOutputFile(path, 12)
	if text != "a日本🙂z" || size != 12 || truncated {
		t.Errorf("full read = (%q, %d, %v)", text, size, truncated)
	}
	text, size, truncated = readOutputFile(filepath.Join(dir, "missing"), 10)
	if text != "" || size != 0 || truncated {
		t.Errorf("missing file = (%q, %d, %v)", text, size, truncated)
	}
}

func TestFormatFinalResult(t *testing.T) {
	result := formatFinalResult("$ ", "x", shellExit{spawnError: "exec: pwsh not found"}, "", false, 30)
	if !result.IsError || !strings.Contains(result.Output, "Error executing command: exec: pwsh not found") {
		t.Errorf("spawn error = %+v", result)
	}

	result = formatFinalResult("$ ", "x", shellExit{timedOut: true}, "partial", false, 30)
	if !result.IsError || !strings.Contains(result.Output, "Error: command timed out after 30s") ||
		!strings.Contains(result.Output, "partial") {
		t.Errorf("timeout = %+v", result)
	}

	result = formatFinalResult("$ ", "x", shellExit{aborted: true}, "", false, 30)
	if !result.IsError || result.Output != "Error: command interrupted" {
		t.Errorf("abort = %+v", result)
	}

	result = formatFinalResult("$ ", "grep x .", shellExit{code: 1, hasCode: true}, "", false, 30)
	if !result.IsError || !strings.Contains(result.Output, "Exit code 1 (no matches found)") {
		t.Errorf("hinted exit = %+v", result)
	}

	result = formatFinalResult("$ ", "somecmd", shellExit{code: 3, hasCode: true}, "", false, 30)
	if !result.IsError || !strings.Contains(result.Output, "\nExit code 3") ||
		strings.Contains(result.Output, "Exit code 3 (") {
		t.Errorf("plain exit = %+v", result)
	}

	result = formatFinalResult("$ ", "x", shellExit{hasCode: false, signal: "SIGKILL"}, "", false, 30)
	if !result.IsError || !strings.Contains(result.Output, "Process terminated by SIGKILL") {
		t.Errorf("signal = %+v", result)
	}

	result = formatFinalResult("$ ", "echo hi", shellExit{code: 0, hasCode: true}, "hi\n", false, 30)
	if result.IsError || result.Output != "$ echo hi\nhi\n" {
		t.Errorf("success = %+v", result)
	}
}

func TestBuildBackgroundBody(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out")

	// Small outputs are inlined and the file is deleted.
	if err := os.WriteFile(path, []byte("hello bg"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := buildBackgroundBody("$ ", "echo hello bg", shellExit{code: 0, hasCode: true}, path, 30)
	if result.IsError || !strings.Contains(result.Output, "hello bg") {
		t.Errorf("small body = %+v", result)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("small output file must be deleted after inlining")
	}

	// Large outputs keep the file and quote its path with a preview.
	big := strings.Repeat("x", BackgroundNotificationChars+10)
	if err := os.WriteFile(path, []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	result = buildBackgroundBody("$ ", "big", shellExit{code: 0, hasCode: true}, path, 30)
	if !strings.Contains(result.Output, "<persisted-output>") || !strings.Contains(result.Output, path) {
		t.Errorf("large body = %.200q", result.Output)
	}
	if !strings.Contains(result.Output, "Preview (first 2KB):") {
		t.Error("large body must carry a preview")
	}
	if _, err := os.Stat(path); err != nil {
		t.Error("large output file must stay on disk")
	}

	// The size watchdog kill is surfaced as an error.
	result = buildBackgroundBody("$ ", "big", shellExit{code: 0, hasCode: true, sizeKilled: true}, path, 30)
	if !result.IsError || !strings.Contains(result.Output, "output file exceeded 5GB") {
		t.Errorf("size kill = %+v", result)
	}
}

func TestBuildPersistedOutputPreview(t *testing.T) {
	small := buildPersistedOutputPreview(1024, "abc", "/tmp/x")
	if !strings.Contains(small, "Output too large (1KB)") || strings.Contains(small, "\n...") {
		t.Errorf("small preview = %q", small)
	}
	large := buildPersistedOutputPreview(toolResultPreviewChars+1, "abc", "/tmp/x")
	if !strings.HasSuffix(large, "\n...\n</persisted-output>") {
		t.Errorf("large preview = %q", large)
	}
}

func TestForegroundSet(t *testing.T) {
	set := newForegroundSet()
	if set.hasAny() {
		t.Error("fresh set must be empty")
	}
	key := set.add("bash", func() bool { return false })
	if !set.hasAny() {
		t.Error("set must track added entries")
	}
	if n := set.backgroundAll(); n != 0 {
		t.Errorf("backgroundAll() = %d when the entry refuses", n)
	}
	set.remove(key)
	set.remove("")
	if set.hasAny() {
		t.Error("set must drop removed entries")
	}
}

func TestAttachBackgroundTaskManager(t *testing.T) {
	t.Setenv("YUKINO_DISABLE_BACKGROUND_TASKS", "")
	registry := NewRegistry()
	bash := &BashTool{}
	ps := &PowerShellTool{}
	registry.Register(bash)
	registry.Register(ps)
	registry.Register(&GlobTool{})

	mgr := newFakeTaskManager()
	AttachBackgroundTaskManager(registry, mgr)
	if bash.TaskManager != mgr {
		t.Error("Bash did not receive the shared task manager")
	}
	if ps.TaskManager != mgr {
		t.Error("PowerShell did not receive the shared task manager")
	}
	if !bash.BackgroundEnabled() || !ps.BackgroundEnabled() {
		t.Error("both shell tools must report backgrounding enabled")
	}
	if HasAnyForegroundTasks(registry) {
		t.Error("no foreground tasks expected")
	}
	if n := BackgroundAllForegroundTasks(registry); n != 0 {
		t.Errorf("BackgroundAllForegroundTasks() = %d", n)
	}
}

func TestBackgroundTasksEnabledEnv(t *testing.T) {
	t.Setenv("YUKINO_DISABLE_BACKGROUND_TASKS", "1")
	if backgroundTasksEnabled() {
		t.Error("background tasks must be disabled with the env flag")
	}
	t.Setenv("YUKINO_DISABLE_BACKGROUND_TASKS", "")
	if !backgroundTasksEnabled() {
		t.Error("background tasks must be enabled without the env flag")
	}
}
