package tools

import (
	"context"
	"fmt"
	"os"

	"github.com/yukino-js/yukino/yukino/internal/worktree"
)

type ExitWorktreeTool struct{}

func (t *ExitWorktreeTool) Name() string           { return "ExitWorktree" }
func (t *ExitWorktreeTool) Category() ToolCategory { return CategoryWrite }
func (t *ExitWorktreeTool) Description() string    { return ExitWorktreeDescription }
func (t *ExitWorktreeTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{
		"type": "object", "properties": map[string]any{
			"action":          map[string]any{"type": "string", "enum": []string{"keep", "remove"}, "description": WorktreeActionDescription},
			"discard_changes": map[string]any{"type": "boolean", "description": WorktreeDiscardChangesDescription},
		}, "required": []string{"action"}, "additionalProperties": false,
	}}
}
func (t *ExitWorktreeTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	for key := range args {
		if key != "action" && key != "discard_changes" {
			return ToolResult{Output: "Error: unrecognized key: " + key, IsError: true}
		}
	}
	action, _ := args["action"].(string)
	if action != "keep" && action != "remove" {
		return ToolResult{Output: `Error: action must be "keep" or "remove"`, IsError: true}
	}
	discard := false
	if value, exists := args["discard_changes"]; exists {
		flag, ok := value.(bool)
		if !ok {
			return ToolResult{Output: "Error: discard_changes must be a boolean", IsError: true}
		}
		discard = flag
	}
	runtime, _ := RuntimeContext(ctx)
	if runtime.Worktrees == nil {
		return ToolResult{Output: worktree.NoWorktreeSessionMessage, IsError: true}
	}
	session := runtime.Worktrees.WorktreeSession()
	if session == nil {
		return ToolResult{Output: worktree.NoWorktreeSessionMessage, IsError: true}
	}
	info, err := os.Stat(session.OriginalCwd)
	if err == nil && !info.IsDir() {
		err = fmt.Errorf("Original working directory is unavailable: %s", session.OriginalCwd)
	}
	var changes *worktree.ChangeSummary
	if err == nil && action == "remove" {
		changes, err = runtime.Worktrees.RemoveWorktree(ctx, session.WorktreePath, discard)
	}
	clearSession := func() {
		runtime.Worktrees.LeaveWorktree()
		if runtime.FileStateCache != nil {
			runtime.FileStateCache.Clear()
		}
	}
	if err != nil {
		log.Error(map[string]any{"err": err}, "tool operation failed")
		message := "Error exiting worktree: " + err.Error()
		if _, statErr := os.Stat(session.WorktreePath); os.IsNotExist(statErr) {
			clearSession()
			message += fmt.Sprintf(" The worktree directory no longer exists. Session restored to %s; the branch may remain.", session.OriginalCwd)
		}
		return ToolResult{Output: message, IsError: true}
	}
	clearSession()
	result := fmt.Sprintf("Your work is preserved at %s on branch %s.", session.WorktreePath, session.WorktreeBranch)
	if action == "remove" {
		result = fmt.Sprintf("Removed worktree at %s and branch %s.", session.WorktreePath, session.WorktreeBranch)
		if changes != nil {
			result += fmt.Sprintf(" Discarded %d uncommitted files and %d commits.", changes.ChangedFiles, changes.Commits)
		}
	}
	return ToolResult{Output: fmt.Sprintf("Exited worktree. %s Session is now back in %s.", result, session.OriginalCwd)}
}
