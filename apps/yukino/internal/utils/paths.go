package utils

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func ResolveToolPath(cwd, path string) string {
	home, _ := os.UserHomeDir()
	expanded := path
	if path == "~" {
		expanded = home
	} else if strings.HasPrefix(path, "~/") {
		expanded = filepath.Join(home, path[2:])
	}
	if filepath.IsAbs(expanded) {
		return filepath.Clean(expanded)
	}
	abs, err := filepath.Abs(filepath.Join(cwd, expanded))
	if err != nil {
		return filepath.Join(cwd, expanded)
	}
	return abs
}

// CanonicalPath resolves symlinks even when the final file or some parent
// directories do not exist yet.
func CanonicalPath(path string, links int) (string, error) {
	if links >= MaxSymlinkDepth {
		return "", errors.New(TooManySymlinksError)
	}
	current, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	var missing []string
	for {
		real, err := filepath.EvalSymlinks(current)
		if err == nil {
			return filepath.Join(append([]string{real}, missing...)...), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		if info, lerr := os.Lstat(current); lerr == nil && info.Mode()&os.ModeSymlink != 0 {
			target, rerr := os.Readlink(current)
			if rerr != nil {
				return "", rerr
			}
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(current), target)
			}
			return CanonicalPath(filepath.Join(append([]string{target}, missing...)...), links+1)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		missing = append([]string{filepath.Base(current)}, missing...)
		current = parent
	}
}

func IsPathWithin(root, path string) bool {
	child, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return child == "" || (child != ".." && !strings.HasPrefix(child, ".."+string(filepath.Separator)) && !filepath.IsAbs(child))
}

func CompactPath(path string) string {
	home, _ := os.UserHomeDir()
	rel, err := filepath.Rel(home, path)
	if err != nil {
		return path
	}
	if rel == "" {
		return "~"
	}
	if !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".." && !filepath.IsAbs(rel) {
		return filepath.Join("~", rel)
	}
	return path
}
