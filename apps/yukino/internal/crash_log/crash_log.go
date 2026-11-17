package crash_log

import (
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
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

// RecordPanic records an exception with its full stack trace; context
// identifies the originating layer.
func RecordPanic(context string, value any, stack []byte) {
	Record(fmt.Sprintf("crash [%s] %v\n%s", context, value, stack))
}

// RecordError records an error that escaped to the top level; context
// identifies the originating layer.
func RecordError(context string, err error) {
	Record(fmt.Sprintf("crash [%s] %s", context, err))
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

// Install records crash diagnostics; call once at process startup. A start
// line marks the beginning of a run, an exit line is written on graceful
// shutdown, and panic handlers capture errors that escape to the top of the
// process. Together they determine the exit mode: crash + exit → crashed;
// start + exit only → clean shutdown; start only → killed externally.
func Install() func() {
	Record(fmt.Sprintf("start pid=%d", os.Getpid()))
	if err := storage.MkdirPrivateSync(storage.GetYukinoDir()); err == nil {
		if f, err := storage.OpenPrivateFile(logPath(), os.O_WRONLY|os.O_CREATE|os.O_APPEND); err == nil {
			_ = debug.SetCrashOutput(f, debug.CrashOptions{})
			_ = f.Close()
		}
	}
	return func() {
		RecordExit(0)
	}
}
