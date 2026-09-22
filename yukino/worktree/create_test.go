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

func TestWorktreesDir(t *testing.T) {
	got := WorktreesDir("/tmp/repo")
	want := filepath.Join("/tmp/repo", ".yukino", "worktrees")
	if got != want {
		t.Errorf("WorktreesDir = %q, want %q", got, want)
	}
}

func TestWorktreePathFor_JoinsSlug(t *testing.T) {
	got := WorktreePathFor("/tmp/repo", "alice")
	want := filepath.Join("/tmp/repo", ".yukino", "worktrees", "alice")
	if got != want {
		t.Errorf("WorktreePathFor(alice) = %q, want %q", got, want)
	}
}

func TestGetOrCreateWorktree_RoundTrip(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	repo := t.TempDir()
	initBareRepoWithCommit(t, repo)

	ctx := context.Background()

	// First call: creates a new worktree.
	r1, err := getOrCreateWorktree(ctx, repo, "feature-x")
	if err != nil {
		t.Fatalf("first getOrCreateWorktree: %v", err)
	}
	if r1.Existed {
		t.Errorf("first call: Existed=true, want false")
	}
	if r1.WorktreeBranch != "worktree-feature-x" {
		t.Errorf("WorktreeBranch = %q, want worktree-feature-x", r1.WorktreeBranch)
	}
	if !strings.HasSuffix(r1.WorktreePath, filepath.Join(".yukino", "worktrees", "feature-x")) {
		t.Errorf("WorktreePath = %q, missing expected suffix", r1.WorktreePath)
	}
	if !IsValidGitSha(r1.HeadCommit) {
		t.Errorf("HeadCommit = %q, not a valid SHA", r1.HeadCommit)
	}
	if _, err := os.Stat(filepath.Join(r1.WorktreePath, ".git")); err != nil {
		t.Errorf(".git pointer not present in worktree: %v", err)
	}

	// Second call same slug: fast-resume returns Existed=true.
	r2, err := getOrCreateWorktree(ctx, repo, "feature-x")
	if err != nil {
		t.Fatalf("second getOrCreateWorktree: %v", err)
	}
	if !r2.Existed {
		t.Errorf("second call: Existed=false, want true (fast resume)")
	}
	if r2.HeadCommit != r1.HeadCommit {
		t.Errorf("resume HeadCommit = %q, want same as create (%q)", r2.HeadCommit, r1.HeadCommit)
	}

	// Remove the worktree (the branch survives); next call should go through the
	// creation path again and reattach the orphan branch at its existing tip.
	if out, err := exec.Command("git", "-C", repo, "worktree", "remove", "--force", r1.WorktreePath).CombinedOutput(); err != nil {
		t.Fatalf("cleanup git worktree remove: %v\n%s", err, out)
	}
	r3, err := getOrCreateWorktree(ctx, repo, "feature-x")
	if err != nil {
		t.Fatalf("third getOrCreateWorktree (after remove): %v", err)
	}
	if r3.Existed {
		t.Errorf("third call (after remove): Existed=true, want false")
	}
	if r3.HeadCommit != r1.HeadCommit {
		t.Errorf("reattach HeadCommit = %q, want residual branch tip %q", r3.HeadCommit, r1.HeadCommit)
	}
}

func TestGetOrCreateWorktree_ReattachesResidualBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	repo := t.TempDir()
	baseSha := initBareRepoWithCommit(t, repo)

	ctx := context.Background()

	// Create, then commit inside the worktree so the branch holds unmerged work.
	r1, err := getOrCreateWorktree(ctx, repo, "residual")
	if err != nil {
		t.Fatalf("first getOrCreateWorktree: %v", err)
	}
	if err := os.WriteFile(filepath.Join(r1.WorktreePath, "work.txt"), []byte("work"), 0o644); err != nil {
		t.Fatalf("write work.txt: %v", err)
	}
	for _, args := range [][]string{
		{"add", "."},
		{"-c", "commit.gpgsign=false", "commit", "-m", "unmerged work"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = r1.WorktreePath
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	out, err := exec.Command("git", "-C", r1.WorktreePath, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatalf("rev-parse HEAD in worktree: %v", err)
	}
	committedSha := strings.TrimSpace(string(out))
	if committedSha == baseSha {
		t.Fatalf("commit did not move HEAD (still %s)", baseSha)
	}

	// Remove the worktree dir (clean, so no --force needed); the branch survives with its commit.
	if out, err := exec.Command("git", "-C", repo, "worktree", "remove", r1.WorktreePath).CombinedOutput(); err != nil {
		t.Fatalf("git worktree remove: %v\n%s", err, out)
	}

	// Re-create: must reattach the residual branch at its existing tip, not reset it to base.
	r2, err := getOrCreateWorktree(ctx, repo, "residual")
	if err != nil {
		t.Fatalf("second getOrCreateWorktree: %v", err)
	}
	if r2.Existed {
		t.Errorf("reattach: Existed=true, want false")
	}
	if r2.HeadCommit != committedSha {
		t.Errorf("reattach HeadCommit = %q, want residual branch tip %q (must not reset to base %q)", r2.HeadCommit, committedSha, baseSha)
	}
	if _, err := os.Stat(filepath.Join(r2.WorktreePath, "work.txt")); err != nil {
		t.Errorf("work.txt from residual branch not checked out: %v", err)
	}
}

// TestGetOrCreateWorktree_AddFailure_NodeShapedError pins the TS-observable
// error shape of the creation step: TS createAgentWorktree propagates the raw
// execFile rejection, whose message is
// `Command failed: git worktree add -- <dir> <branch>\n<stderr>`.
func TestGetOrCreateWorktree_AddFailure_NodeShapedError(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	repo := t.TempDir()
	initBareRepoWithCommit(t, repo)

	// Check the worktree-<slug> branch out in a different worktree, so the
	// reattach `git worktree add -- <dir> <branch>` is refused with a fatal.
	elsewhere := filepath.Join(t.TempDir(), "elsewhere")
	prep := exec.Command("git", "worktree", "add", "-b", "worktree-clash", "--", elsewhere)
	prep.Dir = repo
	if out, err := prep.CombinedOutput(); err != nil {
		t.Fatalf("prep git worktree add: %v\n%s", err, out)
	}

	_, err := getOrCreateWorktree(context.Background(), repo, "clash")
	if err == nil {
		t.Fatal("expected the worktree add refusal to surface as an error")
	}
	msg := err.Error()
	wantPrefix := "Command failed: git worktree add -- " + WorktreePathFor(repo, "clash") + " worktree-clash\n"
	if !strings.HasPrefix(msg, wantPrefix) {
		t.Fatalf("error message not Node-shaped:\n got %q\nwant prefix %q", msg, wantPrefix)
	}
	if !strings.Contains(msg, "already") {
		t.Errorf("error message missing git stderr: %q", msg)
	}
}

func TestGetOrCreateWorktree_RejectsPlainDirectory(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	repo := t.TempDir()
	initTestRepo(t, repo)

	// Occupy the worktree path with a plain directory: `git rev-parse --show-toplevel` inside it
	// reports the main repo root, so it must be rejected instead of resumed or created over.
	wtPath := WorktreePathFor(repo, "occupied")
	if err := os.MkdirAll(wtPath, 0o755); err != nil {
		t.Fatalf("mkdir occupied dir: %v", err)
	}

	_, err := getOrCreateWorktree(context.Background(), repo, "occupied")
	if err == nil {
		t.Fatal("expected error for a plain directory occupying the worktree path")
	}
	if !strings.Contains(err.Error(), "not a worktree root") {
		t.Fatalf("unexpected error: %v", err)
	}
}
