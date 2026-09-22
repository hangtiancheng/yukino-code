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

//go:build !unix

package tools

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
)

// setDetachedProcess is a no-op off POSIX: the Windows tree kill goes through
// taskkill and needs no new process group.
func setDetachedProcess(cmd *exec.Cmd) {}

// killProcessTree terminates the child's whole tree via taskkill /T on
// Windows (/F is the forced variant); other platforms fall back to killing
// the direct child.
func killProcessTree(cmd *exec.Cmd, force bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if runtime.GOOS == "windows" {
		flags := []string{"/pid", strconv.Itoa(cmd.Process.Pid), "/T"}
		if force {
			flags = append(flags, "/F")
		}
		if err := exec.Command("taskkill", flags...).Run(); err != nil {
			_ = cmd.Process.Kill()
		}
		return
	}
	_ = cmd.Process.Kill()
}

// processExitSignal returns "" off POSIX: signal details is not portably
// available from os.ProcessState.
func processExitSignal(err *exec.ExitError) string { return "" }

// openOutputFile opens the shell output file. Windows treats append-only
// handles awkwardly, so use plain truncate mode there.
func openOutputFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
}
