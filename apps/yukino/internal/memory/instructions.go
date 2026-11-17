package memory

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type InstructionSource struct {
	Path    string
	Content string
}

// LoadInstructions discovers and concatenates all project- and user-level
// instruction files.
//
// Discovery order (later entries take higher precedence — the model attends
// more to content appearing later):
//  1. User-global: ~/.yukino/AGENTS.md
//  2. Project: AGENTS.md in every directory from the git root down to cwd
func LoadInstructions(workDir string) string {
	sources := DiscoverInstructions(workDir)
	if len(sources) == 0 {
		return ""
	}
	var parts []string
	for _, s := range sources {
		// Prefer relative paths as labels for better readability.
		label := s.Path
		if rel, err := filepath.Rel(workDir, s.Path); err == nil && !strings.HasPrefix(rel, "..") {
			label = rel
		}
		parts = append(parts, fmt.Sprintf("Contents of %s:\n\n%s", label, strings.TrimRight(s.Content, "\n")))
	}
	return strings.Join(parts, "\n\n---\n\n")
}

// DiscoverInstructions returns all loaded instruction sources in priority
// order: lowest priority first (user-global), highest last (local override).
func DiscoverInstructions(workDir string) []InstructionSource {
	var sources []InstructionSource
	seen := map[string]bool{}

	addSource(&sources, seen, storage.YukinoPath(AgentsFileName))
	for _, dir := range projectInstructionDirs(workDir) {
		addSource(&sources, seen, filepath.Join(dir, AgentsFileName))
	}
	return sources
}

func addSource(out *[]InstructionSource, seen map[string]bool, filePath string) {
	abs, err := filepath.Abs(filePath)
	if err != nil || seen[abs] {
		if err != nil {
			log.Error(map[string]any{"err": err}, "memory operation failed")
		}
		return
	}
	if _, err := os.Stat(abs); err != nil {
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		log.Error(map[string]any{"err": err}, "memory operation failed")
		return
	}
	seen[abs] = true
	*out = append(*out, InstructionSource{Path: abs, Content: string(data)})
}

// projectInstructionDirs returns the directories from the git root to cwd. If
// cwd is not inside a git repository, it returns only [cwd].
func projectInstructionDirs(workDir string) []string {
	abs, err := filepath.Abs(workDir)
	if err != nil {
		log.Error(map[string]any{"err": err}, "memory operation failed")
		return []string{workDir}
	}
	root := findGitRoot(abs)
	if root == "" {
		return []string{abs}
	}
	var dirs []string
	cur := abs
	for {
		dirs = append([]string{cur}, dirs...)
		if cur == root {
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return dirs
}

// findGitRoot traverses upward to find the .git entry (a directory, or a file
// in linked worktrees) and determine the git repository root.
func findGitRoot(start string) string {
	cur := start
	for {
		if _, err := os.Stat(filepath.Join(cur, ".git")); err == nil {
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return ""
		}
		cur = parent
	}
}
