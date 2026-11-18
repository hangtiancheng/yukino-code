package tools

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type GlobTool struct{}

func (t *GlobTool) Name() string           { return "Glob" }
func (t *GlobTool) Description() string    { return GlobDescription }
func (t *GlobTool) Category() ToolCategory { return CategoryRead }
func (t *GlobTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{"type": "object", "properties": map[string]any{
		"pattern": map[string]any{"type": "string", "description": "Filename glob relative to path, e.g. '**/*.ts' for recursive search or '*.{ts,tsx}' for direct children."},
		"path":    map[string]any{"type": "string", "description": "Search base, absolute or relative to the Agent's working directory (default '.'). Returned filenames are relative to this base.", "default": "."},
	}, "required": []string{"pattern"}}}
}
func (t *GlobTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	if ctx.Err() != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	pattern, _ := args["pattern"].(string)
	if pattern == "" {
		return ToolResult{Output: "Error: pattern is required", IsError: true}
	}
	if strings.HasPrefix(pattern, "~/") {
		pattern = toolPath(ctx, pattern)
	}
	base, _ := args["path"].(string)
	if base == "" {
		base = "."
	}
	base = toolPath(ctx, base)
	info, err := os.Stat(base)
	if err != nil || !info.IsDir() {
		return ToolResult{Output: fmt.Sprintf("Error: not a directory, scan '%s'", base), IsError: true}
	}
	absolutePattern := filepath.IsAbs(pattern)
	scanRoot := base
	matchPattern := filepath.ToSlash(pattern)
	if absolutePattern || strings.Contains(pattern, "..") {
		absolute := toolPath(WithExecutionContext(ctx, ExecutionContext{WorkDir: base}), pattern)
		magic := strings.IndexAny(absolute, "*?{[(")
		if magic < 0 {
			scanRoot = filepath.Dir(absolute)
		} else {
			scanRoot = filepath.Dir(absolute[:magic] + "_")
		}
		matchPattern, _ = filepath.Rel(scanRoot, absolute)
		matchPattern = filepath.ToSlash(matchPattern)
	}
	execution, _ := ctx.Value(executionContextKey{}).(ExecutionContext)
	results := searchOutput{max: 1000}
	err = fs.WalkDir(os.DirFS(scanRoot), ".", func(relative string, entry fs.DirEntry, walkErr error) error {
		path := filepath.Join(scanRoot, filepath.FromSlash(relative))
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if walkErr != nil {
			return nil
		}
		if path != scanRoot {
			if entry.IsDir() && SkipDirs[entry.Name()] {
				return filepath.SkipDir
			}
			if !searchAllowed(execution, path, entry.IsDir()) {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if target, err := os.Stat(path); err != nil || target.IsDir() {
				return nil
			}
		}
		rel, _ := filepath.Rel(scanRoot, path)
		if !matchGlob(matchPattern, filepath.ToSlash(rel)) {
			return nil
		}
		result, _ := filepath.Rel(base, path)
		if absolutePattern {
			result = path
		}
		if !results.append(result) {
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return ToolResult{Output: OperationInterruptedError, IsError: true}
		}
		return ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	if len(results.lines) == 0 {
		return ToolResult{Output: "No files matched the pattern."}
	}
	mtimes := make(map[string]time.Time)
	for _, name := range results.lines {
		path := name
		if !filepath.IsAbs(path) {
			path = filepath.Join(base, path)
		}
		if info, err := os.Stat(path); err == nil {
			mtimes[name] = info.ModTime()
		}
	}
	sort.Slice(results.lines, func(i, j int) bool {
		a, b := results.lines[i], results.lines[j]
		if mtimes[a].Equal(mtimes[b]) {
			return a < b
		}
		return mtimes[a].After(mtimes[b])
	})
	output := strings.Join(results.lines, "\n")
	if results.limit == "matches" {
		output += "\n(Results limited to 1000 files. Use a more specific pattern.)"
	}
	if results.limit == "bytes" {
		output += "\n(Results limited to 50KB. Use a more specific pattern or path.)"
	}
	return ToolResult{Output: output}
}
