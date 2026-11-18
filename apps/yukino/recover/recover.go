package recovery

import (
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/yukino-js/yukino/yukino/logger"
	"github.com/yukino-js/yukino/yukino/storage"
	"github.com/yukino-js/yukino/yukino/telemetry"
	"github.com/yukino-js/yukino/yukino/tools"
)

func logPath() string {
	return storage.YukinoPath("crash.log")
}

// Record appends a timestamped entry to the crash log. Write failures are
// silently ignored so diagnostics never crash the process.
func Record(text string) {
	if err := storage.MkdirPrivateSync(storage.GetYukinoDir()); err != nil {
		return
	}
	stamp := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	_ = storage.AppendPrivateFileSync(logPath(), []byte(fmt.Sprintf("[%s] %s\n", stamp, text)))
}

// RecordError records a failure and its stack at the reporting boundary.
func RecordError(context string, value any) {
	Record(fmt.Sprintf("crash [%s] %+v\n%s", context, value, debug.Stack()))
}

// A terminal that goes away (window closed, ssh dropped, pty torn down) makes
// every later stdio write fail: EIO from the dead pty, EPIPE once the reader is
// gone, or a write to an already-closed stream. That is the session's terminal
// disappearing, not a yukino fault, so it must not be logged as a crash.
//
// IsTerminalGone reports whether err is such a write failure.
func IsTerminalGone(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, syscall.EIO) ||
		errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, os.ErrClosed)
}

var terminalGoneRecorded atomic.Bool

// ExitForTerminalGone ends the process when the terminal is gone: it records
// the condition once and exits 0, so crash.log shows a start + exit pair with
// no crash line. os.Exit skips deferred teardown, so the sync cleanup registry
// is swept first — detached background shells must not outlive the session as
// orphans — then the logger is flushed and the exit marker written.
func ExitForTerminalGone(context string, detail any) {
	if terminalGoneRecorded.CompareAndSwap(false, true) {
		Record(fmt.Sprintf("terminal closed [%s] %v", context, detail))
	}
	tools.RunExitCleanups()
	logger.CloseLogger()
	RecordExit(0)
	os.Exit(0)
}

var exitRecorded atomic.Bool

// RecordExit writes the exit marker; subsequent calls are no-ops. Whichever
// path arrives first wins.
func RecordExit(code any) {
	if !exitRecorded.CompareAndSwap(false, true) {
		return
	}
	Record(fmt.Sprintf("exit pid=%d code=%v", os.Getpid(), code))
}

var installOnce sync.Once

// Recover installs diagnostics and returns a deferred handler for the calling
// goroutine. Use defer recovery.Recover()() at the process entry point. Panics
// in other goroutines are captured by Go's runtime crash output, not recovered.
func Recover() func() {
	installOnce.Do(func() {
		Record(fmt.Sprintf("start pid=%d", os.Getpid()))
		if err := storage.MkdirPrivateSync(storage.GetYukinoDir()); err == nil {
			if f, err := storage.OpenPrivateFile(logPath(), os.O_WRONLY|os.O_CREATE|os.O_APPEND); err == nil {
				_ = debug.SetCrashOutput(f, debug.CrashOptions{})
				_ = f.Close()
			}
		}
	})
	return func() {
		if value := recover(); value != nil {
			if err, ok := value.(error); ok && IsTerminalGone(err) {
				ExitForTerminalGone("uncaught exception", err)
			}
			RecordError("uncaught exception", value)
			logger.Global().Fatal(map[string]any{"err": value}, "uncaught exception")
			err, ok := value.(error)
			if !ok {
				err = fmt.Errorf("%v", value)
			}
			telemetry.CaptureTelemetryError(err, "uncaught exception")
			tools.RunExitCleanups()
			telemetry.ShutdownTelemetry()
			logger.CloseLogger()
			RecordExit(1)
			os.Exit(1)
		}
		tools.RunExitCleanups()
		logger.CloseLogger()
		RecordExit(0)
	}
}
