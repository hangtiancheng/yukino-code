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

package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// isolateHome redirects the user-level memory directory to a temporary directory.
// os.UserHomeDir reads USERPROFILE on Windows and HOME on Unix-like systems; both
// must be set, otherwise tests would fall through to the real ~/.yukino/memory and
// interfere with other parallel tests.
func isolateHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
}

func TestGetAutoMemPath(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	projectRoot := filepath.Join(t.TempDir(), "project")
	os.MkdirAll(projectRoot, 0o755)
	path := GetAutoMemPath(projectRoot)
	wantSuffix := filepath.Join(".yukino", "memory") + string(filepath.Separator)
	if !strings.HasSuffix(path, wantSuffix) {
		t.Errorf("expected suffix %q, got: %s", wantSuffix, path)
	}
	absRoot, _ := filepath.Abs(projectRoot)
	if !strings.HasPrefix(path, absRoot) {
		t.Errorf("expected path under project root %s, got: %s", absRoot, path)
	}
}

func TestGetAutoMemPathRespectsOverride(t *testing.T) {
	overrideDir := filepath.Join(t.TempDir(), "custom", "memdir")
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", overrideDir)
	path := GetAutoMemPath(filepath.Join(t.TempDir(), "anything"))
	expected := overrideDir + string(filepath.Separator)
	if path != expected {
		t.Errorf("override not honored: got %q, want %q", path, expected)
	}
}

func TestIsAutoMemPath(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	root := "/tmp/p"
	dir := GetAutoMemPath(root)
	cases := map[string]bool{
		dir + "MEMORY.md":         true,
		dir + "foo.md":            true,
		dir + "sub/foo.md":        true,
		"/tmp/p/.yukino/memory-x": false,
		"/other/path/foo.md":      false,
	}
	for path, want := range cases {
		if got := IsAutoMemPath(path, root); got != want {
			t.Errorf("IsAutoMemPath(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestCapEntrypoint(t *testing.T) {
	t.Run("under limit unchanged", func(t *testing.T) {
		raw := "- one\n- two\n- three"
		if got := capEntrypoint(raw); got != raw {
			t.Errorf("content modified: %q", got)
		}
	})

	t.Run("cuts at last newline before limit", func(t *testing.T) {
		raw := strings.Repeat("xxxxxxxxxx", MaxEntrypointBytes/5) + "\nextra"
		got := capEntrypoint(raw)
		if len(got) > MaxEntrypointBytes {
			t.Errorf("result exceeds byte cap: %d", len(got))
		}
		if strings.Contains(got, "extra") {
			t.Errorf("content past the last newline before the cap should be dropped: %q", got)
		}
		if !strings.HasSuffix(got, strings.Repeat("x", 10)) {
			t.Errorf("should end at the last complete line: %q", got[len(got)-20:])
		}
	})

	t.Run("hard cut backs up to UTF-8 boundary", func(t *testing.T) {
		// No newline anywhere: hard-cut at the byte cap, then back up past
		// continuation bytes so no multi-byte character is split.
		raw := strings.Repeat("桜", MaxEntrypointBytes) // 3 bytes per rune
		got := capEntrypoint(raw)
		if len(got) > MaxEntrypointBytes {
			t.Errorf("result exceeds byte cap: %d", len(got))
		}
		if strings.ContainsRune(got, '\uFFFD') {
			t.Error("hard cut split a multi-byte character")
		}
		if len(got)%3 != 0 {
			t.Errorf("expected whole 3-byte runes, got %d bytes", len(got))
		}
	})
}

func TestLoadAutoMemoryPromptEmpty(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	if got := LoadAutoMemoryPrompt(root); got != "" {
		t.Errorf("expected empty reminder with no memories, got: %q", got)
	}
}

func TestLoadAutoMemoryPromptListsMemories(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	dir := GetAutoMemPath(root)
	mustWriteFile(t, filepath.Join(dir, "user_role.md"), `---
name: user-role
description: user is a Go engineer
type: user
---

Body content.
`)
	prompt := LoadAutoMemoryPrompt(root)
	if !strings.HasPrefix(prompt, "Active memories:\n") {
		t.Errorf("reminder should start with the index header, got: %q", prompt)
	}
	if !strings.Contains(prompt, "- [user-role] (user): user is a Go engineer") {
		t.Errorf("reminder missing index line, got: %q", prompt)
	}
}

func TestManagerLoadAll(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	mgr := NewManager(root)
	dir := mgr.Dir()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, filepath.Join(dir, "user_role.md"), `---
name: user-role
description: user is a Go engineer
type: user
---

Body content.
`)
	mustWriteFile(t, filepath.Join(dir, "MEMORY.md"), "- [user-role](user_role.md) — user is a Go engineer\n")
	mustWriteFile(t, filepath.Join(dir, "skip.txt"), "not a memory")

	files, err := mgr.LoadAll()
	if err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 memory file (MEMORY.md and skip.txt excluded), got %d", len(files))
	}
	f := files[0]
	if f.Name != "user-role" || f.Type != "user" {
		t.Errorf("frontmatter parsed wrong: %+v", f)
	}
	if f.Content != "Body content." {
		t.Errorf("body parsed wrong: %q", f.Content)
	}

	got := mgr.GetMemories()
	if len(got) != 1 || !strings.Contains(got[0], "[user]") {
		t.Errorf("GetMemories returned %v", got)
	}
}

func TestManagerLoadAllWritesIndex(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	mgr := NewManager(root)
	mustWriteFile(t, filepath.Join(mgr.Dir(), "b.md"), "---\nname: beta\ndescription: second\n---\nbody")
	mustWriteFile(t, filepath.Join(mgr.Dir(), "a.md"), "---\nname: alpha\ndescription: first\n---\nbody")

	mgr.LoadAll()

	data, err := os.ReadFile(mgr.EntrypointPath())
	if err != nil {
		t.Fatalf("LoadAll should regenerate MEMORY.md: %v", err)
	}
	want := "- [alpha](a.md) — first\n- [beta](b.md) — second\n"
	if string(data) != want {
		t.Errorf("index content mismatch:\ngot:  %q\nwant: %q", string(data), want)
	}
}

func TestWriteIndexSkipsUnchanged(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	mgr := NewManager(root)
	mustWriteFile(t, filepath.Join(mgr.Dir(), "a.md"), "---\nname: alpha\n---\nbody")

	mgr.RebuildIndex()
	info1, err := os.Stat(mgr.EntrypointPath())
	if err != nil {
		t.Fatal(err)
	}
	mgr.RebuildIndex()
	info2, err := os.Stat(mgr.EntrypointPath())
	if err != nil {
		t.Fatal(err)
	}
	if !info1.ModTime().Equal(info2.ModTime()) {
		t.Errorf("writeIndex rewrote an identical index (mtime changed: %v -> %v)",
			info1.ModTime(), info2.ModTime())
	}
}

func TestManagerClear(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	mgr := NewManager(root)
	dir := mgr.Dir()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, filepath.Join(dir, "a.md"), "---\nname: a\ntype: user\n---\n")
	mustWriteFile(t, filepath.Join(dir, "MEMORY.md"), "- [a](a.md)\n")

	mgr.Clear()

	// Stat before LoadAll: LoadAll regenerates the (empty) index like TS.
	if _, err := os.Stat(mgr.EntrypointPath()); !os.IsNotExist(err) {
		t.Errorf("MEMORY.md should be removed; stat err = %v", err)
	}
	files, err := mgr.LoadAll()
	if err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("expected 0 files after Clear, got %d", len(files))
	}
}

