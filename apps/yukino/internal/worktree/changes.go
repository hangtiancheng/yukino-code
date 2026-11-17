package worktree

import (
	"context"
	"strconv"
	"strings"
)

type ChangeSummary struct {
	ChangedFiles int
	Commits      int
}

func HasWorktreeChanges(ctx context.Context, worktreePath, headCommit string) bool {
	stdout, _, code := runGit(ctx, worktreePath, "status", "--porcelain")
	if code != 0 {
		return true
	}
	if strings.TrimSpace(stdout) != "" {
		return true
	}

	head, _ := ReadWorktreeHeadSha(worktreePath)
	if head == "" {
		stdout, _, code = runGit(ctx, worktreePath, "rev-parse", "HEAD")
		if code != 0 {
			return true
		}
		head = strings.TrimSpace(stdout)
	}
	return head != headCommit
}

func CountWorktreeChanges(ctx context.Context, worktreePath, originalHeadCommit string) *ChangeSummary {
	stdout, _, code := runGit(ctx, worktreePath, "status", "--porcelain", "--untracked-files=all")
	if code != 0 {
		return nil
	}
	changedFiles := 0
	for _, line := range strings.Split(stdout, "\n") {
		if strings.TrimSpace(line) != "" {
			changedFiles++
		}
	}

	stdout, _, code = runGit(ctx, worktreePath, "rev-list", "--count", originalHeadCommit+"..HEAD")
	if code != 0 {
		return nil
	}
	commits, err := strconv.Atoi(strings.TrimSpace(stdout))
	if err != nil || commits < 0 || uint64(commits) > 9007199254740991 {
		return nil
	}

	return &ChangeSummary{
		ChangedFiles: changedFiles,
		Commits:      commits,
	}
}
