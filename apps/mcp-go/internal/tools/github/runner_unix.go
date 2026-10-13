//go:build !windows

package github

import (
	"context"
	"os"
	"os/exec"
	"syscall"
)

func execCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

// setProcGroup places the child in its own process group so the whole group
// can be signalled on cancellation.
func setProcGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// killProcGroup kills the child's process group.
func killProcGroup(cmd *exec.Cmd) error {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	return nil
}

func signalName(sig syscall.Signal) string { return sig.String() }

func exitSignal(state *os.ProcessState) string {
	if state == nil {
		return ""
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return ""
	}
	return signalName(status.Signal())
}

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
