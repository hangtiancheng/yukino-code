package github

import (
	"errors"
	"os"
	"os/exec"
)

func errorsAs(err error, target any) bool { return errors.As(err, target) }

// IsNotFound reports whether the error indicates the gh executable could not
// be started (not on PATH).
func IsNotFound(err error) bool {
	return errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist)
}
