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
	"strings"
	"testing"
)

func TestCreateAgentWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initTestRepo(t, repo)

	// Resolve symlinks so paths match what os.Getwd() returns (matters on
	// macOS where /var -> /private/var and /tmp -> /private/tmp).
	repo, _ = filepath.EvalSymlinks(repo)

	// CreateAgentWorktree needs to be called from within a git repo
	origDir, _ := os.Getwd()
	defer os.Chdir(origDir)
	os.Chdir(repo)

	result, err := CreateAgentWorktree(context.Background(), "", "agent-a1234567")
	if err != nil {
		t.Fatalf("CreateAgentWorktree failed: %v", err)
	}

	expectedPath := filepath.Join(repo, ".yukino", "worktrees", "agent-a1234567")
	if result.WorktreePath != expectedPath {
		t.Fatalf("expected path %q, got %q", expectedPath, result.WorktreePath)
	}
	if result.GitRoot != repo {
		t.Fatalf("expected git root %q, got %q", repo, result.GitRoot)
	}
	if result.HeadCommit == "" {
		t.Fatal("expected non-empty head commit")
	}

	// Directory should exist
	if _, err := os.Stat(result.WorktreePath); err != nil {
		t.Fatalf("worktree directory not created: %v", err)
	}
}

func TestCreateAgentWorktree_Resume(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initTestRepo(t, repo)

	origDir, _ := os.Getwd()
	defer os.Chdir(origDir)
	os.Chdir(repo)

	// First call creates
	r1, err := CreateAgentWorktree(context.Background(), "", "agent-a7777777")
	if err != nil {
		t.Fatalf("first call failed: %v", err)
	}

	// Second call should resume the existing worktree (fast path, no setup rerun)
	r2, err := CreateAgentWorktree(context.Background(), "", "agent-a7777777")
	if err != nil {
		t.Fatalf("second call failed: %v", err)
	}
	if r2.WorktreePath != r1.WorktreePath {
		t.Fatal("resume should return same path")
	}
}

func TestRemoveAgentWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initTestRepo(t, repo)

	origDir, _ := os.Getwd()
	defer os.Chdir(origDir)
	os.Chdir(repo)

	result, err := CreateAgentWorktree(context.Background(), "", "agent-aabcdef0")
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	if err := RemoveAgentWorktree(context.Background(), result.WorktreePath, result.WorktreeBranch, result.GitRoot); err != nil {
		t.Fatalf("RemoveAgentWorktree failed: %v", err)
	}

	// Directory should be gone
	if _, err := os.Stat(result.WorktreePath); !os.IsNotExist(err) {
		t.Fatal("worktree directory should be removed")
	}
}

// TestCreateAgentWorktree_NotARepo_NodeShapedError pins the TS-observable error
// shape: createAgentWorktree propagates the raw Node exec error, whose message
// is `Command failed: git rev-parse --show-toplevel\n<stderr>` when run outside
// a repository (enter-worktree.ts renders it via asErrorString).
func TestCreateAgentWorktree_NotARepo_NodeShapedError(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	notARepo := t.TempDir()

	_, err := CreateAgentWorktree(context.Background(), notARepo, "agent-norepo")
	if err == nil {
		t.Fatal("expected an error outside a git repository")
	}
	msg := err.Error()
	if !strings.HasPrefix(msg, "Command failed: git rev-parse --show-toplevel\n") {
		t.Fatalf("error message not Node-shaped: %q", msg)
	}
	if !strings.Contains(msg, "not a git repository") {
		t.Errorf("error message missing git stderr: %q", msg)
	}
}

func TestRemoveAgentWorktree_RefusesDirtyWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initTestRepo(t, repo)

	origDir, _ := os.Getwd()
	defer os.Chdir(origDir)
	os.Chdir(repo)

	result, err := CreateAgentWorktree(context.Background(), "", "agent-dirty01")
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	// Untracked file makes the worktree dirty; remove without --force must refuse.
	if err := os.WriteFile(filepath.Join(result.WorktreePath, "uncommitted.txt"), []byte("work"), 0o644); err != nil {
		t.Fatalf("write uncommitted.txt: %v", err)
	}

	err = RemoveAgentWorktree(context.Background(), result.WorktreePath, result.WorktreeBranch, result.GitRoot)
	if err == nil {
		t.Fatal("RemoveAgentWorktree should fail for a dirty worktree")
	}
	// The failure surfaces as the Node exec error message (TS removeAgentWorktree
	// propagates it and exit-worktree renders it via asErrorString).
	wantPrefix := "Command failed: git worktree remove -- " + result.WorktreePath + "\n"
	if !strings.HasPrefix(err.Error(), wantPrefix) {
		t.Errorf("removal error not Node-shaped: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "contains modified or untracked files") {
		t.Errorf("removal error missing git stderr: %q", err.Error())
	}
	if _, err := os.Stat(filepath.Join(result.WorktreePath, "uncommitted.txt")); err != nil {
		t.Fatalf("uncommitted work should survive removal refusal: %v", err)
	}
}

func TestRemoveAgentWorktree_KeepsUnmergedBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initTestRepo(t, repo)

	origDir, _ := os.Getwd()
	defer os.Chdir(origDir)
	os.Chdir(repo)

	result, err := CreateAgentWorktree(context.Background(), "", "agent-unmerged")
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	// Commit inside the worktree so the branch holds unmerged work.
	if err := os.WriteFile(filepath.Join(result.WorktreePath, "work.txt"), []byte("work"), 0o644); err != nil {
		t.Fatalf("write work.txt: %v", err)
	}
	for _, args := range [][]string{
		{"add", "."},
		{"-c", "commit.gpgsign=false", "commit", "-m", "unmerged work"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = result.WorktreePath
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	out, err := exec.Command("git", "-C", result.WorktreePath, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v", err)
	}
	tipSha := trimNewline(string(out))

	// Worktree is clean → removal succeeds; `branch -d` must then refuse the
	// unmerged branch, leaving its tip intact. TS awaits both steps, so the
	// branch refusal surfaces as an error after the worktree is already gone.
	if err := RemoveAgentWorktree(context.Background(), result.WorktreePath, result.WorktreeBranch, result.GitRoot); err == nil {
		t.Fatal("RemoveAgentWorktree should report the branch -d refusal")
	}
	if _, err := os.Stat(result.WorktreePath); !os.IsNotExist(err) {
		t.Fatal("worktree directory should be removed")
	}

	branchOut, err := exec.Command("git", "-C", repo, "rev-parse", result.WorktreeBranch).Output()
	if err != nil {
		t.Fatalf("branch %s should survive -d with unmerged commits: %v", result.WorktreeBranch, err)
	}
	if got := trimNewline(string(branchOut)); got != tipSha {
		t.Fatalf("branch tip = %q, want %q", got, tipSha)
	}
}

func TestRemoveAgentWorktree_NoGitRoot(t *testing.T) {
	if err := RemoveAgentWorktree(context.Background(), "/tmp/nonexistent", "branch", ""); err == nil {
		t.Fatal("expected an error when gitRoot is empty")
	}
}
