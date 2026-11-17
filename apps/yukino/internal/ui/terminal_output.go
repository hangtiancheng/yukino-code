package ui

import (
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/charmbracelet/x/term"
	"github.com/yukino-js/yukino/yukino/internal/crash_log"
)

// isSyncOutputSupported detects DEC 2026 synchronized-output support from the
// environment instead of a DECRQM query, which several terminals do not
// implement. Unrecognized terminals count as unsupported: emitting the
// sequences at a terminal that mishandles them can leave garbage on screen.
func isSyncOutputSupported() bool {
	if os.Getenv("TMUX") != "" {
		return false
	}
	termValue := os.Getenv("TERM")
	return syncOutputTermPrograms[os.Getenv("TERM_PROGRAM")] ||
		strings.Contains(termValue, "kitty") ||
		termValue == "xterm-ghostty" ||
		strings.HasPrefix(termValue, "foot") ||
		strings.Contains(termValue, "alacritty") ||
		os.Getenv("KITTY_WINDOW_ID") != "" ||
		os.Getenv("ZED_TERM") != "" ||
		os.Getenv("WT_SESSION") != "" ||
		vteVersion() >= 6800
}

var leadingIntPattern = regexp.MustCompile(`^[+-]?[0-9]+`)

// vteVersion mirrors Number.parseInt(env.VTE_VERSION ?? "", 10); a value with
// no leading digits yields math.MinInt so the >= comparison fails like NaN.
func vteVersion() int {
	match := leadingIntPattern.FindString(strings.TrimSpace(os.Getenv("VTE_VERSION")))
	if match == "" {
		return math.MinInt
	}
	value, err := strconv.Atoi(match)
	if err != nil {
		if strings.HasPrefix(match, "-") {
			return math.MinInt
		}
		return math.MaxInt
	}
	return value
}

// terminalGoneExit ends the process when a write fails because the terminal
// vanished. It is a variable so tests can observe the call without exiting;
// production uses crash_log.ExitForTerminalGone.
var terminalGoneExit = crash_log.ExitForTerminalGone

// terminalOutputWriter guards the terminal output. bubbletea's renderer
// discards write errors (`_, _ = r.out.Write(...)`), so a terminal that goes
// away mid-session (window closed, ssh dropped, pty torn down) would otherwise
// fail every frame silently instead of ending the run. This writer detects the
// terminal-gone condition on each write and exits cleanly, mirroring the
// reference's process.stdout/stderr 'error' handlers. When synchronized output
// is supported it additionally frames every write in BSU/ESU — bubbletea's
// standard renderer flushes each frame as a single write, so one write is one
// frame, the granularity the reference achieves by corking stdout around each
// Ink render pass. It must keep implementing term.File (Fd/Read/Close) so
// bubbletea still recognizes the output TTY and delivers WindowSizeMsg.
type terminalOutputWriter struct {
	out    *os.File
	sync   bool
	mu     sync.Mutex
	cursor terminalCursor
}

var _ term.File = (*terminalOutputWriter)(nil)

func (w *terminalOutputWriter) Fd() uintptr { return w.out.Fd() }

func (w *terminalOutputWriter) Read(p []byte) (int, error) { return w.out.Read(p) }

func (w *terminalOutputWriter) Close() error { return w.out.Close() }

func (w *terminalOutputWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	buf := w.cursor.render(p)
	if w.sync && len(p) > 0 {
		framed := make([]byte, 0, len(buf)+len(bsu)+len(esu))
		framed = append(framed, bsu...)
		framed = append(framed, buf...)
		framed = append(framed, esu...)
		buf = framed
	}
	if _, err := w.out.Write(buf); err != nil {
		if crash_log.IsTerminalGone(err) {
			terminalGoneExit("stdio", err)
		}
		return 0, err
	}
	return len(p), nil
}

// InstallTerminalOutput wraps the terminal output so a vanished terminal ends
// the run cleanly, and enables synchronized output when the terminal supports
// it. The reference's Ink-specific frame interception (static replay, resize
// buffering, soft-wrap cursor grouping) is replaced by bubbletea's renderer,
// which already diffs and batches frames.
func InstallTerminalOutput(out io.Writer) io.Writer {
	file, ok := out.(*os.File)
	if !ok || !term.IsTerminal(file.Fd()) {
		return out
	}
	return &terminalOutputWriter{out: file, sync: isSyncOutputSupported()}
}
