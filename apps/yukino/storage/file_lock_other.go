//go:build !darwin && !linux

package storage

func isProcessAlive(pid int) bool {
	return true
}

func processStartTick(pid int) string {
	return ""
}
