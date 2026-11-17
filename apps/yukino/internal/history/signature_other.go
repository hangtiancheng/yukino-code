//go:build !darwin && !linux && !windows

package history

import (
	"fmt"
	"os"
)

func platformFileSignature(path string, info os.FileInfo) string {
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}
