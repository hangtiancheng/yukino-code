package memory

import (
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func GetAutoMemPath(projectRoot string) string {
	dir, err := storage.ProjectPath(projectRoot, MemoryDirName)
	if err != nil {
		return ""
	}
	return dir
}

func GetAutoMemEntrypoint(projectRoot string) string {
	dir := GetAutoMemPath(projectRoot)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, MemoryIndexName)
}

func GetUserAutoMemPath() string {
	return storage.YukinoPath(MemoryDirName)
}

func GetUserAutoMemEntrypoint() string {
	return filepath.Join(GetUserAutoMemPath(), MemoryIndexName)
}

func IsAutoMemPath(absolutePath, projectRoot string) bool {
	abs := filepath.Clean(absolutePath)
	for _, dir := range []string{GetAutoMemPath(projectRoot), GetUserAutoMemPath()} {
		if dir == "" {
			continue
		}
		if abs == filepath.Clean(dir) || strings.HasPrefix(abs, filepath.Clean(dir)+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func IsUserAutoMemPath(absolutePath string) bool {
	dir := GetUserAutoMemPath()
	if dir == "" {
		return false
	}
	abs := filepath.Clean(absolutePath)
	return abs == filepath.Clean(dir) || strings.HasPrefix(abs, filepath.Clean(dir)+string(filepath.Separator))
}
