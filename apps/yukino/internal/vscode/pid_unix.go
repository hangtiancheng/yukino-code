//go:build !windows

package vscode

import (
	"os"
	"syscall"
)

// isPidAlive mirrors process.kill(pid, 0): any failure (ESRCH or EPERM) counts
// as not alive.
func isPidAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}
