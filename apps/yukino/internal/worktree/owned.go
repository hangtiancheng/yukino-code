package worktree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

type ownedWorktree struct {
	WorktreeResult
	gitDir     string
	commonDir  string
	writeRoots []string
	tempDir    string
}

type OwnedWorktrees struct {
	mu      sync.Mutex
	records map[string]ownedWorktree
	order   []string
}

func (o *OwnedWorktrees) Get(path string) *WorktreeResult {
	canonical, err := utils.CanonicalPath(path, 0)
	if err != nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	record, ok := o.records[canonical]
	if !ok {
		return nil
	}
	result := record.WorktreeResult
	return &result
}

func (o *OwnedWorktrees) Register(ctx context.Context, wt WorktreeResult) (bool, error) {
	path, err := utils.CanonicalPath(wt.WorktreePath, 0)
	if err != nil {
		return false, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, ok := o.records[path]; ok {
		return true, nil
	}
	if !wt.Created {
		return false, nil
	}
	gitDir, err := ResolveGitDir(path)
	if err != nil {
		return false, err
	}
	gitDir, err = utils.CanonicalPath(gitDir, 0)
	if err != nil {
		return false, err
	}
	commonDir, err := canonicalCommonDir(ctx, path)
	if err != nil {
		return false, err
	}
	branchDir := filepath.Dir(wt.WorktreeBranch)
	if !IsSafeRefName(wt.WorktreeBranch) || branchDir == "." {
		return false, fmt.Errorf("Worktree branch requires an isolated ref directory")
	}
	refDir := filepath.Join(commonDir, "refs", "heads", branchDir)
	logDir := filepath.Join(commonDir, "logs", "refs", "heads", branchDir)
	tempDir := filepath.Join(gitDir, "yukino-tmp")
	for _, dir := range []string{refDir, logDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return false, err
		}
	}
	if err := os.MkdirAll(tempDir, 0o700); err != nil {
		return false, err
	}
	wt.WorktreePath = path
	wt.GitRoot, err = utils.CanonicalPath(wt.GitRoot, 0)
	if err != nil {
		return false, err
	}
	roots := []string{gitDir}
	for _, root := range []string{filepath.Join(commonDir, "objects"), refDir, logDir} {
		root, err := utils.CanonicalPath(root, 0)
		if err != nil {
			return false, err
		}
		roots = append(roots, root)
	}
	if o.records == nil {
		o.records = make(map[string]ownedWorktree)
	}
	o.records[path] = ownedWorktree{WorktreeResult: wt, gitDir: gitDir, commonDir: commonDir, writeRoots: roots, tempDir: tempDir}
	o.order = append(o.order, path)
	return true, nil
}

func (o *OwnedWorktrees) SandboxWriteRoots() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	var roots []string
	for _, path := range o.order {
		roots = append(roots, o.records[path].writeRoots...)
	}
	return roots
}

func (o *OwnedWorktrees) TempDirectory(path string) string {
	canonical, err := utils.CanonicalPath(path, 0)
	if err != nil {
		return ""
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.records[canonical].tempDir
}

func (o *OwnedWorktrees) Remove(ctx context.Context, requested string, discardChanges bool) (*ChangeSummary, error) {
	path, err := utils.CanonicalPath(requested, 0)
	if err != nil {
		return nil, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	record, ok := o.records[path]
	if !ok {
		return nil, fmt.Errorf("Worktree is not owned by this runtime; kept at: %s", path)
	}
	gitDir, err := ResolveGitDir(path)
	if err != nil {
		return nil, err
	}
	gitDir, err = utils.CanonicalPath(gitDir, 0)
	if err != nil {
		return nil, err
	}
	commonDir, err := canonicalCommonDir(ctx, path)
	if err != nil {
		return nil, err
	}
	if gitDir != record.gitDir || commonDir != record.commonDir {
		return nil, fmt.Errorf("Worktree Git identity changed; refusing cleanup")
	}
	backlink, err := os.ReadFile(filepath.Join(record.gitDir, "gitdir"))
	if err != nil {
		return nil, err
	}
	backlinkPath := strings.TrimSpace(string(backlink))
	if !filepath.IsAbs(backlinkPath) {
		backlinkPath = filepath.Join(record.gitDir, backlinkPath)
	}
	backlinkPath, err = utils.CanonicalPath(backlinkPath, 0)
	if err != nil {
		return nil, err
	}
	pointer, err := utils.CanonicalPath(filepath.Join(path, GitDirName), 0)
	if err != nil {
		return nil, err
	}
	repositoryCommon, err := canonicalCommonDir(ctx, record.GitRoot)
	if err != nil {
		return nil, err
	}
	branch, err := GetCurrentBranch(path)
	if err != nil {
		return nil, err
	}
	if backlinkPath != pointer || repositoryCommon != record.commonDir || branch != record.WorktreeBranch {
		return nil, fmt.Errorf("Worktree registration or branch changed; refusing cleanup")
	}
	changes := CountWorktreeChanges(ctx, path, record.HeadCommit)
	if !discardChanges {
		if changes == nil {
			return nil, fmt.Errorf("%s", WorktreeStateUnverifiedGuidance)
		}
		if changes.ChangedFiles > 0 || changes.Commits > 0 || HasWorktreeChanges(ctx, path, record.HeadCommit) {
			return nil, fmt.Errorf("%s", BuildWorktreeChangesGuidance(changes.ChangedFiles, changes.Commits))
		}
	}
	if err := RemoveAgentWorktree(ctx, path, record.WorktreeBranch, record.GitRoot, discardChanges); err != nil {
		return nil, err
	}
	delete(o.records, path)
	for i, p := range o.order {
		if p == path {
			o.order = append(o.order[:i], o.order[i+1:]...)
			break
		}
	}
	return changes, nil
}

func canonicalCommonDir(ctx context.Context, path string) (string, error) {
	out, err := gitOutput(ctx, path, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", err
	}
	dir := strings.TrimSpace(out)
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(path, dir)
	}
	return utils.CanonicalPath(dir, 0)
}
