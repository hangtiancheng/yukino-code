package history

import (
	"fmt"
	"os"
	"syscall"
)

func platformFileSignature(path string, info os.FileInfo) string {
	stat := info.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%d:%d:%d:%d:%d", stat.Ino, info.Size(), info.ModTime().UnixNano(), stat.Ctimespec.Sec, stat.Ctimespec.Nsec)
}
