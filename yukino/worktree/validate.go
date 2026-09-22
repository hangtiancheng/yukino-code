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
	"fmt"
	"regexp"
)

// validWorktreeSlug mirrors the TS createAgentWorktree slug check: a flat
// alphanumeric/hyphen/underscore name — no dots, no nesting.
var validWorktreeSlug = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// ValidateWorktreeSlug validates a worktree slug to prevent path traversal and
// directory escape (TS: the createAgentWorktree slug guard).
func ValidateWorktreeSlug(slug string) error {
	if !validWorktreeSlug.MatchString(slug) {
		return fmt.Errorf("Invalid worktree slug: use only alphanumeric, hyphen, underscore")
	}
	return nil
}

// WorktreeBranchName returns the git branch name for the worktree associated
// with slug. Format: "worktree-<slug>" (TS: `worktree-${slug}`).
func WorktreeBranchName(slug string) string {
	return "worktree-" + slug
}
