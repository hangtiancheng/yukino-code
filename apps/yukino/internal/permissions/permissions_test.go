package permissions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func setupHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
}

func makeChecker(t *testing.T, tmpDir string, rules []string) *Checker {
	t.Helper()
	rulesDir := storage.GetYukinoDir()
	if err := os.MkdirAll(rulesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	rulesFile := filepath.Join(rulesDir, PermissionsRulesFilename)
	if err := os.WriteFile(rulesFile, []byte(strings.Join(rules, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}
	checker := NewChecker(NewPathSandbox(tmpDir, true), NewRuleEngine(tmpDir), ModeDefault)
	checker.SandboxEnabled = true
	checker.SandboxAutoAllow = true
	return checker
}

func ruleLine(rule, effect string) string {
	return "- rule: \"" + rule + "\"\n  effect: " + effect
}

func checkBash(t *testing.T, c *Checker, command string) Decision {
	t.Helper()
	return c.checkAction("Bash", tools.CategoryCommand, map[string]any{"command": command})
}

func TestSandboxAutoAllowRespectsDenyAskRules(t *testing.T) {
	setupHome(t)
	t.Run("denies compound command with denied subcommand", func(t *testing.T) {
		dir := t.TempDir()
		checker := makeChecker(t, dir, []string{ruleLine("Bash(rm -rf /)", "deny")})
		if got := checkBash(t, checker, "echo ok && rm -rf /"); got.Effect != Deny {
			t.Fatalf("effect = %s, want deny", got.Effect)
		}
	})
	separators := map[string]string{
		"a single ampersand": " & ",
		"a carriage return":  "\r",
		"a line feed":        "\n",
	}
	for label, separator := range separators {
		t.Run("splits on "+label+" before applying deny and ask rules", func(t *testing.T) {
			denied := checkBash(t, makeChecker(t, t.TempDir(), []string{ruleLine("Bash(rm -rf /)", "deny")}),
				"echo ok"+separator+"rm -rf /")
			asked := checkBash(t, makeChecker(t, t.TempDir(), []string{ruleLine("Bash(git push origin main)", "ask")}),
				"echo ok"+separator+"git push origin main")
			if denied.Effect != Deny {
				t.Fatalf("denied effect = %s, want deny", denied.Effect)
			}
			if asked.Effect != Ask {
				t.Fatalf("asked effect = %s, want ask", asked.Effect)
			}
		})
	}
	t.Run("allows safe command with sandbox", func(t *testing.T) {
		checker := makeChecker(t, t.TempDir(), []string{ruleLine("Bash(rm -rf /)", "deny")})
		if got := checkBash(t, checker, "go test ./..."); got.Effect != Allow {
			t.Fatalf("effect = %s (%s), want allow", got.Effect, got.Reason)
		}
	})
	t.Run("does not auto-allow an uninspectable Bash command", func(t *testing.T) {
		for _, args := range []map[string]any{{}, {"command": 42}, {"command": "   "}} {
			checker := makeChecker(t, t.TempDir(), nil)
			got := checker.checkAction("Bash", tools.CategoryCommand, args)
			if got.Effect != Ask || !strings.Contains(got.Reason, "non-empty Bash command") {
				t.Fatalf("args %v: effect = %s reason = %s", args, got.Effect, got.Reason)
			}
		}
	})
	t.Run("respects ask rule even with sandbox", func(t *testing.T) {
		checker := makeChecker(t, t.TempDir(), []string{ruleLine("Bash(git push origin main)", "ask")})
		if got := checkBash(t, checker, "git push origin main"); got.Effect != Ask {
			t.Fatalf("effect = %s, want ask", got.Effect)
		}
	})
	t.Run("does not auto-allow when the sandbox backend is not ready", func(t *testing.T) {
		checker := makeChecker(t, t.TempDir(), nil)
		checker.SandboxEnabled = false
		if got := checkBash(t, checker, "touch generated.txt"); got.Effect != Ask {
			t.Fatalf("effect = %s, want ask", got.Effect)
		}
	})
}

func TestReadOnlyDockerCommands(t *testing.T) {
	setupHome(t)
	for _, command := range []string{"docker ps", "docker images --all"} {
		checker := NewChecker(NewPathSandbox(t.TempDir(), true), NewRuleEngine(t.TempDir()), ModePlan)
		if got := checkBash(t, checker, command); got.Effect != Allow {
			t.Fatalf("%s: effect = %s, want allow", command, got.Effect)
		}
	}
}

func TestExtraAllowedRoots(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	outside := t.TempDir()
	checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeDefault)
	target := filepath.Join(outside, "notes.md")

	write := checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": target})
	if write.Effect != Ask {
		t.Fatalf("outside write effect = %s, want ask", write.Effect)
	}
	checker.Sandbox.AddRoot(outside)
	write = checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": target})
	if write.Effect != Ask || !strings.Contains(write.Reason, "Mode") {
		// After opening the root the path layer passes; the default mode still
		// asks for writes, but with the mode reason rather than the sandbox one.
		if strings.Contains(write.Reason, "outside allowed directories") {
			t.Fatalf("root not opened: %s", write.Reason)
		}
	}
}

func TestBypassSkipsPathChecks(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	outside := t.TempDir()
	checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeBypass)
	got := checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": filepath.Join(outside, "x.md")})
	if got.Effect != Allow {
		t.Fatalf("effect = %s, want allow", got.Effect)
	}
}

func TestPlanModeDeniesMutations(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModePlan)

	got := checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": filepath.Join(project, "x.md")})
	if got.Effect != Deny || got.Reason != "Plan mode forbids mutations" {
		t.Fatalf("write: %+v, want deny", got)
	}
	got = checker.checkAction("ReadFile", tools.CategoryRead, map[string]any{"file_path": filepath.Join(project, "x.md")})
	if got.Effect != Allow {
		t.Fatalf("read: %+v, want allow", got)
	}
	got = checker.checkAction("AskUserQuestion", tools.CategoryRead, map[string]any{})
	if got.Effect != Allow || got.Reason != "Plan coordination tool" {
		t.Fatalf("coordination: %+v, want allow", got)
	}
}

