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

package skills

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

func TestLoadFromDirectory(t *testing.T) {
	dir := t.TempDir()

	skillDir := filepath.Join(dir, "test-skill")
	os.MkdirAll(skillDir, 0o755)
	os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(`---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

Do the thing.
`), 0o644)

	catalog, err := LoadFromDirectory(dir)
	if err != nil {
		t.Fatalf("LoadFromDirectory failed: %v", err)
	}

	metas := catalog.List()
	if len(metas) != 1 {
		t.Fatalf("expected 1 skill, got %d", len(metas))
	}
	if metas[0].Name != "test-skill" {
		t.Fatalf("expected name 'test-skill', got '%s'", metas[0].Name)
	}

	skill := catalog.Get("test-skill")
	if skill == nil {
		t.Fatal("Get returned nil")
	}
	if skill.PromptBody == "" {
		t.Fatal("PromptBody is empty")
	}
	t.Logf("Skill body: %s", skill.PromptBody)
}

func TestLoadAgentsSkills(t *testing.T) {
	wd, _ := os.Getwd()
	// Walk up to find project root
	for wd != "/" {
		if _, err := os.Stat(filepath.Join(wd, ".agents", "skills")); err == nil {
			break
		}
		wd = filepath.Dir(wd)
	}

	skillsDir := filepath.Join(wd, ".agents", "skills")
	if _, err := os.Stat(skillsDir); os.IsNotExist(err) {
		t.Skip("No .agents/skills directory found")
	}

	catalog, err := LoadFromDirectory(skillsDir)
	if err != nil {
		t.Fatalf("Failed to load skills: %v", err)
	}

	metas := catalog.List()
	t.Logf("Loaded %d skill(s) from %s", len(metas), skillsDir)
	for _, m := range metas {
		t.Logf("  - %s: %s", m.Name, m.Description)
		s := catalog.Get(m.Name)
		if s != nil {
			t.Logf("    Body: %d chars", len(s.PromptBody))
		}
	}

	if len(metas) == 0 {
		t.Fatal("Expected at least 1 skill")
	}
}

func TestBuildSkillPromptSubstitutesArguments(t *testing.T) {
	s := &Skill{
		Meta:       SkillMeta{Name: "greet"},
		PromptBody: "Greet $ARGUMENTS warmly.",
	}
	got := BuildSkillPrompt(s, "Alice")
	if !strings.Contains(got, "<skill-body>\nGreet Alice warmly.\n</skill-body>") {
		t.Errorf("placeholder substitution failed: %q", got)
	}
	if !strings.Contains(got, "<skill-arguments>Alice</skill-arguments>") {
		t.Errorf("arguments tag missing: %q", got)
	}
}

// TS has no "## User Request" fallback: without a $ARGUMENTS placeholder the
// args only appear in the <skill-arguments> envelope (executor.ts:30-40).
func TestBuildSkillPromptNoUserRequestSection(t *testing.T) {
	s := &Skill{Meta: SkillMeta{Name: "x"}, PromptBody: "Plain body."}
	got := BuildSkillPrompt(s, "extra args")
	if strings.Contains(got, "## User Request") {
		t.Errorf("unexpected '## User Request' section: %q", got)
	}
	if !strings.Contains(got, "<skill-body>\nPlain body.\n</skill-body>") {
		t.Errorf("body missing: %q", got)
	}
	if !strings.Contains(got, "<skill-arguments>extra args</skill-arguments>") {
		t.Errorf("args missing: %q", got)
	}
}

func TestBuildSkillPromptNoArgsOmitsArgumentsTag(t *testing.T) {
	s := &Skill{Meta: SkillMeta{Name: "x"}, PromptBody: "just the body"}
	got := BuildSkillPrompt(s, "")
	if strings.Contains(got, "<skill-arguments>") {
		t.Errorf("empty args must omit the arguments tag: %q", got)
	}
	if !strings.Contains(got, "<skill-body>\njust the body\n</skill-body>") {
		t.Errorf("body missing: %q", got)
	}
}

func TestLoadSkillsMergesPriority(t *testing.T) {
	work := t.TempDir()
	agentsDir := filepath.Join(work, ".agents", "skills", "shared")
	if err := os.MkdirAll(agentsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(agentsDir, "SKILL.md"), []byte(`---
name: shared
description: project skill from .agents
---
agents body`), 0o644)

	catalog := LoadSkills(work)
	got := catalog.Get("shared")
	if got == nil {
		t.Fatal("merged catalog missing 'shared'")
	}
	if !strings.Contains(got.PromptBody, "agents body") {
		t.Errorf("expected agents body; got body=%q", got.PromptBody)
	}
}

func TestLoadSkillsForkMode(t *testing.T) {
	dir := t.TempDir()
	skillDir := filepath.Join(dir, ".agents", "skills", "reviewer")
	os.MkdirAll(skillDir, 0o755)
	os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(`---
name: reviewer
description: skill that runs in fork mode
mode: fork
fork_context: recent
---
body`), 0o644)

	catalog := LoadSkills(dir)
	s := catalog.Get("reviewer")
	if s == nil {
		t.Fatal("skill not loaded")
	}
	if !s.Meta.IsFork() {
		t.Errorf("expected fork mode")
	}
	if s.Meta.ForkContext != "recent" {
		t.Errorf("ForkContext = %q, want recent", s.Meta.ForkContext)
	}
}

