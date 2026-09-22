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

package prompt

import (
	"regexp"
	"strings"
	"testing"
)

// Port of the TS tests/prompt-contracts.test.ts system-prompt, plan-mode and
// coordinator sections: these tests pin the shipped strings and structural
// invariants so Go/TS drift is caught mechanically.

var contractEnv = EnvironmentContext{
	WorkDir:   "/project",
	OS:        "linux",
	Arch:      "arm64",
	Shell:     "/bin/bash",
	IsGitRepo: true,
	GitBranch: "feature",
	Model:     "test-model",
	Date:      "2026-09-01",
}

func TestBuilderSortsStablyDeduplicatesAndSkipsEmpty(t *testing.T) {
	builder := NewBuilder()
	if got := builder.Build(); got != "" {
		t.Fatalf("empty builder must build \"\", got %q", got)
	}
	builder.
		Add(Section{Name: "later", Priority: 20, Content: " second "}).
		Add(Section{Name: "empty", Priority: -1, Content: "\n "}).
		Add(Section{Name: "first", Priority: 10, Content: " first "}).
		Add(Section{Name: "tie", Priority: 20, Content: "third"}).
		Add(Section{Name: "duplicate", Priority: 30, Content: "second\n"})
	want := "first\n\nsecond\n\nthird"
	if got := builder.Build(); got != want {
		t.Fatalf("build = %q, want %q", got, want)
	}
	if got := builder.Build(); got != want {
		t.Fatalf("second build = %q, want %q (build must not mutate)", got, want)
	}
	builder.Add(Section{Name: "earlier", Priority: 0, Content: "zero"})
	if got := builder.Build(); got != "zero\n\nfirst\n\nsecond\n\nthird" {
		t.Fatalf("build after add = %q", got)
	}
}

func TestNodePlatformArchMapping(t *testing.T) {
	// The Environment section must render the Node os.platform()/os.arch()
	// values, not the raw Go runtime identifiers.
	cases := map[string]struct{ goos, want string }{
		"windows": {"windows", "win32"},
		"solaris": {"solaris", "sunos"},
		"linux":   {"linux", "linux"},
		"darwin":  {"darwin", "darwin"},
	}
	for name, tc := range cases {
		if got := mapPlatform(tc.goos); got != tc.want {
			t.Errorf("mapPlatform(%s) = %q, want %q", name, got, tc.want)
		}
	}
	archCases := map[string]struct{ goarch, want string }{
		"amd64":  {"amd64", "x64"},
		"386":    {"386", "ia32"},
		"mipsle": {"mipsle", "mipsel"},
		"arm64":  {"arm64", "arm64"},
	}
	for name, tc := range archCases {
		if got := mapArch(tc.goarch); got != tc.want {
			t.Errorf("mapArch(%s) = %q, want %q", name, got, tc.want)
		}
	}
}

func TestBuildSystemPromptConciseAndEnvironmentOnly(t *testing.T) {
	prompt := BuildSystemPrompt(contractEnv)
	if again := BuildSystemPrompt(contractEnv); again != prompt {
		t.Fatal("buildSystemPrompt must be deterministic for equal environments")
	}
	if len(prompt) >= 6500 {
		t.Errorf("system prompt length = %d, want < 6500", len(prompt))
	}
	for _, heading := range []string{"# Guidelines", "# Tools", "# Environment"} {
		if got := strings.Count(prompt, heading); got != 1 {
			t.Errorf("heading %q occurs %d times, want exactly 1", heading, got)
		}
	}
	for _, value := range []string{
		contractEnv.WorkDir,
		"linux/arm64",
		contractEnv.Shell,
		contractEnv.GitBranch,
		contractEnv.Model,
		contractEnv.Date,
	} {
		if !strings.Contains(prompt, value) {
			t.Errorf("system prompt must contain %q", value)
		}
	}
	for _, banned := range []string{"<available-skills>", "<skill-body>", "Active memories:"} {
		if strings.Contains(prompt, banned) {
			t.Errorf("system prompt must not contain %q", banned)
		}
	}

	minimal := BuildSystemPrompt(EnvironmentContext{
		WorkDir: contractEnv.WorkDir,
		OS:      contractEnv.OS,
		Arch:    contractEnv.Arch,
		Shell:   contractEnv.Shell,
		Date:    contractEnv.Date,
	})
	if !strings.Contains(minimal, "Git repository: false") {
		t.Error("minimal prompt must report Git repository: false")
	}
	for _, banned := range []string{"Git branch:", "Model:"} {
		if strings.Contains(minimal, banned) {
			t.Errorf("minimal prompt must not contain %q", banned)
		}
	}
}