func TestPlanModeAllowsExactPlanFile(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	planPath := filepath.Join(project, "plan.md")
	checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModePlan)
	checker.SetPlanFilePath(planPath)

	got := checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": planPath})
	if got.Effect != Allow || got.Reason != "Plan file write allowed in plan mode" {
		t.Fatalf("plan file write: %+v, want allow", got)
	}
	got = checker.checkAction("EditFile", tools.CategoryWrite, map[string]any{"file_path": planPath})
	if got.Effect != Allow {
		t.Fatalf("plan file edit: %+v, want allow", got)
	}
	got = checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": filepath.Join(project, "other.md")})
	if got.Effect != Deny {
		t.Fatalf("other write: %+v, want deny", got)
	}
}

func TestSymlinkTargetsAreChecked(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	// Point the link at a directory outside both the project and the OS temp
	// dir so the canonical target falls outside every allowed root.
	if err := os.Symlink("/", filepath.Join(project, "external")); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(project, "external", ".outside-project", "file.ts")
	checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeDefault)
	got := checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": target})
	if got.Effect != Ask || !strings.Contains(got.Reason, "outside allowed directories") {
		t.Fatalf("symlink write: %+v, want ask (outside)", got)
	}
	if got := checker.checkAction("ReadFile", tools.CategoryRead, map[string]any{"file_path": target}); got.Effect != Allow {
		t.Fatalf("read: %+v, want allow", got)
	}
	checker.SetMode(ModeBypass)
	if got := checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": target}); got.Effect != Allow {
		t.Fatalf("bypass write: %+v, want allow", got)
	}
}

func TestTeammateCoordinationTools(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	t.Run("auto-allows SendMessage and task-board tools for teammate checkers", func(t *testing.T) {
		checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeDefault)
		checker.Teammate = true
		for _, tool := range []string{"SendMessage", "TodoWrite"} {
			got := checker.checkAction(tool, tools.CategoryWrite, map[string]any{})
			if got.Effect != Allow || got.Reason != "Teammate coordination tool" {
				t.Fatalf("%s: %+v, want teammate allow", tool, got)
			}
		}
	})
	t.Run("keeps SendMessage behind approval for non-teammate checkers", func(t *testing.T) {
		checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeDefault)
		got := checker.checkAction("SendMessage", tools.CategoryWrite, map[string]any{})
		if got.Effect != Ask {
			t.Fatalf("effect = %s, want ask", got.Effect)
		}
	})
	t.Run("explicit deny rules still gate teammate coordination tools", func(t *testing.T) {
		checker := makeChecker(t, project, []string{ruleLine("SendMessage(*)", "deny")})
		checker.Teammate = true
		got := checker.checkAction("SendMessage", tools.CategoryWrite, map[string]any{"to": "lead", "content": "hi"})
		if got.Effect != Deny {
			t.Fatalf("effect = %s, want deny", got.Effect)
		}
	})
}

