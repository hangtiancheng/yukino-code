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
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

var log = logger.CreateChildLogger("prompt")

// mapPlatform maps a Go GOOS value onto the value Node's os.platform()
// reports on the same machine, so the Environment section matches the TS
// output byte for byte (e.g. "win32" instead of "windows").
func mapPlatform(goos string) string {
	switch goos {
	case "windows":
		return "win32"
	case "solaris":
		return "sunos"
	case "ios":
		return "darwin"
	default:
		return goos
	}
}

// mapArch maps a Go GOARCH value onto the value Node's os.arch() reports on
// the same machine (e.g. "x64" instead of "amd64", "ia32" instead of "386").
func mapArch(goarch string) string {
	switch goarch {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	case "mipsle":
		return "mipsel"
	default:
		return goarch
	}
}

type Section struct {
	Name     string
	Priority int
	Content  string
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
	sorted := make([]Section, len(b.sections))
	copy(sorted, b.sections)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].Priority < sorted[j].Priority
	})

	var parts []string
	seen := make(map[string]bool)
	for _, s := range sorted {
		content := strings.TrimSpace(s.Content)
		if content == "" || seen[content] {
			continue
		}
		seen[content] = true
		parts = append(parts, content)
	}
	return strings.Join(parts, "\n\n")
}

func DetectEnvironment(workDir string) EnvironmentContext {
	env := EnvironmentContext{
		WorkDir: workDir,
		OS:      mapPlatform(runtime.GOOS),
		Arch:    mapArch(runtime.GOARCH),
		Shell:   os.Getenv("SHELL"),
		// TS: new Date().toISOString().split("T")[0] — the UTC date.
		Date: time.Now().UTC().Format("2006-01-02"),
	}

	if env.Shell == "" {
		env.Shell = "bash"
	}

	// Mirrors the TS try/catch: any git failure is logged and leaves the
	// environment marked as a non-repository.
	if out, err := exec.Command("git", "-C", workDir, "rev-parse", "--is-inside-work-tree").Output(); err != nil {
		log.Error("prompt operation failed", "err", err)
	} else if strings.TrimSpace(string(out)) == "true" {
		env.IsGitRepo = true
		branch, err := exec.Command("git", "-C", workDir, "rev-parse", "--abbrev-ref", "HEAD").Output()
		if err != nil {
			log.Error("prompt operation failed", "err", err)
		} else {
			env.GitBranch = strings.TrimSpace(string(branch))
		}
	}

	return env
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
