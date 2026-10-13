//go:build windows

package github

import (
	"context"
	"os/exec"
	"syscall"
)

func execCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

func setProcGroup(cmd *exec.Cmd) {}

func killProcGroup(cmd *exec.Cmd) error {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	return nil
}

func signalName(sig syscall.Signal) string { return sig.String() }

func isSpawnError(err error) bool {
	if err == nil {
		return false
	}
	var exitErr *exec.ExitError
	if errorsAs(err, &exitErr) {
		return false
	}
	return true
}
