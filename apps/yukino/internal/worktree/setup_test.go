package worktree

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorktreeSetup(t *testing.T) {
	repo := testWorktreeRepo(t)
	for path, content := range map[string]string{".agents/AGENTS.md": "instructions", ".agents/skills/demo/SKILL.md": "skill", ".agents/private": "excluded", ".yukino/settings.local.json": "excluded", "config/nested/value": "copied", ".worktreeinclude": "# comment\nconfig\n../escape\n", "node_modules/demo": "linked"} {
		path = filepath.Join(repo, path)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(repo, ".husky"), 0o755); err != nil {
		t.Fatal(err)
	}
	wt := createTestWorktree(t, repo, "setup")
	for path, want := range map[string]string{".agents/AGENTS.md": "instructions", ".agents/skills/demo/SKILL.md": "skill", "config/nested/value": "copied", "node_modules/demo": "linked"} {
		data, err := os.ReadFile(filepath.Join(wt.WorktreePath, path))
		if err != nil || string(data) != want {
			t.Fatalf("%s: %s %v", path, data, err)
		}
	}
	for _, path := range []string{".agents/private", ".yukino"} {
		if _, err := os.Stat(filepath.Join(wt.WorktreePath, path)); !os.IsNotExist(err) {
			t.Fatalf("runtime state copied: %s", path)
		}
	}
	if got := gitTest(t, wt.WorktreePath, "config", "--worktree", "--get", "core.hooksPath"); got != filepath.Join(repo, ".husky") {
		t.Fatal(got)
	}
	if _, _, code := runGit(t.Context(), repo, "config", "--get", "core.hooksPath"); code == 0 {
		t.Fatal("main repository hooks config changed")
	}
}

func TestWorktreePreservesUserHooks(t *testing.T) {
	repo := testWorktreeRepo(t)
	gitTest(t, repo, "config", "core.hooksPath", "/custom-hooks")
	createTestWorktree(t, repo, "hooks")
	if got := gitTest(t, repo, "config", "--get", "core.hooksPath"); got != "/custom-hooks" {
		t.Fatal(got)
	}
}
