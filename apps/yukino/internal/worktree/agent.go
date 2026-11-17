package worktree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type WorktreeResult struct {
	Created        bool
	WorktreePath   string
	WorktreeBranch string
	HeadCommit     string
	GitRoot        string
}

type WorktreeSession struct {
	WorktreeResult
	OriginalCwd string
}

func CreateAgentWorktree(ctx context.Context, slug, gitRoot, cwd string) (*WorktreeResult, error) {
	if !WorktreeSlugPattern.MatchString(slug) {
		return nil, fmt.Errorf("Invalid worktree slug: use only alphanumeric, hyphen, underscore")
	}
	if gitRoot == "" {
		out, err := gitOutput(ctx, cwd, "rev-parse", "--show-toplevel")
		if err != nil {
			return nil, err
		}
		gitRoot = strings.TrimSpace(out)
	}
	key, err := storage.ProjectKey(gitRoot)
	if err != nil {
		return nil, err
	}
	path := storage.YukinoPath(WorktreesDirName, key, slug)
	branch := "worktree/" + slug + "/work"
	created := false
	if _, err := os.Stat(path); err == nil {
		top, err := gitOutput(ctx, path, "rev-parse", "--show-toplevel")
		if err != nil {
			return nil, fmt.Errorf("Existing directory is not a worktree root: %s: %w", path, err)
		}
		topReal, err := filepath.EvalSymlinks(strings.TrimSpace(top))
		if err != nil {
			return nil, err
		}
		pathReal, err := filepath.EvalSymlinks(path)
		if err != nil {
			return nil, err
		}
		if topReal != pathReal {
			return nil, fmt.Errorf("Existing directory is not a worktree root: %s", path)
		}
	} else {
		existing, err := gitOutput(ctx, gitRoot, "branch", "--list", "--format=%(refname)", "--", branch)
		if err != nil {
			return nil, err
		}
		args := []string{"worktree", "add", "--", path, branch}
		if strings.TrimSpace(existing) == "" {
			args = []string{"worktree", "add", "-b", branch, "--", path}
		}
		if _, err := gitOutput(ctx, gitRoot, args...); err != nil {
			return nil, err
		}
		performPostCreationSetup(ctx, gitRoot, path)
		created = true
	}
	head, _ := ReadWorktreeHeadSha(path)
	if head == "" {
		out, err := gitOutput(ctx, path, "rev-parse", "HEAD")
		if err != nil {
			return nil, err
		}
		head = strings.TrimSpace(out)
	}
	return &WorktreeResult{Created: created, WorktreePath: path, WorktreeBranch: branch, HeadCommit: head, GitRoot: gitRoot}, nil
}

func RemoveAgentWorktree(ctx context.Context, path, branch, gitRoot string, discardChanges bool) error {
	args := []string{"worktree", "remove"}
	if discardChanges {
		args = append(args, "--force")
	}
	args = append(args, "--", path)
	if _, err := gitOutput(ctx, gitRoot, args...); err != nil {
		return err
	}
	flag := "-d"
	if discardChanges {
		flag = "-D"
	}
	_, err := gitOutput(ctx, gitRoot, "branch", flag, "--", branch)
	return err
}
