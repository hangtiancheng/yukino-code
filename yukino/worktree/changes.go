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
	"strings"
)

// HasWorktreeChanges returns true if the worktree has uncommitted changes or its HEAD moved away
// from headCommit — in any direction. Comparing SHAs (instead of counting commits in
// headCommit..HEAD) also catches resets to an ancestor and checkouts of older commits, which
// would otherwise be silently reported as "no changes" and destroyed on cleanup.
// Returns true on git failure (fail-closed), logging like TS's single catch around
// the whole function (worktree/index.ts:395-424).
func HasWorktreeChanges(ctx context.Context, worktreePath, headCommit string) bool {
	stdout, stderr, code := runGit(ctx, worktreePath, "status", "--porcelain")
	if code != 0 {
		log.Error("worktree operation failed", "err", commandFailed([]string{"status", "--porcelain"}, stderr))
		return true // fail-closed
	}
	if strings.TrimSpace(stdout) != "" {
		return true
	}

	// Compare HEAD SHA: prefer pure filesystem read, fall back to git subprocess.
	currentHead := ReadWorktreeHeadSha(worktreePath)
	if currentHead == "" {
		stdout, stderr, code = runGit(ctx, worktreePath, "rev-parse", "HEAD")
		if code != 0 {
			log.Error("worktree operation failed", "err", commandFailed([]string{"rev-parse", "HEAD"}, stderr))
			return true // fail-closed
		}
		currentHead = trimNewline(stdout)
	}
	return currentHead != headCommit
}
