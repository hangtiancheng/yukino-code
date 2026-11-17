//go:build darwin || linux

package storage

import (
	"os"
	"syscall"
)

const openNoFollow = syscall.O_NOFOLLOW | syscall.O_NONBLOCK

func chmodDirNoFollow(dir string, mode os.FileMode) error {
	f, err := os.OpenFile(dir, os.O_RDONLY|syscall.O_DIRECTORY|openNoFollow, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Chmod(mode)
}
