package crash_log

import (
	"fmt"
	"os"
	"runtime/debug"
	"strings"
	"syscall"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/storage"
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
	RecordPanic("main", "boom", []byte("goroutine 1 [running]:"))

	log := readLog(t)
	if !strings.Contains(log, "start pid=1") {
		t.Errorf("start record missing: %s", log)
	}
	if !strings.Contains(log, "crash [main] boom") {
		t.Errorf("panic record missing: %s", log)
	}
	if !strings.Contains(log, "goroutine 1 [running]:") {
		t.Errorf("stack missing: %s", log)
	}
	if strings.Index(log, "start pid=1") > strings.Index(log, "crash [main]") {
		t.Error("records are not in append order")
	}
}

func TestInstallWritesStartAndExit(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Cleanup(func() { _ = debug.SetCrashOutput(nil, debug.CrashOptions{}) })

	recordExit := Install()
	if got := readLog(t); !strings.Contains(got, "start pid=") {
		t.Errorf("start record missing: %s", got)
	}
	recordExit()

	log := readLog(t)
	if !strings.Contains(log, "exit pid=") || !strings.Contains(log, "code=0") {
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
