//go:build darwin || linux

package storage

import (
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

func isProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}

// processStartTick returns the kernel start-time tick of a PID (Linux only):
// kill(pid, 0) only proves some process holds the PID, which a recycled PID
// makes ambiguous; the start tick distinguishes the original lock owner from
// an unrelated later process.
func processStartTick(pid int) string {
	if runtime.GOOS != "linux" {
		return ""
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return ""
	}
	// The comm field (2) is parenthesized and may contain spaces/parens, so
	// split after the last ')'; starttime is field 22, i.e. index 19 after it.
	afterComm := string(stat)
	if idx := strings.LastIndex(afterComm, ")"); idx >= 0 {
		afterComm = afterComm[idx+2:]
	}
	fields := strings.Split(afterComm, " ")
	if len(fields) < 20 {
		return ""
	}
	return fields[19]
}
