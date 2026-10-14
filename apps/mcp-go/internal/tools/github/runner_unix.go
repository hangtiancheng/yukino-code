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

func signalName(sig syscall.Signal) string {
	names := map[syscall.Signal]string{
		syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "SIGINT", syscall.SIGQUIT: "SIGQUIT", syscall.SIGILL: "SIGILL", syscall.SIGTRAP: "SIGTRAP", syscall.SIGABRT: "SIGABRT", syscall.SIGBUS: "SIGBUS", syscall.SIGFPE: "SIGFPE", syscall.SIGKILL: "SIGKILL", syscall.SIGUSR1: "SIGUSR1", syscall.SIGSEGV: "SIGSEGV", syscall.SIGUSR2: "SIGUSR2", syscall.SIGPIPE: "SIGPIPE", syscall.SIGALRM: "SIGALRM", syscall.SIGTERM: "SIGTERM", syscall.SIGCHLD: "SIGCHLD", syscall.SIGCONT: "SIGCONT", syscall.SIGSTOP: "SIGSTOP", syscall.SIGTSTP: "SIGTSTP", syscall.SIGTTIN: "SIGTTIN", syscall.SIGTTOU: "SIGTTOU", syscall.SIGURG: "SIGURG", syscall.SIGXCPU: "SIGXCPU", syscall.SIGXFSZ: "SIGXFSZ", syscall.SIGVTALRM: "SIGVTALRM", syscall.SIGPROF: "SIGPROF", syscall.SIGWINCH: "SIGWINCH", syscall.SIGIO: "SIGIO", syscall.SIGSYS: "SIGSYS",
	}
	if name, ok := names[sig]; ok {
		return name
	}
	return sig.String()
}

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
