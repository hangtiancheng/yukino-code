package workflow

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func isScriptExt(ext string) bool {
	for _, supported := range WorkflowScriptExtensions {
		if supported == strings.ToLower(ext) {
			return true
		}
	}
	return false
}

// ResolveNamedWorkflow loads .yukino/workflows/<name>.{ts,js,mjs}, refusing
// symlinks that escape the workflow directory.
func ResolveNamedWorkflow(workflowDir, name string) (path, content string, ok bool) {
	if SanitizeWorkflowName(name) == "" {
		return "", "", false
	}
	for _, ext := range WorkflowScriptExtensions {
		candidate := filepath.Join(workflowDir, name+ext)
		if !ContainsPath(workflowDir, candidate) {
			return "", "", false
		}
		actual, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return "", "", false
		}
		resolvedDir, err := filepath.EvalSymlinks(workflowDir)
		if err != nil {
			resolvedDir = workflowDir
		}
		if !ContainsPath(resolvedDir, actual) {
			return "", "", false
		}
		data, err := os.ReadFile(actual)
		if err != nil {
			return "", "", false
		}
		return actual, string(data), true
	}
	return "", "", false
}

// ListNamedWorkflows returns the sorted unique workflow names in the
// directory.
func ListNamedWorkflows(workflowDir string) []string {
	entries, err := os.ReadDir(workflowDir)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var names []string
	for _, entry := range entries {
		file := entry.Name()
		ext := filepath.Ext(file)
		if !isScriptExt(ext) {
			continue
		}
		name := strings.TrimSuffix(file, ext)
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}
