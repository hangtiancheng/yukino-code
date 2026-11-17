package conversation

func EnsureToolPairing(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for i := 0; i < len(messages); i++ {
		m := messages[i]
		if m.Role == "assistant" && len(m.ToolUses) > 0 {
			out = append(out, m)
			pending := make(map[string]bool, len(m.ToolUses))
			for _, use := range m.ToolUses {
				pending[use.ToolUseID] = true
			}
			var results []ToolResultBlock
			var groups []Message
			for i+1 < len(messages) {
				next := messages[i+1]
				if next.Role != "user" || len(next.ToolResults) == 0 || len(next.ToolUses) > 0 {
					break
				}
				i++
				groups = append(groups, next)
				for _, result := range next.ToolResults {
					if pending[result.ToolUseID] {
						results = append(results, result)
						delete(pending, result.ToolUseID)
					}
				}
			}
			for _, use := range m.ToolUses {
				if pending[use.ToolUseID] {
					results = append(results, ToolResultBlock{ToolUseID: use.ToolUseID, Content: InterruptedToolResult, IsError: true})
					delete(pending, use.ToolUseID)
				}
			}
			merged := Message{Role: "user"}
			if len(groups) > 0 {
				merged = groups[0]
			}
			merged.ToolResults = results
			out = append(out, merged)
			if len(groups) > 1 {
				for _, remaining := range groups[1:] {
					if remaining.HasContent() || len(remaining.ThinkingBlocks) > 0 {
						remaining.ToolResults = nil
						out = append(out, remaining)
					}
				}
			}
			continue
		}
		if len(m.ToolResults) > 0 {
			if !m.HasContent() && len(m.ToolUses) == 0 && len(m.ThinkingBlocks) == 0 {
				continue
			}
			m.ToolResults = nil
		}
		out = append(out, m)
	}
	return out
}
