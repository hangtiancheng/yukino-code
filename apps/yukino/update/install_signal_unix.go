//go:build !windows

package update

import (
	"fmt"
	"os/exec"
	"syscall"
)

func terminationMessage(command string, exitErr *exec.ExitError) string {
	if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return fmt.Sprintf("%s was terminated by %s.", command, ws.Signal())
	}
	return fmt.Sprintf("%s exited with code %d.", command, exitErr.ExitCode())
}
