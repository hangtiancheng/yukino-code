//go:build windows

package update

import (
	"fmt"
	"os/exec"
)

func terminationMessage(command string, exitErr *exec.ExitError) string {
	return fmt.Sprintf("%s exited with code %d.", command, exitErr.ExitCode())
}
