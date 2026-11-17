package memory

import (
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

func NewMemoryPermissionChecker(cwd string, allowProjectReads bool) *permissions.Checker {
	checker := permissions.NewChecker(permissions.NewPathSandbox(cwd), permissions.NewRuleEngine(cwd), permissions.ModeDefault)
	projectMemory, projectErr := storage.ProjectPath(cwd, "memory")
	roots := []string{projectMemory, storage.YukinoPath("memory")}
	readRoots := append([]string(nil), roots...)
	if allowProjectReads {
		sessions, err := storage.GetSessionsDir(cwd)
		if err == nil {
			readRoots = append(readRoots, cwd, sessions)
		}
	}
	within := func(target string, roots []string) bool {
		for _, root := range roots {
			if root == "" {
				continue
			}
			canonical, err := utils.CanonicalPath(root, 0)
			if err == nil && utils.IsPathWithin(canonical, target) {
				return true
			}
		}
		return false
	}
	checker.SearchReadPolicy = func(path string) bool {
		target, err := utils.CanonicalPath(utils.ResolveToolPath(cwd, path), 0)
		return err == nil && within(target, readRoots)
	}
	checker.SearchTraversePolicy = func(path string) bool {
		absolute := utils.ResolveToolPath(cwd, path)
		target, err := utils.CanonicalPath(absolute, 0)
		if err != nil {
			return false
		}
		for _, root := range readRoots {
			canonical, err := utils.CanonicalPath(root, 0)
			if err != nil {
				continue
			}
			if utils.IsPathWithin(canonical, target) || utils.IsPathWithin(absolute, utils.ResolveToolPath(cwd, root)) && utils.IsPathWithin(target, canonical) {
				return true
			}
		}
		return false
	}
	checker.Policy = func(tool tools.Tool, args map[string]any) permissions.Decision {
		deny := func(reason string) permissions.Decision {
			return permissions.Decision{Effect: permissions.Deny, Reason: reason}
		}
		if projectErr != nil {
			return deny("Memory path resolution failed: " + projectErr.Error())
		}
		name, category := tool.Name(), tool.Category()
		if explicit := checker.CheckExplicitRules(name, args); explicit != nil && explicit.Effect != permissions.Allow {
			return deny("Background memory cannot approve: " + explicit.Reason)
		}
		if !MemoryTaskTools[name] || category == tools.CategoryCommand {
			return deny("Background memory tasks only support scoped file operations")
		}
		requested := args["file_path"]
		if name == "Glob" || name == "Grep" {
			requested = args["path"]
			if requested == nil {
				requested = cwd
			}
		}
		path, ok := requested.(string)
		if !ok {
			return deny("Invalid memory task path")
		}
		target, err := utils.CanonicalPath(utils.ResolveToolPath(cwd, path), 0)
		if err != nil {
			return deny("Memory path resolution failed: " + err.Error())
		}
		if category == tools.CategoryWrite {
			if within(target, roots) && filepath.Ext(target) == ".md" {
				return permissions.Decision{Effect: permissions.Allow, Reason: "Memory file update"}
			}
			return deny("Background memory writes must stay in the memory directories and use .md files")
		}
		if name == "Glob" {
			pattern, _ := args["pattern"].(string)
			if pattern == "" || GlobEscapeRe.MatchString(pattern) {
				return deny("Glob pattern escapes the memory task scope")
			}
			absolute := utils.ResolveToolPath(target, pattern)
			prefix := absolute
			if magic := GlobMagicRe.FindStringIndex(absolute); magic != nil {
				prefix = absolute[:strings.LastIndex(absolute[:magic[0]], "/")+1]
			}
			if !checker.CanReadSearchPath(prefix) {
				return deny("Glob pattern escapes the memory task scope")
			}
		} else if !checker.CanReadSearchPath(target) {
			return deny("Read outside the memory task's scope")
		}
		return permissions.Decision{Effect: permissions.Allow, Reason: "Memory task read"}
	}
	return checker
}

func NewTaskToolRegistry() *tools.Registry {
	registry := tools.NewRegistry()
	cache := tools.NewFileStateCache()
	registry.Register(&tools.ReadFileTool{FileStateCache: cache})
	registry.Register(&tools.WriteFileTool{FileStateCache: cache})
	registry.Register(&tools.EditFileTool{FileStateCache: cache})
	registry.Register(&tools.GlobTool{})
	registry.Register(&tools.GrepTool{})
	return registry
}
