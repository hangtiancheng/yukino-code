package llm

import (
	"encoding/json"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/telemetry"
)

type StreamEvent interface{ streamEvent() }

type TextDelta struct{ Text string }
type ThinkingDelta struct{ Text string }
type ThinkingComplete struct {
	Thinking  string
	Signature string
}
type RedactedThinkingComplete struct{ Data string }
type ToolCallStart struct{ ToolName, ToolID string }
type ToolCallDelta struct{ Text string }
type ToolCallComplete struct {
	ToolID    string
	ToolName  string
	Arguments map[string]any
	// Marks malformed non-empty JSON so the executor can pair an error result
	// without invoking the tool with an invented empty object.
	ParseError     string
	ProviderItemID string
}
type UsageInfo struct {
	InputTokens         int
	OutputTokens        int
	CacheReadTokens     int
	CacheCreationTokens int
}

type StreamEnd struct {
	StopReason string
	Usage      UsageInfo
}

func (TextDelta) streamEvent() {}

func (ThinkingDelta) streamEvent() {}

func (ThinkingComplete) streamEvent() {}

func (RedactedThinkingComplete) streamEvent() {}

func (ToolCallStart) streamEvent() {}
func (ToolCallDelta) streamEvent() {}

func (ToolCallComplete) streamEvent() {}

func (StreamEnd) streamEvent() {}

// TelemetryStreamEnd exposes the completion usage and stop reason to the
// telemetry observation wrapper without telemetry importing this package.
func (e StreamEnd) TelemetryStreamEnd() (telemetry.Usage, string) {
	return telemetry.Usage{
		InputTokens:         e.Usage.InputTokens,
		OutputTokens:        e.Usage.OutputTokens,
		CacheReadTokens:     e.Usage.CacheReadTokens,
		CacheCreationTokens: e.Usage.CacheCreationTokens,
	}, e.StopReason
}

func ParseToolArguments(raw string) (map[string]any, string) {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}, ""
	}
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return map[string]any{}, "Invalid tool arguments JSON: " + err.Error()
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return map[string]any{}, "Invalid tool arguments: expected a JSON object"
	}
	return obj, ""
}
