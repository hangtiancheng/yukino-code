package userbash

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tool_result"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

// ParseCommand parses the terminal/remote "!" user-Bash prefix.
func ParseCommand(text string) (command string, excludeFromContext bool, ok bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, conversation.UserBashPrefix) {
		return "", false, false
	}
	excludeFromContext = strings.HasPrefix(trimmed, conversation.UserBashExcludedPrefix)
	prefixLength := len(conversation.UserBashPrefix)
	if excludeFromContext {
		prefixLength = len(conversation.UserBashExcludedPrefix)
	}
	return strings.TrimSpace(trimmed[prefixLength:]), excludeFromContext, true
}

// Execute runs a user command through the Bash tool and truncates large output
// to a private spill file.
func Execute(ctx context.Context, tool *tools.BashTool, command string, excludeFromContext bool) tools.ToolResult {
	if excludeFromContext {
		execution, _ := tools.RuntimeContext(ctx)
		execution.DisableBackground = true
		execution.ShellTimeoutDisabled = true
		ctx = tools.WithExecutionContext(ctx, execution)
	}
	result := tool.Execute(ctx, map[string]any{"command": command})
	output := utils.PlainTerminalText(result.Output)
	bytes := []byte(output)
	if len(bytes) <= conversation.UserBashInlineOutputBytes && len(strings.Split(output, "\n")) <= conversation.UserBashInlineOutputLines {
		result.Output = output
		return result
	}
	dir := os.TempDir()
	if execution, ok := tools.RuntimeContext(ctx); ok && execution.SessionID != "" {
		if spill, err := tool_result.SpillDir(execution.SessionID); err == nil {
			dir = spill
		}
	}
	path := filepath.Join(dir, "user-bash-"+uuid.NewString()+".txt")
	start := max(0, len(bytes)-conversation.UserBashInlineOutputBytes)
	for start < len(bytes) && bytes[start]&0xc0 == 0x80 {
		start++
	}
	lines := strings.Split(string(bytes[start:]), "\n")
	if len(lines) > conversation.UserBashInlineOutputLines {
		lines = lines[len(lines)-conversation.UserBashInlineOutputLines:]
	}
	tail := strings.Join(lines, "\n")
	if err := storage.WritePrivateFileSync(path, []byte(output), os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return tools.ToolResult{
			Output:  "[Output truncated; could not save full output: " + utils.AsErrorString(err) + "]\n" + tail,
			IsError: true,
		}
	}
	result.Output = "[Output truncated; showing tail. Full output: " + path + "]\n" + tail
	return result
}
