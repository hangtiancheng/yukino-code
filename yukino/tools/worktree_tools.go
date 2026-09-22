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

package tools

import (
	"context"
	"fmt"
	"regexp"

	"github.com/hangtiancheng/yukino-code/yukino/utils"
	"github.com/hangtiancheng/yukino-code/yukino/worktree"
)

var worktreeSlugPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// EnterWorktreeTool creates a git worktree for isolated work.
type EnterWorktreeTool struct{}

func (t *EnterWorktreeTool) Name() string { return "EnterWorktree" }

func (t *EnterWorktreeTool) Description() string {
	return "Create and enter a git worktree for isolated work."
}

func (t *EnterWorktreeTool) Category() ToolCategory { return CategoryWrite }

func (t *EnterWorktreeTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"slug": map[string]any{
					"type":        "string",
					"description": "Short identifier for the worktree (branch name suffix).",
				},
			},
			"required": []string{"slug"},
		},
	}
}

func (t *EnterWorktreeTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	slug, _ := args["slug"].(string)
	if slug == "" {
		return ToolResult{Output: "Error: slug is required", IsError: true}
	}
	if !worktreeSlugPattern.MatchString(slug) {
		return ToolResult{Output: "Error: slug must contain only alphanumeric, hyphen, underscore", IsError: true}
	}

	result, err := worktree.CreateAgentWorktree(ctx, WorkDirFromContext(ctx), slug)
	if err != nil {
		log.Error("tool operation failed", "err", err)
		return ToolResult{Output: fmt.Sprintf("Error creating worktree: %s", err), IsError: true}
	}
	return ToolResult{Output: fmt.Sprintf(
		"Worktree created at %s\nBranch: %s\nHead: %s",
		result.WorktreePath, result.WorktreeBranch, result.HeadCommit,
	)}
}

// ExitWorktreeTool exits and optionally cleans up a git worktree.
type ExitWorktreeTool struct{}

func (t *ExitWorktreeTool) Name() string { return "ExitWorktree" }

func (t *ExitWorktreeTool) Description() string {
	return "Exit and optionally cleanup a git worktree"
}

func (t *ExitWorktreeTool) Category() ToolCategory { return CategoryWrite }

func (t *ExitWorktreeTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "Worktree path"},
				"branch": map[string]any{"type": "string", "description": "Worktree branch name"},
				"git_root": map[string]any{
					"type":        "string",
					"description": "Git root directory",
				},
				"head_commit": map[string]any{
					"type":        "string",
					"description": "Original HEAD commit for change detection",
				},
			},
			"required": []string{"path", "branch", "git_root"},
		},
	}
}

func (t *ExitWorktreeTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	path, _ := args["path"].(string)
	branch, _ := args["branch"].(string)
	gitRoot, _ := args["git_root"].(string)
	headCommit, _ := args["head_commit"].(string)

	if path == "" || branch == "" || gitRoot == "" {
		return ToolResult{Output: "Error: path, branch and git_root are required", IsError: true}
	}

	if headCommit == "" {
		return ToolResult{Output: fmt.Sprintf(
			"Original head_commit was not provided; worktree kept at: %s\nBranch: %s",
			path, branch,
		)}
	}

	if worktree.HasWorktreeChanges(ctx, path, headCommit) {
		return ToolResult{Output: fmt.Sprintf(
			"Worktree has changes, kept at: %s\nBranch: %s",
			path, branch,
		)}
	}

	if err := worktree.RemoveAgentWorktree(ctx, path, branch, gitRoot); err != nil {
		log.Error("tool operation failed", "err", err)
		return ToolResult{Output: "Error cleaning up worktree: " + utils.AsErrorString(err), IsError: true}
	}
	return ToolResult{Output: fmt.Sprintf("Worktree cleaned up (no changes): %s", path)}
}
