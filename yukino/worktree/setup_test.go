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
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCopyYukinoSettings(t *testing.T) {
	repo := t.TempDir()
	wt := t.TempDir()

	// No .yukino dir → no-op, no error.
	copyYukinoSettings(repo, wt)

	yukinoDir := filepath.Join(repo, ".yukino")
	os.MkdirAll(filepath.Join(yukinoDir, "agents"), 0o755)
	os.MkdirAll(filepath.Join(yukinoDir, "memory"), 0o755)
	os.MkdirAll(filepath.Join(yukinoDir, "sessions"), 0o755) // runtime state — must NOT be copied
	os.WriteFile(filepath.Join(yukinoDir, "permissions.yaml"), []byte("allow: []\n"), 0o644)
	os.WriteFile(filepath.Join(yukinoDir, "agents", "reviewer.md"), []byte("agent"), 0o644)
	os.WriteFile(filepath.Join(yukinoDir, "memory", "notes.md"), []byte("memory"), 0o644)
	os.WriteFile(filepath.Join(yukinoDir, "sessions", "s.json"), []byte("{}"), 0o644)

	copyYukinoSettings(repo, wt)

	for _, f := range []string{
		filepath.Join(".yukino", "permissions.yaml"),
		filepath.Join(".yukino", "agents", "reviewer.md"),
		filepath.Join(".yukino", "memory", "notes.md"),
	} {
		if _, err := os.Stat(filepath.Join(wt, f)); err != nil {
			t.Errorf("%s not copied: %v", f, err)
		}
	}
	// Runtime state is excluded from the whitelist.
	if _, err := os.Stat(filepath.Join(wt, ".yukino", "sessions")); !os.IsNotExist(err) {
		t.Error("runtime state (sessions/) must not be copied to the worktree")
	}
}

func TestCopyAgentsSettings(t *testing.T) {
	repo := t.TempDir()
	wt := t.TempDir()

	// No .agents dir → no-op, no error.
	copyAgentsSettings(repo, wt)

	agentsDir := filepath.Join(repo, ".agents")
	os.MkdirAll(filepath.Join(agentsDir, "skills", "foo"), 0o755)
	os.WriteFile(filepath.Join(agentsDir, "AGENTS.md"), []byte("agents md"), 0o644)
	os.WriteFile(filepath.Join(agentsDir, "skills", "foo", "SKILL.md"), []byte("skill"), 0o644)
	os.WriteFile(filepath.Join(agentsDir, "other.txt"), []byte("x"), 0o644) // not whitelisted

	copyAgentsSettings(repo, wt)

	for _, f := range []string{
		filepath.Join(".agents", "AGENTS.md"),
		filepath.Join(".agents", "skills", "foo", "SKILL.md"),
	} {
		if _, err := os.Stat(filepath.Join(wt, f)); err != nil {
			t.Errorf("%s not copied: %v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(wt, ".agents", "other.txt")); !os.IsNotExist(err) {
		t.Error("non-whitelisted .agents entry must not be copied")
	}
}

func TestConfigureHooksPath(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initTestRepo(t, repo)

	// Create .husky directory
	huskyDir := filepath.Join(repo, ".husky")
	os.MkdirAll(huskyDir, 0o755)

	// Create a worktree to test hooks config
	result, err := getOrCreateWorktree(context.Background(), repo, "hooks-test")
	if err != nil {
		t.Fatalf("create worktree failed: %v", err)
	}

	configureHooksPath(context.Background(), repo, result.WorktreePath)

	// Check that hooks path is set
	stdout, _, code := runGit(context.Background(), result.WorktreePath, "config", "core.hooksPath")
	if code != 0 {
		t.Fatal("core.hooksPath not set")
	}
	if trimNewline(stdout) != huskyDir {
		t.Fatalf("expected hooks path %q, got %q", huskyDir, trimNewline(stdout))
	}
}

func TestSymlinkNodeModules(t *testing.T) {
	// Creating symlinks on Windows requires elevated privileges; probe first.
	probe := t.TempDir()
	if err := os.Symlink(probe, filepath.Join(probe, "_probe_link")); err != nil {
		t.Skip("symlinks require elevated privileges on Windows")
	}

	repo := t.TempDir()
	wt := t.TempDir()

	// No node_modules in the source repo → no symlink.
	symlinkNodeModules(repo, wt)
	if _, err := os.Lstat(filepath.Join(wt, "node_modules")); !os.IsNotExist(err) {
		t.Fatal("no symlink expected when source node_modules is absent")
	}

	// Source exists → unconditional symlink.
	os.MkdirAll(filepath.Join(repo, "node_modules"), 0o755)
	symlinkNodeModules(repo, wt)

	link := filepath.Join(wt, "node_modules")
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatalf("symlink not created: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("expected symlink")
	}

	// Destination already present → left alone.
	os.Remove(link)
	os.MkdirAll(link, 0o755)
	symlinkNodeModules(repo, wt)
	info, err = os.Lstat(link)
	if err != nil {
		t.Fatalf("existing node_modules removed: %v", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("existing directory must not be replaced by a symlink")
	}
}

func TestCopyWorktreeIncludeFiles(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	// wt is nested one level deeper than repo so a traversal entry ("../escape.txt") has a
	// source (base/escape.txt) distinct from its destination (base/wtA/escape.txt).
	wt := filepath.Join(base, "wtA", "wt")
	os.MkdirAll(repo, 0o755)
	os.MkdirAll(wt, 0o755)

	// No .worktreeinclude → no-op.
	copyWorktreeIncludeFiles(repo, wt)

	// Literal-path semantics: entries are copied regardless of git state — gitignored files,
	// tracked files, and whole directories alike.
	os.WriteFile(filepath.Join(repo, ".env"), []byte("SECRET=abc"), 0o644)
	os.MkdirAll(filepath.Join(repo, "secrets"), 0o755)
	os.WriteFile(filepath.Join(repo, "secrets", "key.pem"), []byte("pem"), 0o644)
	os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("tracked"), 0o644)
	os.WriteFile(filepath.Join(base, "escape.txt"), []byte("no"), 0o644)

	include := "# comment\n\n.env\nsecrets\ntracked.txt\n../escape.txt\nmissing.txt\n"
	os.WriteFile(filepath.Join(repo, ".worktreeinclude"), []byte(include), 0o644)

	copyWorktreeIncludeFiles(repo, wt)

	data, err := os.ReadFile(filepath.Join(wt, ".env"))
	if err != nil || string(data) != "SECRET=abc" {
		t.Fatal(".env not correctly copied")
	}
	if _, err := os.Stat(filepath.Join(wt, "secrets", "key.pem")); err != nil {
		t.Fatalf("directory entry not copied recursively: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wt, "tracked.txt")); err != nil {
		t.Fatalf("listed file must be copied regardless of git state: %v", err)
	}
	// ".." entries are skipped (path traversal guard); missing entries are skipped silently.
	// A traversal copy would create base/wtA/escape.txt from base/escape.txt.
	if _, err := os.Stat(filepath.Join(base, "wtA", "escape.txt")); !os.IsNotExist(err) {
		t.Fatal("path traversal entry must be skipped")
	}
	if _, err := os.Stat(filepath.Join(wt, "missing.txt")); !os.IsNotExist(err) {
		t.Fatal("missing entry must be skipped")
	}
}
