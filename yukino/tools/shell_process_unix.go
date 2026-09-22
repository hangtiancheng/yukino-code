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

//go:build unix

package tools

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

// setDetachedProcess puts the child in its own process group so the whole
// tree can be killed via kill(-pgid).
func setDetachedProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessTree kills the child's whole process group; falls back to the
// direct child when the group is already gone.
func killProcessTree(cmd *exec.Cmd, force bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-cmd.Process.Pid, sig); err != nil {
		if force {
			_ = cmd.Process.Kill()
		} else {
			_ = cmd.Process.Signal(sig)
		}
	}
}

// processExitSignal returns the signal name when the process was signalled,
// or "" otherwise. The name is spelled like the TS NodeJS.Signals values
// ("SIGTERM", "SIGKILL"), which is what the model-visible message says.
func processExitSignal(err *exec.ExitError) string {
	ws, ok := err.Sys().(syscall.WaitStatus)
	if !ok || !ws.Signaled() {
		return ""
	}
	// Node reports the platform signal name ("SIGQUIT", "SIGABRT", …) through
	// exit.signal; Go's syscall.Signal.String() would render the lowercase
	// aliases ("quit", "aborted"), so take the SIG-prefixed table entry.
	// TS renders `Process terminated by ${signal}` for every signal.
	if name := unix.SignalName(ws.Signal()); name != "" {
		return name
	}
	return "SIG" + strconv.Itoa(int(ws.Signal()))
}

// openOutputFile opens the shell output file. O_APPEND makes each write
// atomic on POSIX so the shared stdout+stderr interleave chronologically
// without tearing; O_NOFOLLOW stops a pre-planted symlink from redirecting
// output.
func openOutputFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND|syscall.O_NOFOLLOW, 0o600)
}