func TestBuildSystemReminderListsMemories(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	mgr := NewManager(root)

	mustWriteFile(t, filepath.Join(mgr.Dir(), "prev.md"),
		"---\nname: previous-memory\ndescription: saved earlier\ntype: project\n---\nbody\n")

	prompt := mgr.BuildSystemReminder()
	want := "Active memories:\n- [previous-memory] (project): saved earlier"
	if prompt != want {
		t.Errorf("system reminder mismatch:\ngot:  %q\nwant: %q", prompt, want)
	}
}

func TestBuildSystemReminderWarnsWhenOverLineCap(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	mgr := NewManager(root)

	for i := range MaxEntrypointLines + 1 {
		name := string(rune('a'+i%26)) + string(rune('a'+i/26)) + "-mem"
		mustWriteFile(t, filepath.Join(mgr.Dir(), name+".md"),
			"---\nname: "+name+"\ndescription: d\ntype: project\n---\nbody\n")
	}

	prompt := mgr.BuildSystemReminder()
	if !strings.Contains(prompt, "> WARNING: Partial MEMORY.md: 201 lines (limit: 200).") {
		t.Errorf("missing line-cap warning, got:\n%s", prompt)
	}
	if !strings.Contains(prompt, "Check topic files before adding duplicates.") {
		t.Errorf("warning should point at duplicate avoidance, got:\n%s", prompt)
	}
}

func TestBuildSystemReminderEmpty(t *testing.T) {
	t.Setenv("YUKINO_REMOTE_MEMORY_DIR", "")
	isolateHome(t)
	root := t.TempDir()
	mgr := NewManager(root)
	if got := mgr.BuildSystemReminder(); got != "" {
		t.Errorf("expected empty reminder with no memories, got: %q", got)
	}
}

