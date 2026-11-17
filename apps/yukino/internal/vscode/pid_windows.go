//go:build windows

package vscode

import "golang.org/x/sys/windows"

const processStillActiveExitCode = 259

// isPidAlive mirrors process.kill(pid, 0) via OpenProcess: a running process
// reports STILL_ACTIVE.
func isPidAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var exitCode uint32
	if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
		return false
	}
	return exitCode == processStillActiveExitCode
}
