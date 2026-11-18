package worktree

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

func TestGitNoPromptEnv(t *testing.T) {
	env := gitNoPromptEnv()
	hasPrompt := false
	hasAskpass := false
	for _, kv := range env {
		if kv == "GIT_TERMINAL_PROMPT=0" {
			hasPrompt = true
		}
		if kv == "GIT_ASKPASS=" {
			hasAskpass = true
		}
	}
	if !hasPrompt {
		t.Error("gitNoPromptEnv missing GIT_TERMINAL_PROMPT=0")
	}
	if !hasAskpass {
		t.Error(`gitNoPromptEnv missing GIT_ASKPASS=""`)
	}
}

func TestRunGit_Version(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	stdout, _, code := runGit(context.Background(), t.TempDir(), "--version")
	if code != 0 {
		t.Fatalf("git --version exit code = %d, want 0", code)
	}
	if !strings.Contains(stdout, "git version") {
		t.Errorf("git --version stdout = %q, want substring 'git version'", stdout)
	}
}

func TestRunGit_NonZeroExit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	_, stderr, code := runGit(context.Background(), t.TempDir(), "status")
	if code == 0 {
		t.Errorf("git status in non-repo: expected non-zero exit, got 0")
	}
	if stderr == "" {
		t.Errorf("git status in non-repo: expected stderr message, got empty")
	}
}

func TestRunGit_ContextCancel(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, code := runGit(ctx, t.TempDir(), "--version")
	if code == 0 {
		t.Errorf("cancelled ctx: expected non-zero exit, got 0")
	}
}
