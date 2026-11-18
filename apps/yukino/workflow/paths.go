package workflow

import (
	"path/filepath"
	"strings"
)

func ContainsPath(base, target string) bool {
	resolvedBase, err := filepath.Abs(base)
	if err != nil {
		resolvedBase = base
	}
	resolvedTarget := target
	if !filepath.IsAbs(resolvedTarget) {
		resolvedTarget = filepath.Join(resolvedBase, target)
	}
	resolvedTarget = filepath.Clean(resolvedTarget)
	if resolvedTarget == resolvedBase {
		return true
	}
	return strings.HasPrefix(resolvedTarget, resolvedBase+string(filepath.Separator))
}

func SanitizeWorkflowName(name string) string {
	if name == "" {
		return ""
	}
	if strings.ContainsAny(name, "/\\") {
		return ""
	}
	if strings.ContainsRune(name, 0) {
		return ""
	}
	if name == "." || name == ".." {
		return ""
	}
	return name
}