func TestBuildSystemPromptRetainsInvariants(t *testing.T) {
	prompt := BuildSystemPrompt(contractEnv)
	constraints := []string{
		"<system-reminder>",
		"MCP responses",
		"untrusted task data",
		"not authorization",
		"Never bypass permission denials or hook blocks",
		"another tool or disguised arguments",
		"0-based",
		"stale file-state",
		"Read before editing",
		"within scope",
		"command injection",
		"XSS",
		"SQL injection",
		"Never fabricate URLs",
		"actual UI",
		"unobserved success",
		"task tools",
		"TeamCreate",
		"team_name",
		"run_in_background",
		"ToolSearch",
		"McpCall",
		"select:<exact-tool-name>",
		"Do not expose internal deliberation",
	}
	for _, constraint := range constraints {
		if !strings.Contains(prompt, constraint) {
			t.Errorf("system prompt lost invariant %q", constraint)
		}
	}
	banned := regexp.MustCompile(`(?i)show your (analysis|reasoning)|think step.by.step`)
	if banned.MatchString(prompt) {
		t.Error("system prompt must not instruct chain-of-thought disclosure")
	}
}

func TestPlanModeReminderContracts(t *testing.T) {
	path := "/project/plans/$&-$`-$'.md"
	full := BuildPlanModeReminder(path, true, 1)
	if len(full) >= 1800 {
		t.Errorf("full plan reminder length = %d, want < 1800", len(full))
	}
	for _, text := range []string{path, "plan file already exists"} {
		if !strings.Contains(full, text) {
			t.Errorf("full plan reminder must contain %q", text)
		}
	}
	if got := BuildPlanModeReminder(path, false, 1); !strings.Contains(got, "No plan file exists") {
		t.Error("missing-plan reminder must say No plan file exists")
	}
	// Five-iteration cadence: 1, 6, 11 are identical full reminders.
	if got := BuildPlanModeReminder(path, true, 6); got != full {
		t.Error("iteration 6 must equal the iteration 1 reminder")
	}
	if got := BuildPlanModeReminder(path, true, 11); got != full {
		t.Error("iteration 11 must equal the iteration 1 reminder")
	}
	for _, turn := range []int{2, 3, 4, 5, 7} {
		sparse := BuildPlanModeReminder(path, true, turn)
		if len(sparse) >= len(full) {
			t.Errorf("sparse reminder (turn %d) must be shorter than the full one", turn)
		}
		for _, text := range []string{path, "Read-only except", "ExitPlanMode", "runtime approval gate"} {
			if !strings.Contains(sparse, text) {
				t.Errorf("sparse reminder (turn %d) must contain %q", turn, text)
			}
		}
	}
	for _, text := range []string{"## Context", "## Approach", "Verification", "at most 3", "only when useful"} {
		if !strings.Contains(full, text) {
			t.Errorf("full plan reminder must contain %q", text)
		}
	}
	banned := regexp.MustCompile(`Call the Agent tool|MUST.*Agent|5-phase`)
	if banned.MatchString(full) {
		t.Error("plan reminder must not mandate the Agent tool or a 5-phase flow")
	}

	if got := BuildPlanModeReentryReminder(path, false); got != "" {
		t.Errorf("reentry reminder without a plan must be empty, got %q", got)
	}
	reentry := BuildPlanModeReentryReminder(path, true)
	for _, text := range []string{path, "read-only except"} {
		if !strings.Contains(reentry, text) {
			t.Errorf("reentry reminder must contain %q", text)
		}
	}

	if got := BuildPlanModeExitReminder(path, true); !strings.Contains(got, path) || !strings.Contains(got, "current permissions") {
		t.Error("exit reminder with a plan must mention the path and current permissions")
	}
	if got := BuildPlanModeExitReminder(path, false); strings.Contains(got, path) {
		t.Error("exit reminder without a plan must not mention the path")
	}
}

func TestCoordinatorReminderContracts(t *testing.T) {
	full := CoordinatorReminder(0)
	if len(full) >= 3000 {
		t.Errorf("coordinator reminder length = %d, want < 3000", len(full))
	}
	if got := CoordinatorReminder(6); got != full {
		t.Error("iteration 6 must equal the iteration 0 reminder")
	}
	if got := CoordinatorReminder(11); got != full {
		t.Error("iteration 11 must equal the iteration 0 reminder")
	}
	for _, text := range []string{
		"return inline by default",
		"run_in_background=true",
		"task ID immediately",
		"task notification",
		"TeamCreate",
		"team_name",
		"create the team on demand",
		"SendMessage",
		"<task-notification>",
		"from=",
		"not new user authorization",
		"one writer per shared file",
		"Never poll one worker through another agent",
		"Never fabricate or predict results",
		"Never require unsolicited commits or pushes",
		"observed evidence",
	} {
		if !strings.Contains(full, text) {
			t.Errorf("coordinator reminder must contain %q", text)
		}
	}
	banned := regexp.MustCompile(`Workers are async|Verification MUST|Commit and report the hash`)
	if banned.MatchString(full) {
		t.Error("coordinator reminder must not carry the retired mandates")
	}
	for _, turn := range []int{2, 3, 4, 5} {
		sparse := CoordinatorReminder(turn)
		if len(sparse) >= len(full) {
			t.Errorf("sparse coordinator reminder (turn %d) must be shorter", turn)
		}
		for _, text := range []string{"return inline", "task-notification", "from=", "unsolicited commits/pushes"} {
			if !strings.Contains(sparse, text) {
				t.Errorf("sparse coordinator reminder (turn %d) must contain %q", turn, text)
			}
		}
	}
}
