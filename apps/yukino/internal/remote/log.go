package remote

import (
	"fmt"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/logger"
)

var eventLog = logger.CreateChildLogger("remote")

func preview(text string) string {
	if len(text) <= TextPreviewChars {
		return text
	}
	return fmt.Sprintf("%s… (+%d chars)", text[:TextPreviewChars], len(text)-TextPreviewChars)
}

// AgentEventLogger logs noteworthy AgentEvents as structured lines: failed
// tool results and compact/retry (degraded service) at warn, agent errors at
// error. Routine progress events are dropped.
type AgentEventLogger struct{}

func (AgentEventLogger) OnEvent(ev agent.AgentEvent) {
	switch event := ev.(type) {
	case agent.ToolResultEvent:
		if !event.IsError {
			return
		}
		eventLog.Warn(map[string]any{
			"event":       "tool_result",
			"tool":        event.ToolName,
			"toolId":      event.ToolID,
			"isError":     true,
			"elapsedMs":   event.Elapsed.Milliseconds(),
			"outputChars": len(event.Output),
			"output":      preview(event.Output),
		}, "agent event")
	case agent.RetryEvent:
		eventLog.Warn(map[string]any{"event": "retry", "reason": event.Reason, "delayMs": event.Wait.Milliseconds()}, "agent event")
	case agent.CompactEvent:
		eventLog.Warn(map[string]any{"event": "compact", "message": event.Message}, "agent event")
	case agent.ErrorEvent:
		eventLog.Error(map[string]any{"event": "error", "err": event.Message}, "agent event")
	}
}
