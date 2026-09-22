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
	"strings"
	"testing"
)

func TestValidateWorktreeSlug_Valid(t *testing.T) {
	cases := []string{
		"a",
		"my-feature",
		"agent-a1234567",
		"wf_12345678-abc-1",
	}
	for _, slug := range cases {
		if err := ValidateWorktreeSlug(slug); err != nil {
			t.Errorf("ValidateWorktreeSlug(%q) = %v, want nil", slug, err)
		}
	}
}

func TestValidateWorktreeSlug_Invalid(t *testing.T) {
	// TS createAgentWorktree rejects everything outside ^[a-zA-Z0-9_-]+$ with
	// one fixed message — including dots and nested slugs.
	cases := []string{
		"",
		"v1.0",
		"v1.0.0-rc1",
		"team-refactor/alice",
		".",
		"..",
		"/leading-slash",
		"trailing-slash/",
		"foo bar",
		"foo$bar",
		"foo+bar",
	}
	const wantMsg = "Invalid worktree slug: use only alphanumeric, hyphen, underscore"
	for _, slug := range cases {
		err := ValidateWorktreeSlug(slug)
		if err == nil {
			t.Errorf("ValidateWorktreeSlug(%q) = nil, want error %q", slug, wantMsg)
			continue
		}
		if !strings.Contains(err.Error(), wantMsg) {
			t.Errorf("ValidateWorktreeSlug(%q) = %v, want error containing %q", slug, err, wantMsg)
		}
	}
}

func TestWorktreeBranchName(t *testing.T) {
	cases := map[string]string{
		"my-feature":     "worktree-my-feature",
		"agent-a1234567": "worktree-agent-a1234567",
	}
	for in, want := range cases {
		if got := WorktreeBranchName(in); got != want {
			t.Errorf("WorktreeBranchName(%q) = %q, want %q", in, got, want)
		}
	}
}
