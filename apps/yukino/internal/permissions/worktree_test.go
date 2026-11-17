package permissions

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/sandbox"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/worktree"
)

func worktreeTestRuntime(t *testing.T) (string, *Checker, context.Context) {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	repo, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.name", "Test"}, {"config", "user.email", "test@example.invalid"}, {"-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s %v", args, out, err)
		}
	}
	checker := NewChecker(NewPathSandbox(repo, true), NewRuleEngine(repo), ModeAcceptEdits)
	ctx := tools.WithExecutionContext(context.Background(), tools.ExecutionContext{WorkDir: repo, Worktrees: checker, FileStateCache: tools.NewFileStateCache()})
	return repo, checker, ctx
}

func TestNativeWorktreeSandboxCommitAndBoundaries(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("native seatbelt integration")
	}
	repo, parent, _ := worktreeTestRuntime(t)
	ctx := context.Background()
	first, err := worktree.CreateAgentWorktree(ctx, "native-first", "", repo)
	if err != nil {
		t.Fatal(err)
	}
	second, err := worktree.CreateAgentWorktree(ctx, "native-second", "", repo)
	if err != nil {
		t.Fatal(err)
	}
	checker, err := parent.ForWorktree(ctx, *first)
	if err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(first.WorktreePath, "protected")
	if err := os.Mkdir(protected, 0o755); err != nil {
		t.Fatal(err)
	}
	tool := &tools.BashTool{Sandbox: &sandbox.SeatbeltSandbox{}, SandboxConfig: sandbox.Config{AllowWrite: []string{repo, os.TempDir()}, DenyWrite: []string{protected}}}
	ctx = tools.WithExecutionContext(ctx, tools.ExecutionContext{WorkDir: first.WorktreePath, Worktrees: checker, SessionID: "native-worktree"})
	result := tool.Execute(ctx, map[string]any{"command": "printf 'changed\\n' > tracked.txt && git -c core.fsmonitor=false add tracked.txt && git -c commit.gpgsign=false -c gc.auto=0 commit -qm update && mktemp"})
	if result.IsError || !strings.Contains(result.Output, checker.SandboxTempDirectory()) {
		t.Fatalf("sandbox commit: %s", result.Output)
	}
	quote := func(path string) string { return "'" + strings.ReplaceAll(path, "'", "'\\''") + "'" }
	for _, path := range []string{filepath.Join(repo, "blocked.txt"), filepath.Join(second.WorktreePath, "blocked.txt"), filepath.Join(protected, "blocked.txt")} {
		if result := tool.Execute(ctx, map[string]any{"command": "touch " + quote(path)}); !result.IsError {
			t.Fatalf("sandbox allowed %s", path)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("sandbox wrote %s", path)
		}
	}
	if result := tool.Execute(ctx, map[string]any{"command": "git update-ref refs/heads/main HEAD"}); !result.IsError {
		t.Fatal("sandbox allowed parent ref write")
	}
	for _, path := range []string{repo, second.WorktreePath} {
		cmd := exec.Command("git", "rev-parse", "HEAD")
		cmd.Dir = path
		out, err := cmd.Output()
		if err != nil || strings.TrimSpace(string(out)) != first.HeadCommit {
			t.Fatalf("parent or sibling HEAD changed: %s %v", out, err)
		}
	}
}

func TestWorktreeKeepReenterAndRuntimeIsolation(t *testing.T) {
	repo, parent, ctx := worktreeTestRuntime(t)
	enter, exit := &tools.EnterWorktreeTool{}, &tools.ExitWorktreeTool{}
	if result := enter.Execute(ctx, map[string]any{"slug": "owned"}); result.IsError {
		t.Fatal(result.Output)
	}
	session := parent.WorktreeSession()
	if session == nil || parent.Cwd() != session.WorktreePath {
		t.Fatal("session not active")
	}
	for _, checker := range []*Checker{parent.ForSubagent(repo, ""), NewChecker(NewPathSandbox(repo, true), NewRuleEngine(repo), ModeAcceptEdits)} {
		childCtx := tools.WithExecutionContext(ctx, tools.ExecutionContext{WorkDir: repo, Worktrees: checker})
		if result := exit.Execute(childCtx, map[string]any{"action": "remove", "discard_changes": true}); !result.IsError || !strings.Contains(result.Output, "No-op") {
			t.Fatal(result)
		}
		if result := enter.Execute(childCtx, map[string]any{"slug": "owned"}); !result.IsError {
			t.Fatal("adopted parent tree")
		}
	}
	cmd := exec.Command("git", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "preserve")
	cmd.Dir = session.WorktreePath
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v", out, err)
	}
	if result := exit.Execute(ctx, map[string]any{"action": "keep"}); result.IsError {
		t.Fatal(result.Output)
	}
	if slices.Contains(parent.SandboxWriteRoots([]string{repo}), session.WorktreePath) {
		t.Fatal("kept tree retains extra write root")
	}
	if result := enter.Execute(ctx, map[string]any{"slug": "owned"}); result.IsError {
		t.Fatal(result.Output)
	}
	if parent.WorktreeSession().HeadCommit != session.HeadCommit {
		t.Fatal("baseline replaced")
	}
	if result := exit.Execute(ctx, map[string]any{"action": "remove"}); !result.IsError || !strings.Contains(result.Output, "1 commits") {
		t.Fatal(result)
	}
	if result := exit.Execute(ctx, map[string]any{"action": "remove", "discard_changes": true}); result.IsError {
		t.Fatal(result.Output)
	}
	if parent.Cwd() != repo || parent.WorktreeSession() != nil {
		t.Fatal("session not restored")
	}
}

