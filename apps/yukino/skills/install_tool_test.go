package skills

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallSkillFromLocalFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := t.TempDir()
	source := filepath.Join(cwd, "source.md")
	if err := os.WriteFile(source, []byte("---\nname: local\ndescription: local skill\n---\nbody"), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := NewCatalog()
	installed := false
	tool := &InstallSkillTool{Cwd: cwd, Catalog: catalog, OnInstalled: func() { installed = true }}
	result := tool.Execute(context.Background(), map[string]any{"source": "source.md"})
	if result.IsError {
		t.Fatalf("install failed: %s", result.Output)
	}
	destination := filepath.Join(home, ".yukino", SkillsDirName, "local", SkillFileName)
	if _, err := os.Stat(destination); err != nil {
		t.Fatalf("destination missing: %v", err)
	}
	if !installed {
		t.Fatal("OnInstalled not called")
	}
	if !strings.Contains(result.Output, destination) {
		t.Fatalf("output = %q", result.Output)
	}
}

func TestInstallSkillNameOverride(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := t.TempDir()
	source := filepath.Join(cwd, "source.md")
	if err := os.WriteFile(source, []byte("---\nname: original\ndescription: d\n---\nbody"), 0o600); err != nil {
		t.Fatal(err)
	}
	tool := &InstallSkillTool{Cwd: cwd, Catalog: NewCatalog()}
	result := tool.Execute(context.Background(), map[string]any{"source": "source.md", "name": "renamed"})
	if result.IsError {
		t.Fatalf("install failed: %s", result.Output)
	}
	data, err := os.ReadFile(filepath.Join(home, ".yukino", SkillsDirName, "renamed", SkillFileName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "name: renamed") {
		t.Fatalf("frontmatter not renamed: %q", data)
	}
}

func TestInstallSkillValidation(t *testing.T) {
	cwd := t.TempDir()
	tool := &InstallSkillTool{Cwd: cwd, Catalog: NewCatalog()}
	if got := tool.Execute(context.Background(), map[string]any{}); !got.IsError || got.Output != SourceRequiredError {
		t.Fatalf("missing source = %+v", got)
	}
	if err := os.WriteFile(filepath.Join(cwd, "bad.md"), []byte("no frontmatter"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tool.Execute(context.Background(), map[string]any{"source": "bad.md"}); !got.IsError || got.Output != InvalidSkillSourceError {
		t.Fatalf("invalid source = %+v", got)
	}
	if err := os.WriteFile(filepath.Join(cwd, "ok.md"), []byte("---\nname: ok\n---\nbody"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tool.Execute(context.Background(), map[string]any{"source": "ok.md", "name": "bad name"}); !got.IsError || got.Output != InvalidSkillNameError {
		t.Fatalf("invalid name = %+v", got)
	}
}
