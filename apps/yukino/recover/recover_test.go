package recovery

import (
	"errors"
	"fmt"
	"github.com/yukino-js/yukino/yukino/tools"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"testing"

	"github.com/yukino-js/yukino/yukino/storage"
)

func readLog(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(storage.YukinoPath("crash.log"))
	if err != nil {
		t.Fatalf("read crash log: %v", err)
	}
	return string(data)
}

func TestRecordAppends(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	Record("start pid=1")
	RecordError("main", "boom")

	log := readLog(t)
	if !strings.Contains(log, "start pid=1") {
		t.Errorf("start record missing: %s", log)
	}
	if !strings.Contains(log, "crash [main] boom") {
		t.Errorf("panic record missing: %s", log)
	}
	if !strings.Contains(log, "recover_test.go") {
		t.Errorf("stack missing: %s", log)
	}
	if strings.Index(log, "start pid=1") > strings.Index(log, "crash [main]") {
		t.Error("records are not in append order")
	}
}

func TestRecoverWritesStartAndExit(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Cleanup(func() { _ = debug.SetCrashOutput(nil, debug.CrashOptions{}) })

	recordExit := Recover()
	if got := readLog(t); !strings.Contains(got, "start pid=") {
		t.Errorf("start record missing: %s", got)
	}
	recordExit()
	RecordExit(1)

	log := readLog(t)
	if strings.Count(log, "exit pid=") != 1 || !strings.Contains(log, "code=0") {
		t.Errorf("exit record missing: %s", log)
	}
}

func TestIsTerminalGone(t *testing.T) {
	if IsTerminalGone(nil) {
		t.Error("nil must not be terminal-gone")
	}
	if !IsTerminalGone(syscall.EIO) {
		t.Error("EIO must be terminal-gone")
	}
	if !IsTerminalGone(syscall.EPIPE) {
		t.Error("EPIPE must be terminal-gone")
	}
	if !IsTerminalGone(os.ErrClosed) {
		t.Error("closed file must be terminal-gone")
	}
	if IsTerminalGone(os.ErrNotExist) {
		t.Error("ENOENT must not be terminal-gone")
	}
	if !IsTerminalGone(fmt.Errorf("write: %w", syscall.EIO)) {
		t.Error("wrapped EIO must be terminal-gone")
	}
}

func TestProcessLifecycle(t *testing.T) {
	for _, mode := range []string{"clean", "panic", "terminal", "worker-panic"} {
		t.Run(mode, func(t *testing.T) {
			home := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestRecoverProcess$")
			cmd.Env = append(os.Environ(), "HOME="+home, "YUKINO_RECOVER_TEST="+mode)
			output, err := cmd.CombinedOutput()
			expectedCode := 0
			if mode == "panic" {
				expectedCode = 1
			}
			if mode == "worker-panic" {
				expectedCode = 2
			}
			actualCode := 0
			if err != nil {
				var exit *exec.ExitError
				if !errors.As(err, &exit) {
					t.Fatal(err)
				}
				actualCode = exit.ExitCode()
			}
			if actualCode != expectedCode {
				t.Fatalf("exit=%d want=%d: %s", actualCode, expectedCode, output)
			}
			data, err := os.ReadFile(filepath.Join(home, ".yukino", "crash.log"))
			if err != nil {
				t.Fatal(err)
			}
			log := string(data)
			if strings.Count(log, "start pid=") != 1 {
				t.Fatalf("start marker: %s", log)
			}
			if mode == "worker-panic" {
				if !strings.Contains(log, "worker bug") || strings.Contains(log, "code=0") {
					t.Fatalf("worker crash: %s", log)
				}
				return
			}
			if strings.Count(log, "exit pid=") != 1 || !strings.Contains(log, fmt.Sprintf("code=%d", expectedCode)) {
				t.Fatalf("exit marker: %s", log)
			}
			if mode == "panic" {
				if !strings.Contains(log, "crash [uncaught exception] real bug") || !strings.Contains(log, "recover_test.go") {
					t.Fatalf("panic stack: %s", log)
				}
			} else if strings.Contains(log, "crash [") {
				t.Fatalf("unexpected crash: %s", log)
			}
			if mode == "terminal" && strings.Count(log, "terminal closed [") != 1 {
				t.Fatalf("terminal marker: %s", log)
			}
			if _, err := os.Stat(filepath.Join(home, "cleanup")); err != nil {
				t.Fatalf("exit cleanup did not run: %v", err)
			}
		})
	}
}

func TestRecoverProcess(t *testing.T) {
	mode := os.Getenv("YUKINO_RECOVER_TEST")
	if mode == "" {
		return
	}
	defer Recover()()
	tools.RegisterExitCleanup(func() { _ = os.WriteFile(filepath.Join(os.Getenv("HOME"), "cleanup"), []byte("done"), 0600) })
	switch mode {
	case "panic":
		panic("real bug")
	case "terminal":
		panic(fmt.Errorf("write stdout: %w", syscall.EPIPE))
	case "worker-panic":
		go func() { panic("worker bug") }()
		select {}
	}
}

func TestRecordIgnoresWriteFailure(t *testing.T) {
	home := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(home, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	Record("diagnostic write failure")
	RecordError("test", fmt.Errorf("failure"))
}
