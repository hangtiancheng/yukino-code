package tools

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/worktree"
)

type EnterWorktreeTool struct{}

func (t *EnterWorktreeTool) Name() string           { return "EnterWorktree" }
func (t *EnterWorktreeTool) Category() ToolCategory { return CategoryWrite }
func (t *EnterWorktreeTool) Description() string    { return EnterWorktreeDescription }
func (t *EnterWorktreeTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{
		"type": "object", "properties": map[string]any{"slug": map[string]any{"type": "string", "description": WorktreeSlugDescription}}, "additionalProperties": false,
	}}
}
func (t *EnterWorktreeTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	for key := range args {
		if key != "slug" {
			return ToolResult{Output: "Error: unrecognized key: " + key, IsError: true}
		}
	}
	slug := uuid.NewString()
	if value, exists := args["slug"]; exists {
		text, ok := value.(string)
		if !ok || !worktree.WorktreeSlugPattern.MatchString(text) {
			return ToolResult{Output: SlugInvalidError, IsError: true}
		}
		slug = text
	}
	runtime, _ := RuntimeContext(ctx)
	if runtime.Worktrees == nil {
		return ToolResult{Output: WorktreeRuntimeRequiredError, IsError: true}
	}
	if runtime.Worktrees.WorktreeSession() != nil {
		return ToolResult{Output: worktree.WorktreeAlreadyActiveError, IsError: true}
	}
	cwd := workingDirectory(ctx)
	wt, err := worktree.CreateAgentWorktree(ctx, slug, "", cwd)
	if err == nil {
		err = runtime.Worktrees.EnterWorktree(ctx, *wt, cwd)
	}
	if err != nil {
		log.Error(map[string]any{"err": err}, "tool operation failed")
		return ToolResult{Output: "Error creating worktree: " + err.Error(), IsError: true}
	}
	if runtime.FileStateCache != nil {
		runtime.FileStateCache.Clear()
	}
	return ToolResult{Output: fmt.Sprintf("Entered worktree at %s\nBranch: %s\nHead: %s\nThe session is now working in the worktree. Use ExitWorktree with action: \"keep\" or \"remove\" to return to %s.", wt.WorktreePath, wt.WorktreeBranch, wt.HeadCommit, cwd)}
}
