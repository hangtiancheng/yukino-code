package memory

import "github.com/yukino-js/yukino/yukino/internal/conversation"

// ExtractWrittenPaths returns file_path arguments of successful WriteFile and
// EditFile calls. Only completed writes count as saved memories; assistant
// prose is not execution evidence.
func ExtractWrittenPaths(messages []conversation.Message) []string {
	successful := map[string]bool{}
	for _, message := range messages {
		for _, result := range message.ToolResults {
			if !result.IsError {
				successful[result.ToolUseID] = true
			}
		}
	}
	paths := []string{}
	seen := map[string]bool{}
	for _, message := range messages {
		for _, tool := range message.ToolUses {
			if tool.ToolName != "WriteFile" && tool.ToolName != "EditFile" {
				continue
			}
			if !successful[tool.ToolUseID] {
				continue
			}
			path, ok := tool.Arguments["file_path"].(string)
			if !ok {
				continue
			}
			if !seen[path] {
				seen[path] = true
				paths = append(paths, path)
			}
		}
	}
	return paths
}
