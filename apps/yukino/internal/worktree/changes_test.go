package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestHasWorktreeChanges_Clean(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initBareRepoWithCommit(t, repo)

	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	head := strings.TrimSpace(string(out))

	if HasWorktreeChanges(context.Background(), repo, head) {
		t.Fatal("expected no changes in clean repo")
	}
}

func TestHasWorktreeChanges_Dirty(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initBareRepoWithCommit(t, repo)

	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = repo
	out, _ := cmd.Output()
	head := strings.TrimSpace(string(out))

	os.WriteFile(filepath.Join(repo, "dirty.txt"), []byte("dirty"), 0o644)

	if !HasWorktreeChanges(context.Background(), repo, head) {
		t.Fatal("expected changes with uncommitted file")
	}
}

func TestHasWorktreeChanges_NewCommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initBareRepoWithCommit(t, repo)

	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = repo
	out, _ := cmd.Output()
	head := strings.TrimSpace(string(out))

	os.WriteFile(filepath.Join(repo, "new.txt"), []byte("new"), 0o644)
	exec.Command("git", "-C", repo, "add", ".").Run()
	exec.Command("git", "-C", repo, "commit", "-m", "new").Run()

	if !HasWorktreeChanges(context.Background(), repo, head) {
		t.Fatal("expected changes with new commit")
	}
}

func TestHasWorktreeChanges_FailClosed(t *testing.T) {
	if !HasWorktreeChanges(context.Background(), "/nonexistent-path-xyz", "abc123") {
		t.Fatal("expected true for non-existent path (fail-closed)")
	}
}

func TestCountWorktreeChanges_Clean(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repo := t.TempDir()
	initBareRepoWithCommit(t, repo)

	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = repo
	out, _ := cmd.Output()
	head := strings.TrimSpace(string(out))

	summary := CountWorktreeChanges(context.Background(), repo, head)
	if summary == nil {
		t.Fatal("expected non-nil summary for clean repo")
	}
	if summary.ChangedFiles != 0 || summary.Commits != 0 {
		t.Fatalf("expected 0/0, got %d/%d", summary.ChangedFiles, summary.Commits)
	}
}

func TestCountWorktreeChanges_FailClosed(t *testing.T) {
	summary := CountWorktreeChanges(context.Background(), "/nonexistent-path-xyz", "abc123")
	if summary != nil {
		t.Fatal("expected nil for non-existent path (fail-closed)")
	}
}