func TestIsolatedWorktreeRoots(t *testing.T) {
	repo, parent, _ := worktreeTestRuntime(t)
	ctx := context.Background()
	first, err := worktree.CreateAgentWorktree(ctx, "first", "", repo)
	if err != nil {
		t.Fatal(err)
	}
	second, err := worktree.CreateAgentWorktree(ctx, "second", "", repo)
	if err != nil {
		t.Fatal(err)
	}
	checker, err := parent.ForWorktree(ctx, *first)
	if err != nil {
		t.Fatal(err)
	}
	child := checker.ForSubagent(first.WorktreePath, "")
	write := &tools.WriteFileTool{}
	for _, path := range []string{filepath.Join(repo, "blocked"), filepath.Join(second.WorktreePath, "blocked"), filepath.Join(os.TempDir(), "blocked")} {
		if decision := child.Check(write, map[string]any{"file_path": path}); decision.Effect != Ask {
			t.Fatalf("outside write allowed: %s %+v", path, decision)
		}
	}
	if decision := child.Check(write, map[string]any{"file_path": "local"}); decision.Effect != Allow {
		t.Fatal(decision)
	}
	roots := child.SandboxWriteRoots([]string{repo, os.TempDir()})
	for _, path := range []string{repo, os.TempDir(), second.WorktreePath, filepath.Join(repo, ".git"), filepath.Join(repo, ".git", "refs", "heads")} {
		if slices.Contains(roots, path) {
			t.Fatalf("excess write root: %s", path)
		}
	}
	if !slices.Contains(roots, filepath.Join(repo, ".git", "objects")) || !slices.Contains(roots, first.WorktreePath) || child.SandboxTempDirectory() == "" {
		t.Fatalf("missing write roots: %+v", roots)
	}
}

func TestWorktreePartialCleanupRestoresSession(t *testing.T) {
	repo, checker, ctx := worktreeTestRuntime(t)
	if result := (&tools.EnterWorktreeTool{}).Execute(ctx, map[string]any{"slug": "branch-lock"}); result.IsError {
		t.Fatal(result.Output)
	}
	session := checker.WorktreeSession()
	lock := filepath.Join(repo, ".git", "refs", "heads", session.WorktreeBranch+".lock")
	if err := os.WriteFile(lock, []byte("lock"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := (&tools.ExitWorktreeTool{}).Execute(ctx, map[string]any{"action": "remove"})
	if !result.IsError || !strings.Contains(result.Output, "Session restored") || checker.WorktreeSession() != nil || checker.Cwd() != repo {
		t.Fatalf("partial cleanup: %+v", result)
	}
}

func TestWorktreeStrictArguments(t *testing.T) {
	_, checker, ctx := worktreeTestRuntime(t)
	for _, args := range []map[string]any{{"name": "legacy"}, {"slug": nil}, {"slug": ""}, {"slug": "../escape"}} {
		if result := (&tools.EnterWorktreeTool{}).Execute(ctx, args); !result.IsError || checker.WorktreeSession() != nil {
			t.Fatal(result)
		}
	}
	if result := (&tools.EnterWorktreeTool{}).Execute(ctx, map[string]any{}); result.IsError {
		t.Fatal(result.Output)
	}
	for _, args := range []map[string]any{{}, {"action": "other"}, {"action": "remove", "discard_changes": "true"}, {"action": "remove", "path": "/forged"}} {
		if result := (&tools.ExitWorktreeTool{}).Execute(ctx, args); !result.IsError || checker.WorktreeSession() == nil {
			t.Fatal(result)
		}
	}
}