func TestParseFrontmatter(t *testing.T) {
	t.Run("no frontmatter keeps whole body", func(t *testing.T) {
		got, err := parseFrontmatter("plain body text")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.body != "plain body text" || got.name != "" || got.typ != "" {
			t.Errorf("unexpected parse: %+v", got)
		}
	})

	t.Run("missing closing delimiter errors", func(t *testing.T) {
		if _, err := parseFrontmatter("---\nname: broken\nno closing delimiter"); err == nil {
			t.Error("expected error for unclosed frontmatter")
		}
	})

	t.Run("fields and nested metadata type", func(t *testing.T) {
		got, err := parseFrontmatter("---\nname: n\ndescription: d\nmetadata:\n  type: project\n---\n\nBody.\n")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.name != "n" || got.description != "d" || got.typ != "project" || got.body != "Body." {
			t.Errorf("unexpected parse: %+v", got)
		}
	})

	t.Run("top-level type wins over metadata", func(t *testing.T) {
		got, err := parseFrontmatter("---\ntype: user\nmetadata:\n  type: project\n---\nbody")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.typ != "user" {
			t.Errorf("top-level type should win, got %q", got.typ)
		}
	})

	t.Run("invalid yaml errors", func(t *testing.T) {
		if _, err := parseFrontmatter("---\nname: [unclosed\n---\nbody"); err == nil {
			t.Error("expected error for invalid YAML")
		}
	})

	// TS zod FrontmatterSchema: z.string().optional() accepts undefined but
	// not null, so a null field rejects the whole file.
	t.Run("null description rejects the file", func(t *testing.T) {
		if _, err := parseFrontmatter("---\nname: n\ndescription: null\n---\nbody"); err == nil {
			t.Error("expected error for description: null")
		}
	})

	t.Run("null name, type and metadata reject the file", func(t *testing.T) {
		for _, fm := range []string{
			"---\nname: ~\n---\nbody",
			"---\ntype: null\n---\nbody",
			"---\nmetadata: null\n---\nbody",
			"---\nmetadata:\n  type: null\n---\nbody",
			"---\ndescription: [1, 2]\n---\nbody",
		} {
			if _, err := parseFrontmatter(fm); err == nil {
				t.Errorf("expected error for frontmatter %q", fm)
			}
		}
	})

	t.Run("comment-only block rejects the file", func(t *testing.T) {
		// js-yaml loads this as undefined and zod rejects, like an empty block.
		if _, err := parseFrontmatter("---\n# only a comment\n---\nbody"); err == nil {
			t.Error("expected error for comment-only frontmatter")
		}
	})

	t.Run("present-but-empty name and type are kept", func(t *testing.T) {
		// TS: parsed.name ?? basename / parsed.type ?? "reference" — the
		// nullish fallbacks must not fire for an empty string.
		got, err := parseFrontmatter("---\nname: \"\"\ntype: \"\"\nmetadata:\n  type: project\n---\nbody")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !got.nameSet || got.name != "" {
			t.Errorf("empty name must stay set: %+v", got)
		}
		if !got.typSet || got.typ != "" {
			t.Errorf("empty top-level type must win over metadata.type: %+v", got)
		}
	})

	t.Run("non-mapping frontmatter rejects the file", func(t *testing.T) {
		if _, err := parseFrontmatter("---\njust a scalar\n---\nbody"); err == nil {
			t.Error("expected error for scalar frontmatter")
		}
	})
}

func TestReadMemoryFileDefaults(t *testing.T) {
	dir := t.TempDir()

	// No frontmatter: name falls back to the basename, type to "reference".
	path := filepath.Join(dir, "bare_note.md")
	mustWriteFile(t, path, "just a body")
	mf, _, ok := readMemoryFile(path)
	if !ok {
		t.Fatal("bare file should load")
	}
	if mf.Name != "bare_note" || mf.Type != "reference" || mf.Content != "just a body" {
		t.Errorf("unexpected defaults: %+v", mf)
	}

	// Unclosed frontmatter: file is excluded.
	broken := filepath.Join(dir, "broken.md")
	mustWriteFile(t, broken, "---\nname: broken\nstill open")
	if _, _, ok := readMemoryFile(broken); ok {
		t.Error("file with unclosed frontmatter should be excluded")
	}

	// TS zod rejects description: null — the file is excluded entirely,
	// matching the TS readMemory catch path.
	nullDesc := filepath.Join(dir, "null_desc.md")
	mustWriteFile(t, nullDesc, "---\nname: nd\ndescription: null\n---\nbody")
	if _, _, ok := readMemoryFile(nullDesc); ok {
		t.Error("file with description: null should be excluded")
	}
}

func TestFormatFileSize(t *testing.T) {
	cases := map[int]string{
		0:       "0B",
		1023:    "1023B",
		1024:    "1.0KB",
		25_000:  "24.4KB",
		1280:    "1.3KB", // exact 1.25 tie: toFixed(1) rounds up, %.1f would say 1.2
		1310720: "1.3MB", // exact 1.25 tie in the MB branch
		1048576: "1.0MB",
	}
	for size, want := range cases {
		if got := formatFileSize(size); got != want {
			t.Errorf("formatFileSize(%d) = %q, want %q", size, got, want)
		}
	}
}

func mustWriteFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