// The prompt envelope depends only on the body and the arguments, not on the
// mode: a fork skill receives the exact same envelope, and isolated execution
// is the caller's responsibility.
func TestBuildSkillPromptIgnoresMode(t *testing.T) {
	forked := &Skill{
		Meta:       SkillMeta{Name: "audit-deps", Mode: "fork"},
		PromptBody: "Inspect go.mod and flag risky pins.",
	}
	if got := BuildSkillPrompt(forked, ""); !strings.Contains(got, "<skill-body>\nInspect go.mod and flag risky pins.\n</skill-body>") {
		t.Errorf("fork skill prompt = %q, want the raw body in the envelope", got)
	}

	inline := &Skill{
		Meta:       SkillMeta{Name: "audit-deps", Mode: "inline"},
		PromptBody: "Inspect go.mod and flag risky pins.",
	}
	if BuildSkillPrompt(forked, "") != BuildSkillPrompt(inline, "") {
		t.Error("mode must not change the prompt envelope")
	}
}

func TestLoadSkillsContextFork(t *testing.T) {
	dir := t.TempDir()
	skillDir := filepath.Join(dir, ".agents", "skills", "forky")
	os.MkdirAll(skillDir, 0o755)
	os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(`---
name: forky
description: skill that runs in a subagent
context: fork
---
body content`), 0o644)

	catalog := LoadSkills(dir)
	s := catalog.Get("forky")
	if s == nil {
		t.Fatal("skill not loaded")
	}
	// Legacy `context: fork` resolves to Mode == "fork" (TS resolveMode).
	if s.Meta.Mode != "fork" || !s.Meta.IsFork() {
		t.Errorf("context: fork must resolve to fork mode, got Mode=%q", s.Meta.Mode)
	}
}

func TestSkillIntegration(t *testing.T) {
	dir := t.TempDir()

	// Create two skills
	s1Dir := filepath.Join(dir, "greeting")
	os.MkdirAll(s1Dir, 0o755)
	os.WriteFile(filepath.Join(s1Dir, "SKILL.md"), []byte(`---
name: greeting
description: Generate a friendly greeting message
---

# Greeting Skill

Say hello to the user in a friendly way.
`), 0o644)

	s2Dir := filepath.Join(dir, "summarize")
	os.MkdirAll(s2Dir, 0o755)
	os.WriteFile(filepath.Join(s2Dir, "SKILL.md"), []byte(`---
name: summarize
description: Summarize text content concisely
---

# Summarize Skill

Provide a concise summary of the given text.
`), 0o644)

	catalog, err := LoadFromDirectory(dir)
	if err != nil {
		t.Fatalf("LoadFromDirectory failed: %v", err)
	}

	metas := catalog.List()
	if len(metas) != 2 {
		t.Fatalf("expected 2 skills, got %d", len(metas))
	}

	// Verify both skills are retrievable
	for _, name := range []string{"greeting", "summarize"} {
		s := catalog.Get(name)
		if s == nil {
			t.Fatalf("skill %q not found", name)
		}
		if s.PromptBody == "" {
			t.Fatalf("skill %q has empty body", name)
		}
		if s.SourceDir == "" {
			t.Fatalf("skill %q has empty SourceDir", name)
		}
	}

	// System-prompt section (TS: buildSkillSection, catalog.ts:302-329).
	section := BuildSkillSection(catalog, dir)
	for _, want := range []string{
		"## Skills",
		"<skills-directory>" + EscapeSkillXml(filepath.Join(dir, ".agents", "skills")) + "</skills-directory>",
		"<available-skills>",
		"<skill><name>greeting</name><description>Generate a friendly greeting message</description><mode>inline</mode></skill>",
		"<skill><name>summarize</name><description>Summarize text content concisely</description><mode>inline</mode></skill>",
		"</available-skills>",
	} {
		if !strings.Contains(section, want) {
			t.Errorf("skill section missing %q:\n%s", want, section)
		}
	}

	// Simulate the slash-command handler (TS: runInline, executor.ts:69-74).
	host := newStubHost(tools.NewRegistry())
	skill := catalog.Get("greeting")
	prompt, err := RunInline(context.Background(), skill, "say hi to Alice", host)
	if err != nil {
		t.Fatalf("RunInline: %v", err)
	}
	if !strings.Contains(prompt, "Greeting Skill") {
		t.Fatal("envelope missing skill body")
	}
	if !strings.Contains(prompt, "<skill-arguments>say hi to Alice</skill-arguments>") {
		t.Fatal("envelope missing user arguments")
	}
	if strings.Contains(prompt, "## User Request") {
		t.Fatal("TS envelope has no '## User Request' section")
	}
	if host.activated["greeting"] != prompt {
		t.Fatal("activation was not recorded with the envelope")
	}

	t.Logf("Skill section:\n%s", section)
	t.Logf("Handler output (with args):\n%s", prompt)
}
