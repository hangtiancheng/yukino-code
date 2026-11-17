package main

// Build guards, mirroring the reference's `ban-ui-only-deps` tsup plugin and
// `tests/build-guards.test.ts`: the terminal-independent library surface must
// never reach the UI layer, and the declared ui-only module list must match
// the modules actually imported only by the terminal layer.

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// uiOnlyModules is the declared list of modules only the terminal layer may
// import. build-guards re-derive it from the actual import sites and fail on
// drift, exactly like the reference's test re-derives the tsup list.
var uiOnlyModules = []string{
	"github.com/alecthomas/chroma/v2",
	"github.com/charmbracelet/bubbles",
	"github.com/charmbracelet/bubbletea",
	"github.com/charmbracelet/lipgloss",
	"github.com/charmbracelet/x/ansi",
	"github.com/charmbracelet/x/term",
	"github.com/muesli/cancelreader",
	"github.com/rivo/uniseg",
	"github.com/yuin/goldmark",
}

const uiPackage = "github.com/yukino-js/yukino/yukino/internal/ui"

func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found above the working directory")
		}
		dir = parent
	}
}

func goModModules(t *testing.T, root string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	var modules []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.Split(line, "//")[0])
		if strings.HasPrefix(line, "module ") || strings.HasPrefix(line, "go ") ||
			line == "require (" || line == "(" || line == ")" || line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.Contains(fields[0], ".") {
			modules = append(modules, fields[0])
		}
	}
	sort.Slice(modules, func(i, j int) bool { return len(modules[i]) > len(modules[j]) })
	return modules
}

func owningModule(importPath string, modules []string) string {
	for _, mod := range modules {
		if importPath == mod || strings.HasPrefix(importPath, mod+"/") {
			return mod
		}
	}
	return ""
}

func isTerminalLayer(dir string) bool {
	return dir == "internal/ui" || strings.HasPrefix(dir, "internal/ui/") || dir == "cmd/yukino"
}

func TestBuildGuards(t *testing.T) {
	root := moduleRoot(t)
	modules := goModModules(t, root)

	importers := map[string]map[string]bool{}
	var uiViolations []string
	fset := token.NewFileSet()

	for _, base := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, base), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			pkgDir, err := filepath.Rel(root, filepath.Dir(path))
			if err != nil {
				return err
			}
			file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			for _, spec := range file.Imports {
				imp := strings.Trim(spec.Path.Value, `"`)
				if imp == uiPackage || strings.HasPrefix(imp, uiPackage+"/") {
					if !isTerminalLayer(pkgDir) {
						uiViolations = append(uiViolations, pkgDir+" imports "+imp)
					}
					continue
				}
				if mod := owningModule(imp, modules); mod != "" {
					if importers[mod] == nil {
						importers[mod] = map[string]bool{}
					}
					importers[mod][pkgDir] = true
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	if len(uiViolations) > 0 {
		sort.Strings(uiViolations)
		t.Errorf("non-UI packages reach the terminal layer:\n  %s", strings.Join(uiViolations, "\n  "))
	}

	var derived []string
	for mod, dirs := range importers {
		terminalOnly := true
		for dir := range dirs {
			if !isTerminalLayer(dir) {
				terminalOnly = false
				break
			}
		}
		if terminalOnly {
			derived = append(derived, mod)
		}
	}
	sort.Strings(derived)

	declared := append([]string(nil), uiOnlyModules...)
	sort.Strings(declared)
	if strings.Join(declared, "\n") != strings.Join(derived, "\n") {
		t.Errorf("ui-only module list drifted from actual import sites:\ndeclared:\n  %s\nderived:\n  %s",
			strings.Join(declared, "\n  "), strings.Join(derived, "\n  "))
	}
}
