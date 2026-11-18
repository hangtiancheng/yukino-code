//go:build !darwin && !linux

package storage

import "os"

const openNoFollow = 0

func chmodDirNoFollow(dir string, mode os.FileMode) error {
	return os.Chmod(dir, mode)
}
