package utils

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCanonicalDanglingAbsoluteSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(t.TempDir(), "not-created")
	link := filepath.Join(root, "alias")
	if err := os.Symlink(target, link); err != nil {
		t.Skip(err)
	}
	got, err := CanonicalPath(filepath.Join(link, "child", "file.txt"), 0)
	wantParent, err2 := filepath.EvalSymlinks(filepath.Dir(target))
	want := filepath.Join(wantParent, filepath.Base(target), "child", "file.txt")
	if err != nil || err2 != nil || got != want {
		t.Fatalf("got %s (%v), want %s (%v)", got, err, want, err2)
	}
}
