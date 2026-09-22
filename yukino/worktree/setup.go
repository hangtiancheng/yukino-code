// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package worktree

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// performPostCreationSetup propagates settings, hooks, symlinks, and .worktreeinclude files from
// the main repo into a newly created worktree. Failures are best-effort and never propagated —
// they must not break worktree creation.
func performPostCreationSetup(ctx context.Context, repoRoot, worktreePath string) {
	copyYukinoSettings(repoRoot, worktreePath)
	copyAgentsSettings(repoRoot, worktreePath)
	configureHooksPath(ctx, repoRoot, worktreePath)
	symlinkNodeModules(repoRoot, worktreePath)
	copyWorktreeIncludeFiles(repoRoot, worktreePath)
}

// Shared settings entries under .yukino/ that are propagated to worktrees. Runtime state
// (sessions, file-history, plans, logs, teams) is excluded, and worktrees/ must never be
// included: worktrees live inside .yukino itself, so copying the whole directory would target a
// subdirectory of its own source and the copy would fail with EINVAL.
var (
	sharedYukinoEntries = []string{"permissions.yaml", "agents", "memory"}
	sharedAgentsEntries = []string{"AGENTS.md", "skills"}
)

// copyYukinoSettings copies shared .yukino/ settings from the main repo to the worktree.
func copyYukinoSettings(repoRoot, worktreePath string) {
	yukinoDir := filepath.Join(repoRoot, ".yukino")
	if !pathExists(yukinoDir) {
		return
	}
	dstRoot := filepath.Join(worktreePath, ".yukino")
	if err := os.MkdirAll(dstRoot, 0o755); err != nil {
		log.Error("failed to create .yukino/ in worktree", "err", err)
		return
	}
	for _, entry := range sharedYukinoEntries {
		src := filepath.Join(yukinoDir, entry)
		if !pathExists(src) {
			continue
		}
		// best-effort per entry — skip failures
		if err := copyPath(src, filepath.Join(dstRoot, entry)); err != nil {
			log.Error("failed to copy .yukino/ entry to worktree", "err", err, "entry", entry)
		}
	}
}

// copyAgentsSettings copies shared .agents/ settings from the main repo to the worktree.
func copyAgentsSettings(repoRoot, worktreePath string) {
	agentsDir := filepath.Join(repoRoot, ".agents")
	if !pathExists(agentsDir) {
		return
	}
	dstRoot := filepath.Join(worktreePath, ".agents")
	if err := os.MkdirAll(dstRoot, 0o755); err != nil {
		log.Error("failed to create .agents in worktree", "err", err)
		return
	}
	for _, entry := range sharedAgentsEntries {
		src := filepath.Join(agentsDir, entry)
		if !pathExists(src) {
			continue
		}
		// best-effort per entry — skip failures
		if err := copyPath(src, filepath.Join(dstRoot, entry)); err != nil {
			log.Error("failed to copy .agents/ entry to worktree", "err", err, "entry", entry)
		}
	}
}

// configureHooksPath sets core.hooksPath in the worktree so git hooks from the main repo are
// shared. Prioritizes .husky/ over .git/hooks/.
func configureHooksPath(ctx context.Context, repoRoot, worktreePath string) {
	candidates := []string{
		filepath.Join(repoRoot, ".husky"),
		filepath.Join(repoRoot, ".git", "hooks"),
	}
	var hooksPath string
	for _, c := range candidates {
		info, err := os.Stat(c)
		if err == nil {
			if info.IsDir() {
				hooksPath = c
				break
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			// TS logs every candidate stat failure (worktree/index.ts:531-541);
			// a missing candidate is the normal case, so only genuine IO
			// failures are logged here.
			log.Error("worktree operation failed", "err", err)
		}
	}
	if hooksPath == "" {
		return
	}
	args := []string{"config", "core.hooksPath", hooksPath}
	if _, stderr, code := runGit(ctx, worktreePath, args...); code != 0 {
		// best-effort — don't fail the whole setup.
		log.Error("failed to configure hooks path in worktree", "err", commandFailed(args, stderr))
		return
	}
}

// symlinkNodeModules symlinks the worktree's node_modules at the main repo's when the source
// exists, so dependencies don't need to be re-installed.
func symlinkNodeModules(repoRoot, worktreePath string) {
	src := filepath.Join(repoRoot, "node_modules")
	if !pathExists(src) {
		return
	}
	dst := filepath.Join(worktreePath, "node_modules")
	if pathExists(dst) {
		return // already present
	}
	// best-effort — a failed symlink must not break worktree creation.
	if err := os.Symlink(src, dst); err != nil {
		log.Warn("failed to symlink node_modules in worktree", "err", err)
	}
}

// copyWorktreeIncludeFiles reads .worktreeinclude from the repo root (one literal path per line,
// blank lines and #-comments skipped) and copies each listed file/directory into the worktree,
// regardless of git tracking state.
func copyWorktreeIncludeFiles(repoRoot, worktreePath string) {
	includeFile := filepath.Join(repoRoot, ".worktreeinclude")
	data, err := os.ReadFile(includeFile)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			// TS's outer catch (worktree/index.ts:625-627); a missing include
			// file is the normal no-op case and stays silent here.
			log.Error("failed to process .worktreeinclude", "err", err)
		}
		return // no .worktreeinclude → nothing to copy
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		relPath := strings.TrimSpace(line)
		if relPath == "" || strings.HasPrefix(relPath, "#") {
			continue
		}
		// Guard against path traversal.
		if strings.Contains(relPath, "..") {
			continue
		}
		src := filepath.Join(repoRoot, relPath)
		if !pathExists(src) {
			continue
		}
		dst := filepath.Join(worktreePath, relPath)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			// TS's per-file catch logs and skips (worktree/index.ts:620-623).
			log.Error("worktree operation failed", "err", err)
			continue
		}
		// best-effort per entry — skip failures
		if err := copyPath(src, dst); err != nil {
			log.Error("worktree operation failed", "err", err)
		}
	}
}

// pathExists reports whether p exists (equivalent to TS pathExists: stat-based).
// TS logs every access failure including ENOENT (worktree/index.ts:79-87); since
// pathExists is the normal existence probe here, only genuine IO errors are logged.
func pathExists(p string) bool {
	_, err := os.Stat(p)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Error("worktree operation failed", "err", err)
		}
		return false
	}
	return true
}

// copyPath copies a file or directory tree from src to dst (fs.cp {recursive: true} equivalent).
// Symlinks are recreated at the destination, not followed.
func copyPath(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return copyDir(src, dst)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dst)
	}
	return copyFileContents(src, dst, info.Mode().Perm())
}

// copyDir recursively copies the directory tree rooted at src into dst.
func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.Type()&os.ModeSymlink != 0 {
			linkTarget, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(linkTarget, target)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		return copyFileContents(path, target, info.Mode().Perm())
	})
}

// copyFileContents copies a regular file, preserving its permission bits. An existing dst is
// overwritten (fs.cp default).
func copyFileContents(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
