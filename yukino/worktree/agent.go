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
	"errors"
	"os"
)

// AgentWorktreeResult holds the result of CreateAgentWorktree.
type AgentWorktreeResult struct {
	WorktreePath   string
	WorktreeBranch string
	HeadCommit     string
	GitRoot        string
}

// CreateAgentWorktree creates a lightweight worktree for a sub-agent (TS:
// createAgentWorktree). workDir locates the enclosing git repository the same
// way TS's `git rev-parse --show-toplevel` uses the process cwd; an empty
// value falls back to the process cwd.
func CreateAgentWorktree(ctx context.Context, workDir, slug string) (*AgentWorktreeResult, error) {
	if err := ValidateWorktreeSlug(slug); err != nil {
		return nil, err
	}

	base := workDir
	if base == "" {
		base, _ = os.Getwd()
	}
	// TS resolves the repository root with `git rev-parse --show-toplevel`
	// (no explicit cwd — the CLI's process cwd). Inside a worktree that
	// reports the worktree's own top level, so nested worktrees stay nested.
	// Failures propagate as the raw Node exec error (TS createAgentWorktree
	// has no catch), so enter-worktree renders `Command failed: …`.
	stdout, stderr, code := runGit(ctx, base, "rev-parse", "--show-toplevel")
	if code != 0 {
		return nil, commandFailed([]string{"rev-parse", "--show-toplevel"}, stderr)
	}
	gitRoot := trimNewline(stdout)

	result, err := getOrCreateWorktree(ctx, gitRoot, slug)
	if err != nil {
		return nil, err
	}

	return &AgentWorktreeResult{
		WorktreePath:   result.WorktreePath,
		WorktreeBranch: result.WorktreeBranch,
		HeadCommit:     result.HeadCommit,
		GitRoot:        gitRoot,
	}, nil
}

// RemoveAgentWorktree removes a worktree created by CreateAgentWorktree (TS:
// removeAgentWorktree).
//
// No --force: git rechecks for dirty/locked worktrees at removal time and refuses to destroy
// uncommitted work; if removal fails, stop here. `branch -d` (lowercase) likewise refuses to
// delete a branch with unmerged commits, leaving its tip intact. Both steps surface their
// failures as errors (TS awaits both execFile calls, and exit-worktree renders the thrown
// error through asErrorString).
func RemoveAgentWorktree(ctx context.Context, worktreePath, worktreeBranch, gitRoot string) error {
	if gitRoot == "" {
		return errors.New("git root not resolved")
	}

	if _, stderr, code := runGit(ctx, gitRoot, "worktree", "remove", "--", worktreePath); code != 0 {
		return commandFailed([]string{"worktree", "remove", "--", worktreePath}, stderr)
	}

	if worktreeBranch != "" {
		if _, stderr, code := runGit(ctx, gitRoot, "branch", "-d", "--", worktreeBranch); code != 0 {
			return commandFailed([]string{"branch", "-d", "--", worktreeBranch}, stderr)
		}
	}
	return nil
}
