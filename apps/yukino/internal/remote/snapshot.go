package remote

import (
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func (s *Server) bootstrapMessages() []wsMessage {
	messages := []wsMessage{}
	if s.ag != nil {
		messages = append(messages, wsMessage{Type: "connected", Data: map[string]any{"session": s.sessionID, "cwd": mustGetwd(), "streaming": s.isStreaming()}})
		if status, ok := s.statusSnapshot(); ok {
			messages = append(messages, status)
		}
	}
	messages = append(messages, wsMessage{Type: "commands", Data: s.commandList()})
	entries, _ := history.LoadInputTexts()
	if len(entries) > InputHistoryLimit {
		entries = entries[len(entries)-InputHistoryLimit:]
	}
	if entries == nil {
		entries = []string{}
	}
	messages = append(messages, wsMessage{Type: "history", Data: map[string]any{"entries": entries}})
	if s.ag != nil {
		messages = append(messages, wsMessage{Type: "usage", Data: s.usageSnapshot()})
	}
	if s.mcpApps != nil {
		for _, payload := range s.mcpApps.Entries() {
			messages = append(messages, wsMessage{Type: "tool_result", Data: payload})
		}
	}
	if len(s.providers) == 0 {
		messages = append(messages, wsMessage{Type: "provider_list", Data: map[string]any{"providers": []any{}, "current": 0}})
	}
	return messages
}

func (s *Server) disposeSandbox() {
	if s.registry != nil {
		if bash, ok := s.registry.Get("Bash").(*tools.BashTool); ok {
			bash.Sandbox = nil
			bash.SandboxRequired = false
		}
	}
	s.sandboxRuntime.Reset()
}
