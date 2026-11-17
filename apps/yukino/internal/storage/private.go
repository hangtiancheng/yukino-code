package storage

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

func IsPrivateStatePath(path string) bool {
	home, _ := os.UserHomeDir()
	root := filepath.Join(home, YukinoDirName)
	absolute, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	if !utils.IsPathWithin(root, absolute) {
		return false
	}
	rel, err := filepath.Rel(root, absolute)
	if err != nil {
		return false
	}
	first := strings.Split(rel, string(filepath.Separator))[0]
	return !PublicStateSegments[first]
}

// MkdirPrivateSync tightens only Yukino state ancestors, never HOME or
// workspace directories.
func MkdirPrivateSync(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	root := filepath.Join(home, YukinoDirName)
	if !utils.IsPathWithin(root, absolute) {
		return os.MkdirAll(absolute, PrivateDirMode)
	}
	rel, err := filepath.Rel(root, absolute)
	if err != nil {
		return err
	}
	var segments []string
	for _, s := range strings.Split(rel, string(filepath.Separator)) {
		if s != "" {
			segments = append(segments, s)
		}
	}
	directory := root
	for i := -1; i < len(segments); i++ {
		if i >= 0 {
			directory = filepath.Join(directory, segments[i])
		}
		info, err := os.Lstat(directory)
		switch {
		case err == nil && (info.Mode()&os.ModeSymlink != 0 || !info.IsDir()):
			return fmt.Errorf("Private state directory must be a real directory: %s", directory)
		case err == nil:
		case os.IsNotExist(err):
			if merr := os.Mkdir(directory, PrivateDirMode); merr != nil {
				if !os.IsExist(merr) {
					return merr
				}
				raced, lerr := os.Lstat(directory)
				if lerr != nil || raced.Mode()&os.ModeSymlink != 0 || !raced.IsDir() {
					return merr
				}
			}
		default:
			return err
		}
		if err := chmodDirNoFollow(directory, PrivateDirMode); err != nil {
			return err
		}
	}
	return nil
}

// OpenPrivateFile opens path with O_NOFOLLOW and 0600 permissions. Mode alone
// does not tighten existing files, so the opened inode is chmodded before
// truncating or appending.
func OpenPrivateFile(path string, flag int) (*os.File, error) {
	if err := MkdirPrivateSync(filepath.Dir(path)); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, (flag&^os.O_TRUNC)|openNoFollow, PrivateFileMode)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return nil, errors.New(PrivateStateNotFileError)
	}
	if err := f.Chmod(PrivateFileMode); err != nil {
		f.Close()
		return nil, err
	}
	if flag&os.O_TRUNC != 0 {
		if err := f.Truncate(0); err != nil {
			f.Close()
			return nil, err
		}
	}
	return f, nil
}

func ProtectPrivateFileSync(path string) error {
	f, err := OpenPrivateFile(path, os.O_RDONLY)
	if err != nil {
		return err
	}
	return f.Close()
}

func WritePrivateFileSync(path string, data []byte, flag int) error {
	f, err := OpenPrivateFile(path, flag)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return err
	}
	return nil
}

func AppendPrivateFileSync(path string, data []byte) error {
	return WritePrivateFileSync(path, data, os.O_WRONLY|os.O_CREATE|os.O_APPEND)
}

func ReadPrivateFileSync(path string) ([]byte, error) {
	f, err := OpenPrivateFile(path, os.O_RDONLY)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}
