package main

import (
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
)

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	fn()
	w.Close()
	os.Stdout = old
	data, _ := io.ReadAll(r)
	return string(data)
}

func decodeLine(t *testing.T, out string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &m); err != nil {
		t.Fatalf("invalid JSON line %q: %v", out, err)
	}
	return m
}

func TestEmitStreamJSONContract(t *testing.T) {
	out := captureStdout(t, func() { emitStreamJSON(agent.StreamText{Text: "hello"}) })
	if m := decodeLine(t, out); m["type"] != "stream_text" || m["text"] != "hello" {
		t.Errorf("stream_text: %v", m)
	}

	out = captureStdout(t, func() { emitStreamJSON(agent.ThinkingText{Text: "think"}) })
	if m := decodeLine(t, out); m["type"] != "thinking_text" || m["text"] != "think" {
		t.Errorf("thinking_text: %v", m)
	}

	out = captureStdout(t, func() { emitStreamJSON(agent.TurnComplete{Turn: 5}) })
	if m := decodeLine(t, out); m["type"] != "turn_complete" || len(m) != 1 {
		t.Errorf("turn_complete must carry no turn counter: %v", m)
	}

	out = captureStdout(t, func() { emitStreamJSON(agent.LoopComplete{StopReason: "end_turn"}) })
	if m := decodeLine(t, out); m["type"] != "loop_complete" || m["stopReason"] != "end_turn" {
		t.Errorf("loop_complete: %v", m)
	}

	out = captureStdout(t, func() {
		emitStreamJSON(agent.UsageEvent{InputTokens: 1, OutputTokens: 2, CacheReadTokens: 3, CacheCreationTokens: 4})
	})
	m := decodeLine(t, out)
	for k, want := range map[string]float64{"input_tokens": 1, "output_tokens": 2, "cache_read_input_tokens": 3, "cache_creation_input_tokens": 4} {
		if m[k] != want {
			t.Errorf("usage field %s = %v, want %v", k, m[k], want)
		}
	}

	out = captureStdout(t, func() { emitStreamJSON(agent.RetryEvent{Reason: "rate", Wait: 1500 * time.Millisecond}) })
	if m := decodeLine(t, out); m["type"] != "retry" || m["reason"] != "rate" || m["delay"] != float64(1500) {
		t.Errorf("retry: %v", m)
	}

	out = captureStdout(t, func() {
		emitStreamJSON(agent.ToolResultEvent{ToolName: "Bash", ToolID: "t1", Output: "ok", IsError: false, Elapsed: 2 * time.Second})
	})
	m = decodeLine(t, out)
	if m["type"] != "tool_result" || m["tool_name"] != "Bash" || m["elapsed"] != float64(2) {
		t.Errorf("tool_result: %v", m)
	}
}

func TestPrintResultLineShape(t *testing.T) {
	res := printResult{
		Type:       "result",
		Result:     "done",
		DurationMs: 42,
		NumTurns:   2,
		ToolCalls:  []*toolCallInfo{{Tool: "Bash", ToolID: "t1", Elapsed: 1.5}},
		Usage:      resultUsage{InputTokens: 10, OutputTokens: 20, CacheReadInputTokens: 30, CacheCreationInputTokens: 40},
	}
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["stop_reason"]; ok {
		t.Errorf("result line must not carry stop_reason: %s", data)
	}
	usage, _ := m["usage"].(map[string]any)
	for _, k := range []string{"inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"} {
		if _, ok := usage[k]; !ok {
			t.Errorf("result usage missing camelCase key %s: %s", k, data)
		}
	}
	calls, _ := m["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls = %v", m["tool_calls"])
	}
	call := calls[0].(map[string]any)
	for _, k := range []string{"tool", "tool_id", "elapsed"} {
		if _, ok := call[k]; !ok {
			t.Errorf("tool_calls entry missing %s: %s", k, data)
		}
	}
}
