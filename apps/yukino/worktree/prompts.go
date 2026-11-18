package worktree

import "fmt"

const WorktreeStateUnverifiedGuidance = `Could not verify worktree state. Refusing to remove. Confirm with the user, then retry with discard_changes: true, or use action: "keep".`

func BuildWorktreeChangesGuidance(changedFiles, commits int) string {
	return fmt.Sprintf(`Worktree has %d uncommitted files and %d commits. Confirm with the user, then retry with discard_changes: true, or use action: "keep".`, changedFiles, commits)
}

func BuildWorktreeNotice(parentCwd, wtPath string) string {
	return fmt.Sprintf("You are working in a git worktree at: %s\nThe parent project is at: %s\nChanges made here are isolated from the parent working tree.", wtPath, parentCwd)
}
