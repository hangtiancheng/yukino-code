package memory

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestMemoryPermissionsLimitReadsAndWrites(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	checker := NewMemoryPermissionChecker(cwd, false)
	projectMemory, _ := storage.ProjectPath(cwd, "memory")
	userMemory := storage.YukinoPath("memory")
	for _, path := range []string{filepath.Join(projectMemory, "topic.md"), filepath.Join(userMemory, "MEMORY.md")} {
		if result := checker.Check(&tools.WriteFileTool{}, map[string]any{"file_path": path}); result.Effect != permissions.Allow {
			t.Fatal(result)
		}
		if !checker.CanReadSearchPath(path) {
			t.Fatal("memory read rejected")
		}
	}
	for _, path := range []string{filepath.Join(cwd, "file.md"), filepath.Join(projectMemory, "code.go"), filepath.Join(os.TempDir(), "outside-memory.md")} {
		if result := checker.Check(&tools.WriteFileTool{}, map[string]any{"file_path": path}); result.Effect != permissions.Deny {
			t.Fatal(result)
		}
	}
	if result := checker.Check(&tools.BashTool{}, map[string]any{"command": "true"}); result.Effect != permissions.Deny {
		t.Fatal(result)
	}
	if checker.CanReadSearchPath(cwd) {
		t.Fatal("extractor can read project source")
	}
	consolidation := NewMemoryPermissionChecker(cwd, true)
	if !consolidation.CanReadSearchPath(cwd) {
		t.Fatal("consolidation cannot read project")
	}
	for _, pattern := range []string{"../*.md", "{../*.md,*.md}", "/etc/*", "..\\*.md"} {
		if result := checker.Check(&tools.GlobTool{}, map[string]any{"path": projectMemory, "pattern": pattern}); result.Effect != permissions.Deny {
			t.Fatal(pattern, result)
		}
	}
	if result := checker.Check(&tools.GlobTool{}, map[string]any{"path": projectMemory, "pattern": "*.md"}); result.Effect != permissions.Allow {
		t.Fatal(result)
	}
	if err := storage.WritePrivateFileSync(checker.RuleEngine.ProjectPath(), []byte("- rule: 'ReadFile(*)'\n  effect: ask\n"), os.O_CREATE|os.O_WRONLY); err != nil {
		t.Fatal(err)
	}
	if result := checker.Check(&tools.ReadFileTool{}, map[string]any{"file_path": filepath.Join(projectMemory, "topic.md")}); result.Effect != permissions.Deny {
		t.Fatal("background task requested approval", result)
	}
}
