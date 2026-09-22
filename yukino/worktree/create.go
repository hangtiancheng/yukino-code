// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package worktree

import (
	"context"
	"fmt"
	"path/filepath"
)

// WorktreesDir is where all Yukino-managed worktrees live: a single directory inside the repo root
// that's already in .gitignore.
func WorktreesDir(repoRoot string) string {
	return filepath.Join(repoRoot, ".yukino", "worktrees")
}

// WorktreePathFor returns the worktree directory path for slug
// (TS: join(root, ".yukino", "worktrees", slug)).
func WorktreePathFor(repoRoot, slug string) string {
	return filepath.Join(WorktreesDir(repoRoot), slug)
}

// CreateResult is the outcome of getOrCreateWorktree — Existed=true means we fast-resumed an
// existing worktree directory (skipped `git worktree add` and performPostCreationSetup).
type CreateResult struct {
	WorktreePath   string
	WorktreeBranch string
	HeadCommit     string
	Existed        bool
}

// readHeadWithFallback prefers the pure-filesystem HEAD read and falls back to
// `git rev-parse HEAD` inside the worktree, exactly like TS createAgentWorktree.
// ReadWorktreeHeadSha never fails (it degrades to "" like TS), so only the
// subprocess fallback can error — with the Node-shaped exec message TS renders.
func readHeadWithFallback(ctx context.Context, worktreePath string) (string, error) {
	if head := ReadWorktreeHeadSha(worktreePath); head != "" {
		return head, nil
	}
	stdout, stderr, code := runGit(ctx, worktreePath, "rev-parse", "HEAD")
	if code != 0 {
		return "", commandFailed([]string{"rev-parse", "HEAD"}, stderr)
	}
	return trimNewline(stdout), nil
}

// getOrCreateWorktree creates a new git worktree for the given slug under
// <repoRoot>/.yukino/worktrees/, or resumes it if it already exists (TS:
// createAgentWorktree).
//
// Fast-resume path: an existing worktree dir is first validated with `git rev-parse
// --show-toplevel` plus a realpath comparison — a plain directory occupying the path is rejected
// instead of being mistaken for a worktree (git otherwise searches parent directories and could
// report the main repository's HEAD as an isolated worktree).
//
// Create path: if the branch worktree-<slug> already exists (e.g. an orphan left behind by a
// removed worktree dir), reattach it at its existing tip — never reset it, so unmerged commits on
// a residual branch are preserved. Otherwise create it off the repository's current HEAD (TS runs
// `git worktree add -b <branch> -- <dir>` with no base argument).
//
// `-b` (lowercase, not `-B`): refuses a branch created concurrently instead of resetting its
// commits; `-B` would silently discard unmerged work on any same-named branch.
func getOrCreateWorktree(ctx context.Context, repoRoot, slug string) (*CreateResult, error) {
	worktreePath := WorktreePathFor(repoRoot, slug)
	worktreeBranch := WorktreeBranchName(slug)

	// Validate the existing root before restoration: git otherwise searches parent directories
	// and could report the main repository's HEAD as an isolated worktree.
	if pathExists(worktreePath) {
		stdout, stderr, code := runGit(ctx, worktreePath, "rev-parse", "--show-toplevel")
		if code != 0 {
			return nil, commandFailed([]string{"rev-parse", "--show-toplevel"}, stderr)
		}
		topLevel, err := filepath.EvalSymlinks(trimNewline(stdout))
		if err != nil {
			return nil, fmt.Errorf("Existing directory is not a worktree root: %s", worktreePath)
		}
		resolvedWorktreePath, err := filepath.EvalSymlinks(worktreePath)
		if err != nil || topLevel != resolvedWorktreePath {
			return nil, fmt.Errorf("Existing directory is not a worktree root: %s", worktreePath)
		}

		head, err := readHeadWithFallback(ctx, worktreePath)
		if err != nil {
			return nil, err
		}
		return &CreateResult{
			WorktreePath:   worktreePath,
			WorktreeBranch: worktreeBranch,
			HeadCommit:     head,
			Existed:        true,
		}, nil
	}

	// Reattach residual branches at their existing tip. Creating with -b also
	// refuses a branch created concurrently instead of resetting its commits
	// (TS: `git branch --list` decides between reattach and fresh create). Go
	// answers the question from the filesystem instead of a git subprocess; if
	// the git dir is unreadable, proceed as if the branch were absent — the
	// worktree add below then fails with the same Node-shaped error TS's
	// branch-list subprocess failure would have produced.
	var branchExists bool
	if gitDir, err := ResolveGitDir(repoRoot); err == nil && gitDir != "" {
		branchExists = ResolveRef(gitDir, "refs/heads/"+worktreeBranch) != ""
	}

	var addArgs []string
	if branchExists {
		addArgs = []string{"worktree", "add", "--", worktreePath, worktreeBranch}
	} else {
		addArgs = []string{"worktree", "add", "-b", worktreeBranch, "--", worktreePath}
	}
	if _, stderr, code := runGit(ctx, repoRoot, addArgs...); code != 0 {
		return nil, commandFailed(addArgs, stderr)
	}

	performPostCreationSetup(ctx, repoRoot, worktreePath)

	// Prefer filesystem read for HEAD in newly created worktrees.
	head, err := readHeadWithFallback(ctx, worktreePath)
	if err != nil {
		return nil, err
	}
	return &CreateResult{
		WorktreePath:   worktreePath,
		WorktreeBranch: worktreeBranch,
		HeadCommit:     head,
		Existed:        false,
	}, nil
}

// trimNewline strips trailing CR/LF; equivalent to .trim on a single-line command stdout. Kept
// local to avoid importing strings just for this.
func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}
