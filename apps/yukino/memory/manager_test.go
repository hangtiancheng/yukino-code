package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeMemoryFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestManagerBuildSystemReminderAndIndex(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	projectDir := GetAutoMemPath(cwd)
	writeMemoryFile(t, projectDir, "beta.md", "---\nname: beta\ndescription: second\ntype: project\n---\nbody")
	writeMemoryFile(t, projectDir, "alpha.md", "---\nname: alpha\ndescription: first\nmetadata:\n  type: user\n---\nbody")
	writeMemoryFile(t, projectDir, MemoryIndexName, "stale index")

	mgr := NewManager(cwd, nil)
	reminder := mgr.BuildSystemReminder()
	want := "Active memories:\n- [alpha] (user): first\n- [beta] (project): second"
	if reminder != want {
		t.Fatalf("BuildSystemReminder() = %q, want %q", reminder, want)
	}

	index, err := os.ReadFile(filepath.Join(projectDir, MemoryIndexName))
	if err != nil {
		t.Fatal(err)
	}
	wantIndex := "- [alpha](alpha.md) — first\n- [beta](beta.md) — second\n"
	if string(index) != wantIndex {
		t.Fatalf("index = %q, want %q", index, wantIndex)
	}
}

func TestManagerBuildSystemReminderEmpty(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(t.TempDir(), nil)
	if got := mgr.BuildSystemReminder(); got != "" {
		t.Fatalf("BuildSystemReminder() = %q, want empty", got)
	}
}

func TestManagerClear(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	projectDir := GetAutoMemPath(cwd)
	writeMemoryFile(t, projectDir, "topic.md", "---\nname: topic\n---\nbody")
	writeMemoryFile(t, projectDir, MemoryIndexName, "index")

	mgr := NewManager(cwd, nil)
	mgr.Clear()
	entries, err := os.ReadDir(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("Clear left %d entries", len(entries))
	}
}

func TestManagerSkipsMalformedFrontmatter(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	writeMemoryFile(t, GetAutoMemPath(cwd), "broken.md", "---\nname: [unclosed\n---\nbody")
	writeMemoryFile(t, GetAutoMemPath(cwd), "missing-close.md", "---\nname: x\nbody")
	writeMemoryFile(t, GetAutoMemPath(cwd), "ok.md", "---\nname: ok\n---\nbody")

	mgr := NewManager(cwd, nil)
	memories := mgr.GetMemories()
	if len(memories) != 1 || memories[0].Name != "ok" {
		t.Fatalf("GetMemories() = %+v, want only ok", memories)
	}
}

func TestParseFrontmatter(t *testing.T) {
	parsed, err := ParseFrontmatter("---\nname: n\ndescription: d\nmetadata:\n  type: feedback\n---\n\nbody\n")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Name != "n" || parsed.Description != "d" || parsed.Type != "feedback" || parsed.Body != "body" {
		t.Fatalf("parsed = %+v", parsed)
	}
	if _, err := ParseFrontmatter("---\nname: x\n"); err == nil {
		t.Fatal("unclosed frontmatter must error")
	}
	parsed, err = ParseFrontmatter("plain body")
	if err != nil || parsed.Body != "plain body" || parsed.Type != "" {
		t.Fatalf("plain = %+v, err = %v", parsed, err)
	}
}

func TestCapEntrypoint(t *testing.T) {
	line := strings.Repeat("a", 99) + "\n"
	content := strings.Repeat(line, MaxEntrypointBytes/100+10)
	got := capEntrypoint(content)
	if len(got) > MaxEntrypointBytes {
		t.Fatalf("len(capEntrypoint) = %d, want <= %d", len(got), MaxEntrypointBytes)
	}
	if strings.HasSuffix(got, "\n") || strings.HasSuffix(got, "a") == false {
		t.Fatalf("capEntrypoint should cut at a newline: %q", got[len(got)-5:])
	}
}

func TestGetAutoMemPath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	dir := GetAutoMemPath(cwd)
	if dir == "" || filepath.Base(dir) != MemoryDirName {
		t.Fatalf("GetAutoMemPath = %q", dir)
	}
	if filepath.Clean(dir) != dir {
		t.Fatalf("path must be clean: %q", dir)
	}
	if !IsAutoMemPath(filepath.Join(dir, "x.md"), cwd) {
		t.Fatal("IsAutoMemPath should accept a memory file")
	}
}
