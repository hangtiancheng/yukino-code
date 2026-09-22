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
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSkillDir(t *testing.T, root, name, frontmatter, body string) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := "---\n" + frontmatter + "\n---\n\n" + body
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}
	return dir
}

func TestLoadCatalogPhase1EmptyBody(t *testing.T) {
	work := t.TempDir()
	writeSkillDir(t, filepath.Join(work, ".agents", "skills"), "demo",
		"name: demo\ndescription: a phase-1 demo\nmode: inline",
		"# Body\n\nFull SOP here.")

	cat := LoadCatalog(work)
	skill := cat.Get("demo")
	if skill == nil {
		t.Fatal("expected demo skill in phase-1 catalog")
	}
	if skill.PromptBody != "" {
		t.Errorf("phase-1 must NOT load body; got %d chars", len(skill.PromptBody))
	}
	if skill.BodyLoaded {
		t.Errorf("BodyLoaded must be false in phase-1")
	}
	if skill.Meta.Description != "a phase-1 demo" {
		t.Errorf("frontmatter not parsed: %q", skill.Meta.Description)
	}
}

func TestCatalogGetFullHotReload(t *testing.T) {
	work := t.TempDir()
	dir := writeSkillDir(t, filepath.Join(work, ".agents", "skills"), "hot",
		"name: hot\ndescription: hot reload demo",
		"version 1")

	cat := LoadCatalog(work)
	skill, err := cat.GetFull("hot")
	if err != nil {
		t.Fatalf("GetFull v1: %v", err)
	}
	if !strings.Contains(skill.PromptBody, "version 1") {
		t.Errorf("v1 body mismatch: %q", skill.PromptBody)
	}

	// Overwrite source file — GetFull must re-read.
	updated := "---\nname: hot\ndescription: hot reload demo\n---\n\nversion 2"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(updated), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	skill2, err := cat.GetFull("hot")
	if err != nil {
		t.Fatalf("GetFull v2: %v", err)
	}
	if !strings.Contains(skill2.PromptBody, "version 2") {
		t.Errorf("hot reload didn't pick up v2: %q", skill2.PromptBody)
	}
}

func TestCatalogNeedsReload(t *testing.T) {
	work := t.TempDir()
	skillsDir := filepath.Join(work, ".agents", "skills")
	writeSkillDir(t, skillsDir, "alpha",
		"name: alpha\ndescription: first skill", "body alpha")

	cat := LoadCatalog(work)
	if cat.NeedsReload() {
		t.Error("NeedsReload should be false right after LoadCatalog")
	}

	// Ensure filesystem tick so modtime differs (ext4 can have 1s granularity).
	time.Sleep(10 * time.Millisecond)

	// Add a new skill directory — parent modtime changes.
	writeSkillDir(t, skillsDir, "beta",
		"name: beta\ndescription: second skill", "body beta")

	if !cat.NeedsReload() {
		t.Error("NeedsReload should be true after adding a new skill dir")
	}

	// After reload, NeedsReload resets.
	cat.Reload(work)
	if cat.NeedsReload() {
		t.Error("NeedsReload should be false after Reload")
	}
	if cat.Get("beta") == nil {
		t.Error("beta should be in catalog after Reload")
	}
}

func TestLoadCatalogNoBuiltins(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	cat := LoadCatalog(t.TempDir())
	if len(cat.List()) != 0 {
		t.Errorf("expected empty catalog with no disk skills, got %d", len(cat.List()))
	}
}

func TestEscapeSkillXml(t *testing.T) {
	if got := EscapeSkillXml(`a & b < c > d`); got != "a &amp; b &lt; c &gt; d" {
		t.Errorf("EscapeSkillXml = %q", got)
	}
}

func TestBuildSkillSectionFormat(t *testing.T) {
	work := t.TempDir()
	writeSkillDir(t, filepath.Join(work, ".agents", "skills"), "demo",
		"name: demo\ndescription: line one\n  indented continuation",
		"body")

	cat := LoadCatalog(work)
	section := BuildSkillSection(cat, work)
	for _, want := range []string{
		"## Skills",
		`Load relevant instructions with LoadSkill {name: "<skill-name>"}`,
		`InstallSkill {source: "<local path or raw SKILL.md URL>"}`,
		"Create skills under the following directory as <skill-name>/SKILL.md:",
		"<skills-directory>" + EscapeSkillXml(filepath.Join(work, ".agents", "skills")) + "</skills-directory>",
		"<available-skills>",
		// Whitespace in the description is collapsed to single spaces.
		"<skill><name>demo</name><description>line one indented continuation</description><mode>inline</mode></skill>",
		"</available-skills>",
	} {
		if !strings.Contains(section, want) {
			t.Errorf("section missing %q:\n%s", want, section)
		}
	}
}

func TestBuildSkillSectionEmpty(t *testing.T) {
	if got := BuildSkillSection(NewCatalog(), t.TempDir()); got != "" {
		t.Errorf("empty catalog must render empty section, got %q", got)
	}
	if got := BuildSkillSection(nil, t.TempDir()); got != "" {
		t.Errorf("nil catalog must render empty section, got %q", got)
	}
}

func TestBuildSkillSectionTruncatesDescription(t *testing.T) {
	cat := NewCatalog()
	cat.Register(&Skill{
		Meta: SkillMeta{Name: "long", Description: strings.Repeat("a", 250), Mode: "inline"},
	}, "test")

	section := BuildSkillSection(cat, "/wd")
	if !strings.Contains(section, strings.Repeat("a", 200)+"…") {
		t.Errorf("description not truncated at 200 chars with ellipsis:\n%s", section)
	}
	if strings.Contains(section, strings.Repeat("a", 201)) {
		t.Errorf("description longer than 200 chars leaked:\n%s", section)
	}
}

// BuildSkillSection must preserve catalog load order, matching TS
// catalog.list() (Map insertion order): an alphabetical sort would make the
// assembled section differ from the TS bytes.
func TestBuildSkillSectionPreservesLoadOrder(t *testing.T) {
	cat := NewCatalog()
	for _, n := range []string{"zeta", "alpha", "mid"} {
		cat.Register(&Skill{Meta: SkillMeta{Name: n, Description: n, Mode: "inline"}}, "test")
	}
	section := BuildSkillSection(cat, "/wd")
	z := strings.Index(section, "<name>zeta</name>")
	a := strings.Index(section, "<name>alpha</name>")
	m := strings.Index(section, "<name>mid</name>")
	if z < 0 || a < 0 || m < 0 || !(z < a && a < m) {
		t.Errorf("skills not in load order (zeta, alpha, mid):\n%s", section)
	}
}
