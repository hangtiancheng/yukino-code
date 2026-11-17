//go:build !unix

package tools

import (
	"os/exec"
	"strconv"
)

func prepareShellProcess(cmd *exec.Cmd) {}
func killShellProcess(cmd *exec.Cmd, force bool) {
	args := []string{"/pid", strconv.Itoa(cmd.Process.Pid), "/T"}
	if force {
		args = append(args, "/F")
	}
	if exec.Command("taskkill", args...).Run() != nil {
		_ = cmd.Process.Kill()
	}
}
func shellExitSignal(cmd *exec.Cmd) string { return "" }
