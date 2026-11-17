package worktree

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/logger"
)

var log = logger.CreateChildLogger("worktree")

func performPostCreationSetup(ctx context.Context, repoRoot, path string) {
	copyAgentsSettings(repoRoot, path)
	configureHooksPath(ctx, repoRoot, path)
	symlinkNodeModules(repoRoot, path)
	copyWorktreeIncludeFiles(repoRoot, path)
}

func copyAgentsSettings(repoRoot, path string) {
	source := filepath.Join(repoRoot, ".agents")
	if _, err := os.Stat(source); err != nil {
		return
	}
	dest := filepath.Join(path, ".agents")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		log.Error(map[string]any{"err": err}, "failed to create .agents in worktree")
		return
	}
	for _, entry := range sharedAgentsEntries {
		if _, err := os.Stat(filepath.Join(source, entry)); err != nil {
			continue
		}
		if err := copyPath(filepath.Join(source, entry), filepath.Join(dest, entry)); err != nil {
			log.Error(map[string]any{"err": err, "entry": entry}, "failed to copy .agents/ entry to worktree")
		}
	}
}

func configureHooksPath(ctx context.Context, repoRoot, path string) {
	existing, _, _ := runGit(ctx, path, "config", "--get", "core.hooksPath")
	if strings.TrimSpace(existing) != "" {
		return
	}
	hooksPath := filepath.Join(repoRoot, ".husky")
	if info, err := os.Stat(hooksPath); err != nil || !info.IsDir() {
		return
	}
	if _, err := gitOutput(ctx, path, "config", "extensions.worktreeConfig", "true"); err != nil {
		log.Error(map[string]any{"err": err}, "failed to configure hooks path in worktree")
		return
	}
	if _, err := gitOutput(ctx, path, "config", "--worktree", "core.hooksPath", hooksPath); err != nil {
		log.Error(map[string]any{"err": err}, "failed to configure hooks path in worktree")
	}
}

func symlinkNodeModules(repoRoot, path string) {
	src, dst := filepath.Join(repoRoot, "node_modules"), filepath.Join(path, "node_modules")
	if _, err := os.Stat(src); err != nil {
		return
	}
	if _, err := os.Stat(dst); err == nil {
		return
	}
	if err := os.Symlink(src, dst); err != nil {
		log.Warn(map[string]any{"err": err}, "failed to symlink node_modules in worktree")
	}
}

func copyWorktreeIncludeFiles(repoRoot, path string) {
	data, err := os.ReadFile(filepath.Join(repoRoot, ".worktreeinclude"))
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		rel := strings.TrimSpace(line)
		if rel == "" || strings.HasPrefix(rel, "#") || strings.Contains(rel, "..") {
			continue
		}
		src, dst := filepath.Join(repoRoot, rel), filepath.Join(path, rel)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			continue
		}
		if err := copyPath(src, dst); err != nil {
			log.Error(map[string]any{"err": err}, "worktree operation failed")
		}
	}
}

func copyPath(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := filepath.EvalSymlinks(src)
		if err != nil {
			return err
		}
		if _, err := os.Lstat(dst); err == nil {
			if err := os.Remove(dst); err != nil {
				return err
			}
		}
		return os.Symlink(target, dst)
	}
	if info.IsDir() {
		if err := os.MkdirAll(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyPath(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
