//go:build unix

package tools

import (
	"os/exec"
	"syscall"
)

func prepareShellProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func killShellProcess(cmd *exec.Cmd, force bool) {
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	if syscall.Kill(-cmd.Process.Pid, signal) != nil {
		_ = cmd.Process.Signal(signal)
	}
}
func shellExitSignal(cmd *exec.Cmd) string {
	if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return status.Signal().String()
	}
	return ""
}
