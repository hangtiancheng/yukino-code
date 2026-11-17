package memory

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustInitGit(t *testing.T, dir string) {
	t.Helper()
	cmd := exec.Command("git", "init")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
}

func TestLoadInstructionsGlobalBeforeProject(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := t.TempDir()
	mustInitGit(t, dir)

	mustWrite(t, filepath.Join(dir, "AGENTS.md"), "plain file")
	mustWrite(t, storage.YukinoPath("AGENTS.md"), "global file")
	mustWrite(t, filepath.Join(dir, ".yukino", "AGENTS.md"), "obsolete hidden instructions")

	out := LoadInstructions(dir)
	if !strings.Contains(out, "plain file") {
		t.Errorf("missing project instructions:\n%s", out)
	}
	if !strings.Contains(out, "global file") {
		t.Errorf("missing global instructions:\n%s", out)
	}
	if strings.Contains(out, "obsolete hidden instructions") {
		t.Errorf("hidden .yukino instructions must be ignored:\n%s", out)
	}
	if strings.Index(out, "global file") >= strings.Index(out, "plain file") {
		t.Errorf("global instructions must come before project ones:\n%s", out)
	}
}

func TestLoadInstructionsRepoRootToCwd(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	root := t.TempDir()
	mustInitGit(t, root)
	sub := filepath.Join(root, "pkg", "deep")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "AGENTS.md"), "root instructions")
	mustWrite(t, filepath.Join(sub, "AGENTS.md"), "leaf instructions")

	out := LoadInstructions(sub)
	rootIdx := strings.Index(out, "root instructions")
	leafIdx := strings.Index(out, "leaf instructions")
	if rootIdx == -1 || leafIdx == -1 {
		t.Fatalf("both files should appear; got:\n%s", out)
	}
	if rootIdx >= leafIdx {
		t.Errorf("leaf file should be ordered after root (higher priority); root=%d leaf=%d", rootIdx, leafIdx)
	}
}
