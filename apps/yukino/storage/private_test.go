//go:build darwin || linux

package storage

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func mode(path string) os.FileMode {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Mode().Perm()
}

func TestPrivateStatePermissionsPOSIX(t *testing.T) {
	oldUmask := syscall.Umask(0o022)
	defer syscall.Umask(oldUmask)
	home := t.TempDir()
	t.Setenv("HOME", home)

	root := GetYukinoDir()
	homeMode := mode(home)
	if err := os.MkdirAll(filepath.Join(root, "projects", "test"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "projects", "test", "state.json")
	if err := os.WriteFile(file, []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}
	data, err := ReadPrivateFileSync(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "existing" {
		t.Fatalf("read = %q, want existing", data)
	}
	if mode(file) != 0o600 {
		t.Fatalf("file mode = %o, want 600", mode(file))
	}
	for _, dir := range []string{root, filepath.Join(root, "projects"), filepath.Dir(file)} {
		if mode(dir) != 0o700 {
			t.Fatalf("dir %s mode = %o, want 700", dir, mode(dir))
		}
	}
	if err := os.Chmod(file, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := AppendPrivateFileSync(file, []byte(" appended")); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "existing appended" {
		t.Fatalf("content = %q", content)
	}
	if mode(file) != 0o600 {
		t.Fatalf("appended file mode = %o, want 600", mode(file))
	}
	temporary := file + ".tmp"
	if err := WritePrivateFileSync(temporary, []byte("replacement"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, file); err != nil {
		t.Fatal(err)
	}
	if mode(file) != 0o600 {
		t.Fatalf("renamed file mode = %o, want 600", mode(file))
	}
	if err := os.Chmod(file, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WritePrivateFileSync(file, []byte("async replacement"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		t.Fatal(err)
	}
	if mode(file) != 0o600 {
		t.Fatalf("rewritten file mode = %o, want 600", mode(file))
	}
	if mode(home) != homeMode {
		t.Fatalf("HOME mode changed: %o != %o", mode(home), homeMode)
	}
}

func TestPrivateStateRefusesSymlinks(t *testing.T) {
	oldUmask := syscall.Umask(0o022)
	defer syscall.Umask(oldUmask)
	home := t.TempDir()
	t.Setenv("HOME", home)
	directory := t.TempDir()

	source := filepath.Join(directory, "source.ts")
	if err := os.WriteFile(source, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := MkdirPrivateSync(YukinoPath("memory")); err != nil {
		t.Fatal(err)
	}
	link := YukinoPath("memory", "linked.md")
	if err := os.Symlink(source, link); err != nil {
		t.Fatal(err)
	}
	if err := WritePrivateFileSync(link, []byte("changed"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err == nil {
		t.Fatal("writing through a symlink must fail")
	}
	if _, err := ReadPrivateFileSync(link); err == nil {
		t.Fatal("reading through a symlink must fail")
	}
	linkedDirectory := YukinoPath("memory", "linked-dir")
	if err := os.Symlink(directory, linkedDirectory); err != nil {
		t.Fatal(err)
	}
	if err := WritePrivateFileSync(filepath.Join(linkedDirectory, "new.md"), []byte("changed"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err == nil {
		t.Fatal("writing through a symlinked directory must fail")
	}
	if _, err := os.Stat(filepath.Join(directory, "new.md")); !os.IsNotExist(err) {
		t.Fatal("no file may be created through the symlinked directory")
	}
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "original" {
		t.Fatalf("source content = %q, want original", content)
	}
	if mode(source) != 0o644 {
		t.Fatalf("source mode = %o, want 644", mode(source))
	}
}

func TestIsPrivateStatePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if !IsPrivateStatePath(YukinoPath("sessions", "x.jsonl")) {
		t.Fatal("sessions must be private state")
	}
	if IsPrivateStatePath(YukinoPath("skills", "x")) {
		t.Fatal("skills are public state")
	}
	if IsPrivateStatePath(YukinoPath("worktrees", "x")) {
		t.Fatal("worktrees are public state")
	}
	if IsPrivateStatePath(filepath.Join(home, "other", "file")) {
		t.Fatal("paths outside the yukino dir are not private state")
	}
}
