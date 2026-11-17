package prompt

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type Section struct {
	Name    string
	Content string
}

type EnvironmentContext struct {
	WorkDir   string
	OS        string
	Arch      string
	Shell     string
	IsGitRepo bool
	GitBranch string
	Model     string
	Date      string
}

type Builder struct {
	sections []Section
}

func NewBuilder() *Builder {
	return &Builder{}
}

func (b *Builder) Add(s Section) *Builder {
	b.sections = append(b.sections, s)
	return b
}

func (b *Builder) Build() string {

	var parts []string
	seen := map[string]bool{}
	for _, s := range b.sections {
		content := strings.TrimSpace(s.Content)
		if content != "" && !seen[content] {
			seen[content] = true
			parts = append(parts, content)
		}
	}
	return strings.Join(parts, "\n\n")
}

func DetectEnvironment(workDir string) EnvironmentContext {
	env := EnvironmentContext{
		WorkDir: workDir,
		OS:      runtime.GOOS,
		Arch:    runtime.GOARCH,
		Shell:   os.Getenv("SHELL"),
		Date:    time.Now().UTC().Format("2006-01-02"),
	}

	if _, set := os.LookupEnv("SHELL"); !set {
		env.Shell = "bash"
	}

	if gitProbe(workDir, "rev-parse", "--is-inside-work-tree") == "true" {
		env.IsGitRepo = true
		branch := []rune(gitProbe(workDir, "rev-parse", "--abbrev-ref", "HEAD"))
		env.GitBranch = string(branch[:min(len(branch), 256)])
	}

	switch env.Arch {
	case "amd64":
		env.Arch = "x64"
	case "386":
		env.Arch = "ia32"
	}
	return env
}

func gitProbe(cwd string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func BuildSystemPrompt(env EnvironmentContext) string {
	b := NewBuilder()

	b.Add(IdentitySection())
	b.Add(SystemSection())
	b.Add(DoingTasksSection())
	b.Add(ExecutingActionsSection())
	b.Add(UsingToolsSection())
	b.Add(ToneStyleSection())
	b.Add(OutputEfficiencySection())
	b.Add(EnvironmentSection(env))

	return b.Build()
}