func TestRuleMergingAcrossFiles(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	userRules := storage.YukinoPath(PermissionsRulesFilename)
	projectRules, err := storage.ProjectPath(project, PermissionsRulesFilename)
	if err != nil {
		t.Fatal(err)
	}
	write := func(path string, rules []string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(strings.Join(rules, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	newChecker := func() *Checker {
		return NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeDefault)
	}

	t.Run("deny in project beats allow in user", func(t *testing.T) {
		write(userRules, []string{ruleLine("Bash(curl *)", "allow")})
		write(projectRules, []string{ruleLine("Bash(curl *)", "deny")})
		if got := checkBash(t, newChecker(), "curl https://example.com"); got.Effect != Deny {
			t.Fatalf("effect = %s, want deny", got.Effect)
		}
	})
	t.Run("deny in user beats allow in project", func(t *testing.T) {
		write(userRules, []string{ruleLine("Bash(curl *)", "deny")})
		write(projectRules, []string{ruleLine("Bash(curl *)", "allow")})
		if got := checkBash(t, newChecker(), "curl https://example.com"); got.Effect != Deny {
			t.Fatalf("effect = %s, want deny", got.Effect)
		}
	})
	t.Run("ask beats allow", func(t *testing.T) {
		write(userRules, []string{ruleLine("Bash(curl *)", "allow")})
		write(projectRules, []string{ruleLine("Bash(curl *)", "ask")})
		if got := checkBash(t, newChecker(), "curl https://example.com"); got.Effect != Ask {
			t.Fatalf("effect = %s, want ask", got.Effect)
		}
	})
	t.Run("deny beats allow regardless of order in the same file", func(t *testing.T) {
		write(userRules, nil)
		write(projectRules, []string{ruleLine("Bash(curl *)", "allow"), ruleLine("Bash(curl *)", "deny")})
		if got := checkBash(t, newChecker(), "curl https://example.com"); got.Effect != Deny {
			t.Fatalf("effect = %s, want deny", got.Effect)
		}
		write(projectRules, []string{ruleLine("Bash(curl *)", "deny"), ruleLine("Bash(curl *)", "allow")})
		if got := checkBash(t, newChecker(), "curl https://example.com"); got.Effect != Deny {
			t.Fatalf("reversed: effect = %s, want deny", got.Effect)
		}
	})
	t.Run("picks up rule file changes without restart", func(t *testing.T) {
		write(userRules, nil)
		write(projectRules, []string{ruleLine("Bash(curl *)", "deny")})
		checker := newChecker()
		if got := checkBash(t, checker, "curl https://example.com"); got.Effect != Deny {
			t.Fatalf("effect = %s, want deny", got.Effect)
		}
		time.Sleep(10 * time.Millisecond)
		write(projectRules, []string{ruleLine("Bash(curl *)", "allow")})
		future := time.Now().Add(2 * time.Second)
		_ = os.Chtimes(projectRules, future, future)
		if got := checkBash(t, checker, "curl https://example.com"); got.Effect != Allow {
			t.Fatalf("after edit: effect = %s, want allow", got.Effect)
		}
	})
}

func TestComplexShellSyntaxRequiresApproval(t *testing.T) {
	setupHome(t)
	checker := makeChecker(t, t.TempDir(), nil)
	for _, command := range []string{
		"if [ -f x ]; then rm x; fi",
		"curl $(ls)",
		"git log `date`",
		"for f in *; do echo $f; done",
		`git show "unterminated`,
	} {
		got := checkBash(t, checker, command)
		if got.Effect != Ask || got.Reason != "Complex shell syntax requires approval" {
			t.Fatalf("%q: %+v, want complex-syntax ask", command, got)
		}
	}
}

func TestAnalyzeShellSplitsSimpleLists(t *testing.T) {
	analysis := AnalyzeShell("git status && git log -1", false)
	if !analysis.Complete {
		t.Fatal("simple list must be complete")
	}
	if len(analysis.Commands) != 2 {
		t.Fatalf("commands = %+v, want 2", analysis.Commands)
	}
	if analysis.Commands[0].Content != "git status" || analysis.Commands[1].Content != "git log -1" {
		t.Fatalf("commands = %+v", analysis.Commands)
	}
	if analysis := AnalyzeShell("FOO=1 bar", false); analysis.Complete {
		t.Fatal("variable assignment prefix must be incomplete")
	}
	if analysis := AnalyzeShell("sudo rm x", false); analysis.Complete {
		t.Fatal("sudo must be incomplete")
	}
	if analysis := AnalyzeShell("echo hi # comment", false); !analysis.Complete || len(analysis.Commands) != 1 || analysis.Commands[0].Content != "echo hi" {
		t.Fatalf("comment handling: %+v", analysis)
	}
	if analysis := AnalyzeShell(`echo "a;b"`, false); !analysis.Complete || analysis.Commands[0].Content != `echo a;b` {
		t.Fatalf("quoted separator: %+v", analysis)
	}
}

func TestIsSafeCommandRejectsMetacharacters(t *testing.T) {
	for _, command := range []string{"cat", "cat file.txt", "grep -r x .", "docker ps", "head -1 f", "true"} {
		if !tools.IsSafeCommand(command) {
			t.Errorf("%q must be safe", command)
		}
	}
	for _, command := range []string{
		"cat f && rm -rf /",
		"cat f | sh",
		"cat f > out",
		"cat f < in",
		"echo `date`",
		"echo $(x)",
		"cat f;",
		"ls",
		"find . -name x",
		"git status",
		"xargs cat",
	} {
		if tools.IsSafeCommand(command) {
			t.Errorf("%q must NOT be safe", command)
		}
	}
}

func TestRememberPatternsAndAllowAlways(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeDefault)

	patterns := checker.RememberPatterns("ReadFile", map[string]any{"file_path": filepath.Join(project, "main.go")})
	if len(patterns) != 1 || !strings.HasSuffix(patterns[0], "/*)") || !strings.HasPrefix(patterns[0], "ReadFile(") {
		t.Fatalf("file patterns = %v", patterns)
	}
	patterns = checker.RememberPatterns("Bash", map[string]any{"command": "git status && git log -1"})
	if len(patterns) != 2 || patterns[0] != `Bash(git status*)` || patterns[1] != `Bash(git log*)` {
		t.Fatalf("bash patterns = %v", patterns)
	}
	if patterns := checker.RememberPatterns("Bash", map[string]any{"command": "cat $(x)"}); len(patterns) != 0 {
		t.Fatalf("complex command must not produce patterns: %v", patterns)
	}
	if patterns := checker.RememberPatterns(tools.McpCallToolName, map[string]any{"server": "linear"}); len(patterns) != 0 {
		t.Fatalf("McpCall without tool must not produce patterns: %v", patterns)
	}
	patterns = checker.RememberPatterns(tools.McpCallToolName, map[string]any{"server": "linear", "tool": "create_issue"})
	if len(patterns) != 1 || !strings.HasPrefix(patterns[0], "McpCall(") {
		t.Fatalf("McpCall patterns = %v", patterns)
	}

	checker.AllowAlways("Bash", map[string]any{"command": "git status"}, nil)
	projectRules, err := storage.ProjectPath(project, PermissionsRulesFilename)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(projectRules)
	if err != nil {
		t.Fatalf("rules file not written: %v", err)
	}
	if !strings.Contains(string(data), "Bash(git status*)") || !strings.Contains(string(data), "allow") {
		t.Fatalf("rules file = %s", data)
	}
	// The persisted rule takes effect for a fresh checker.
	fresh := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeDefault)
	if got := checkBash(t, fresh, "git status"); got.Effect != Allow {
		t.Fatalf("after allow-always: %+v, want allow", got)
	}
}

func TestWildcardToolRules(t *testing.T) {
	setupHome(t)
	checker := makeChecker(t, t.TempDir(), []string{ruleLine("*(danger*)", "deny")})
	got := checkBash(t, checker, "danger-command")
	if got.Effect != Deny {
		t.Fatalf("effect = %s, want deny via wildcard tool rule", got.Effect)
	}
}

func TestReadOnlyCheckerBehavesLikePlanMode(t *testing.T) {
	setupHome(t)
	project := t.TempDir()
	checker := NewChecker(NewPathSandbox(project, true), NewRuleEngine(project), ModeDefault)
	checker.ReadOnly = true
	got := checker.checkAction("WriteFile", tools.CategoryWrite, map[string]any{"file_path": filepath.Join(project, "x.md")})
	if got.Effect != Deny || got.Reason != "Plan mode forbids mutations" {
		t.Fatalf("read-only write: %+v, want plan-mode deny", got)
	}
	got = checker.checkAction("ReadFile", tools.CategoryRead, map[string]any{"file_path": filepath.Join(project, "x.md")})
	if got.Effect != Allow {
		t.Fatalf("read-only read: %+v, want allow", got)
	}
}
