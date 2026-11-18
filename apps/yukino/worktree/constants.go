package worktree

import "regexp"

const (
	MaxRefResolutionDepth      = 64
	GitDirName                 = ".git"
	WorktreesDirName           = "worktrees"
	GitdirPrefix               = "gitdir:"
	RefPrefix                  = "ref:"
	RefsHeadsPrefix            = "refs/heads/"
	WorktreeAlreadyActiveError = "Already in a worktree session"
	WorktreeNotOwnedError      = "Cannot enter a worktree that was not created by this runtime"
	NoWorktreeSessionMessage   = "No-op: there is no active EnterWorktree session to exit. No filesystem changes were made."
)

var (
	safeRefName         = regexp.MustCompile(`^[a-zA-Z0-9/._+@-]+$`)
	shaPattern          = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
	WorktreeSlugPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	sharedAgentsEntries = []string{"AGENTS.md", "skills"}
)
