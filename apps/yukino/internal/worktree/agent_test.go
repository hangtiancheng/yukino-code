package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

func testWorktreeRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	repo := t.TempDir()
	repo, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	initBareRepoWithCommit(t, repo)
	return repo
}

func gitTest(t *testing.T, repo string, args ...string) string {
	t.Helper()
	out, err := gitOutput(context.Background(), repo, args...)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(out)
}

func createTestWorktree(t *testing.T, repo, slug string) *WorktreeResult {
	t.Helper()
	wt, err := CreateAgentWorktree(context.Background(), slug, "", repo)
	if err != nil {
		t.Fatal(err)
	}
	return wt
}

func TestCreateWorktreeCallerCwdAndResume(t *testing.T) {
	repo := testWorktreeRepo(t)
	nested := filepath.Join(repo, "nested")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	wt := createTestWorktree(t, nested, "feature")
	key, err := storage.ProjectKey(repo)
	if err != nil {
		t.Fatal(err)
	}
	if !wt.Created || wt.GitRoot != repo || wt.WorktreePath != storage.YukinoPath("worktrees", key, "feature") || wt.WorktreeBranch != "worktree/feature/work" {
		t.Fatalf("unexpected worktree: %+v", wt)
	}
	if wt.HeadCommit != gitTest(t, repo, "rev-parse", "HEAD") {
		t.Fatal("worktree did not start from caller HEAD")
	}
	resumed := createTestWorktree(t, repo, "feature")
	if resumed.Created || resumed.WorktreePath != wt.WorktreePath || resumed.HeadCommit != wt.HeadCommit {
		t.Fatalf("unexpected reuse: %+v", resumed)
	}
}

func TestWorktreePreservesResidualBranchAndRejectsOrdinaryDirectory(t *testing.T) {
	repo := testWorktreeRepo(t)
	base := gitTest(t, repo, "branch", "--show-current")
	gitTest(t, repo, "switch", "-c", "worktree/residual/work")
	gitTest(t, repo, "commit", "--allow-empty", "-m", "unique")
	tip := gitTest(t, repo, "rev-parse", "HEAD")
	gitTest(t, repo, "switch", base)
	gitTest(t, repo, "pack-refs", "--all")
	wt := createTestWorktree(t, repo, "residual")
	if wt.HeadCommit != tip {
		t.Fatal("residual branch was reset")
	}
	key, _ := storage.ProjectKey(repo)
	path := storage.YukinoPath("worktrees", key, "ordinary")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateAgentWorktree(context.Background(), "ordinary", repo, repo); err == nil || !strings.Contains(err.Error(), "not a worktree root") {
		t.Fatalf("ordinary directory accepted: %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(path, "keep")); string(data) != "keep" {
		t.Fatal("ordinary directory changed")
	}
}

func TestWorktreeSlug(t *testing.T) {
	for _, slug := range []string{"", "a/b", `a\b`, "a.b", "../escape", "$(touch x)"} {
		if _, err := CreateAgentWorktree(context.Background(), slug, "", t.TempDir()); err == nil || !strings.Contains(err.Error(), "slug") {
			t.Fatalf("invalid slug accepted: %q %v", slug, err)
		}
	}
	if !WorktreeSlugPattern.MatchString(strings.Repeat("a", 65)) {
		t.Fatal("unexpected legacy length cap")
	}
}

func TestOwnedWorktreeBaselineAndRemoval(t *testing.T) {
	repo := testWorktreeRepo(t)
	wt := createTestWorktree(t, repo, "owned")
	ctx := context.Background()
	owned := &OwnedWorktrees{}
	if ok, err := owned.Register(ctx, *wt); err != nil || !ok {
		t.Fatalf("register: %v", err)
	}
	if ok, err := (&OwnedWorktrees{}).Register(ctx, *createTestWorktree(t, repo, "owned")); err != nil || ok {
		t.Fatal("adopted another runtime's tree")
	}
	gitTest(t, wt.WorktreePath, "commit", "--allow-empty", "-m", "preserve")
	if ok, err := owned.Register(ctx, *createTestWorktree(t, repo, "owned")); err != nil || !ok {
		t.Fatal(err)
	}
	if owned.Get(wt.WorktreePath).HeadCommit != wt.HeadCommit {
		t.Fatal("baseline replaced")
	}
	if _, err := owned.Remove(ctx, wt.WorktreePath, false); err == nil || !strings.Contains(err.Error(), "1 commits") {
		t.Fatalf("unmerged commit removed: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(wt.WorktreePath, "untracked"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b"} {
		if err := os.WriteFile(filepath.Join(wt.WorktreePath, "untracked", name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	changes, err := owned.Remove(ctx, wt.WorktreePath, true)
	if err != nil || changes == nil || changes.ChangedFiles != 2 || changes.Commits != 1 {
		t.Fatalf("discard: %+v %v", changes, err)
	}
	if _, err := os.Stat(wt.WorktreePath); !os.IsNotExist(err) {
		t.Fatal("tree remains")
	}
	if owned.Get(wt.WorktreePath) != nil || len(owned.SandboxWriteRoots()) != 0 {
		t.Fatal("stale ownership remains")
	}
}

func TestOwnedWorktreeIdentityAndCleanRemoval(t *testing.T) {
	repo := testWorktreeRepo(t)
	ctx := context.Background()
	owned := &OwnedWorktrees{}
	wt := createTestWorktree(t, repo, "clean")
	if _, err := owned.Register(ctx, *wt); err != nil {
		t.Fatal(err)
	}
	gitDir, _ := ResolveGitDir(wt.WorktreePath)
	roots := owned.SandboxWriteRoots()
	for _, path := range roots {
		if path == filepath.Join(repo, ".git") || path == filepath.Join(repo, ".git", "refs", "heads") {
			t.Fatalf("excess Git write access: %s", path)
		}
	}
	temp, _ := utils.CanonicalPath(filepath.Join(gitDir, "yukino-tmp"), 0)
	if owned.TempDirectory(wt.WorktreePath) != temp {
		t.Fatal("missing isolated temp directory")
	}
	gitTest(t, wt.WorktreePath, "switch", "-c", "replacement")
	if _, err := owned.Remove(ctx, wt.WorktreePath, true); err == nil || !strings.Contains(err.Error(), "branch changed") {
		t.Fatalf("changed branch removed: %v", err)
	}
	gitTest(t, wt.WorktreePath, "switch", wt.WorktreeBranch)
	if _, err := owned.Remove(ctx, wt.WorktreePath, false); err != nil {
		t.Fatal(err)
	}
}

func TestHasWorktreeChangesDetectsRewind(t *testing.T) {
	repo := testWorktreeRepo(t)
	wt := createTestWorktree(t, repo, "rewind")
	gitTest(t, wt.WorktreePath, "commit", "--allow-empty", "-m", "baseline")
	baseline := gitTest(t, wt.WorktreePath, "rev-parse", "HEAD")
	gitTest(t, wt.WorktreePath, "reset", "--hard", "HEAD~1")
	if !HasWorktreeChanges(context.Background(), wt.WorktreePath, baseline) {
		t.Fatal("rewound HEAD treated as clean")
	}
}

func TestResolveRefCycle(t *testing.T) {
	gitDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(gitDir, "a"), []byte("ref: b"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "b"), []byte("ref: a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if sha, err := ResolveRef(gitDir, "a"); err != nil || sha != "" {
		t.Fatalf("cyclic ref: %s %v", sha, err)
	}
}
