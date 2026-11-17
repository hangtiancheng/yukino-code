package tools

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func writeFileAtomically(ctx context.Context, path, content string) error {
	private := storage.IsPrivateStatePath(path)
	if private {
		if err := storage.MkdirPrivateSync(filepath.Dir(path)); err != nil {
			return err
		}
	}
	entry, err := os.Lstat(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if private && entry != nil {
		if err := storage.ProtectPrivateFileSync(path); err != nil {
			return err
		}
	}
	target := path
	if entry != nil && entry.Mode()&os.ModeSymlink != 0 {
		target, err = filepath.EvalSymlinks(path)
		if err != nil {
			return err
		}
		entry, err = os.Stat(target)
		if err != nil {
			return err
		}
	}
	if entry != nil && !entry.Mode().IsRegular() {
		return errors.New("File writes require a regular file.")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	mode := os.FileMode(0o666)
	if entry != nil {
		mode = entry.Mode().Perm()
	}
	if private {
		mode = storage.PrivateFileMode
	}
	temporary, err := os.OpenFile(filepath.Join(filepath.Dir(target), ".yukino-"+uuid.NewString()+".tmp"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if private || entry != nil {
		err = temporary.Chmod(mode)
	}
	if err == nil {
		_, err = temporary.WriteString(content)
	}
	if err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), target)
}
