package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSkill(t *testing.T, dir, name, content string) string {
	t.Helper()
	skillDir := filepath.Join(dir, name)
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(skillDir, SkillFileName)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestParseSkillFile(t *testing.T) {
	skill, _, ok := ParseSkillFile("---\nname: commit\ndescription: make commits\nmode: fork\nmodel: haiku\nfork_context: recent\n---\n\nBody text\n")
	if !ok {
		t.Fatal("expected valid skill")
	}
	if skill.Meta.Name != "commit" || skill.Meta.Description != "make commits" || skill.Meta.Mode != "fork" || skill.Meta.Model != "haiku" || skill.Meta.ForkContext != "recent" {
		t.Fatalf("meta = %+v", skill.Meta)
	}
	if skill.Body != "Body text" {
		t.Fatalf("body = %q", skill.Body)
	}

	contextSkill, _, ok := ParseSkillFile("---\nname: x\ncontext: fork\n---\nbody")
	if !ok || contextSkill.Meta.Mode != "fork" {
		t.Fatalf("context: fork should resolve to fork mode: %+v ok=%v", contextSkill.Meta, ok)
	}

	for _, content := range []string{
		"no frontmatter",
		"---\ndescription: no name\n---\nbody",
		"---\nname: \"\"\n---\nbody",
		"---\nname: x\nmode: bogus\n---\nbody",
		"---\nname: x\nfork_context: bogus\n---\nbody",
	} {
		if _, _, ok := ParseSkillFile(content); ok {
			t.Errorf("expected invalid skill for %q", content)
		}
	}
}

func TestCatalogScansAndOverrides(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := t.TempDir()

	writeSkill(t, filepath.Join(home, AgentsDirName, SkillsDirName), "shared", "---\nname: shared\ndescription: user\n---\nuser body")
	writeSkill(t, filepath.Join(home, ".yukino", SkillsDirName), "yukino-skill", "---\nname: yukino-skill\n---\nbody")
	writeSkill(t, filepath.Join(cwd, AgentsDirName, SkillsDirName), "shared", "---\nname: shared\ndescription: project\n---\nproject body")
	writeSkill(t, filepath.Join(cwd, AgentsDirName, SkillsDirName), "nested", "---\nname: nested\n---\nbody")

	catalog := LoadCatalog(cwd)
	metas := catalog.List()
	if len(metas) != 3 {
		t.Fatalf("List() = %+v, want 3 skills", metas)
	}
	shared := catalog.Get("shared")
	if shared == nil || shared.Body != "project body" {
		t.Fatalf("project skill should override user skill: %+v", shared)
	}
	if catalog.Get("yukino-skill") == nil || catalog.Get("nested") == nil {
		t.Fatal("missing scanned skills")
	}
}

func TestCatalogSkipsDotDirectoriesWithoutSkill(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	dir := filepath.Join(cwd, AgentsDirName, SkillsDirName)
	if err := os.MkdirAll(filepath.Join(dir, ".hidden"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".hidden", "SKILL.md"), []byte("---\nname: hidden\n---\nbody"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeSkill(t, dir, "visible", "---\nname: visible\n---\nbody")
	catalog := LoadCatalog(cwd)
	if !catalog.Has("hidden") || !catalog.Has("visible") {
		t.Fatalf("expected both skills, got %+v", catalog.List())
	}
}

func TestCatalogHotReload(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	path := writeSkill(t, filepath.Join(cwd, AgentsDirName, SkillsDirName), "hot", "---\nname: hot\n---\nfirst")
	catalog := LoadCatalog(cwd)
	if catalog.Get("hot").Body != "first" {
		t.Fatal("initial body")
	}
	differentMtime := time.Now().Add(2 * time.Minute)
	if err := os.WriteFile(path, []byte("---\nname: hot\n---\nsecond"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, differentMtime, differentMtime); err != nil {
		t.Fatal(err)
	}
	if body := catalog.Get("hot").Body; body != "second" {
		t.Fatalf("hot reload body = %q, want second", body)
	}
}

func TestSkillPromptRoundTrip(t *testing.T) {
	skill := &Skill{Meta: SkillMeta{Name: "a&b"}, Body: "Use $ARGUMENTS here", SourceDir: "/tmp/<dir>"}
	prompt := BuildSkillPrompt(skill, "x < y & z")
	parsed, ok := ParseSkillPrompt(prompt)
	if !ok {
		t.Fatal("ParseSkillPrompt failed")
	}
	if parsed.Name != "a&b" || parsed.Directory != "/tmp/<dir>" || parsed.Body != "Use x < y & z here" || parsed.Args != "x < y & z" {
		t.Fatalf("parsed = %+v", parsed)
	}
}

func TestBuildSkillSection(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	writeSkill(t, filepath.Join(cwd, AgentsDirName, SkillsDirName), "one", "---\nname: one\ndescription: first skill\n---\nbody")
	catalog := LoadCatalog(cwd)
	section := BuildSkillSection(catalog)
	if !strings.Contains(section, "<skill><name>one</name><description>first skill</description><mode>inline</mode></skill>") {
		t.Fatalf("section = %q", section)
	}
	if !strings.Contains(section, "<skills-directory>") {
		t.Fatalf("section missing skills directory: %q", section)
	}
}
