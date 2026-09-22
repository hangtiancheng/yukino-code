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

package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
)

func fakeAnthropicSSE(w http.ResponseWriter, r *http.Request) []byte {
	body, _ := io.ReadAll(r.Body)
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	io.WriteString(w, "event: message_start\n")
	io.WriteString(w, `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}`+"\n\n")
	io.WriteString(w, "event: content_block_start\n")
	io.WriteString(w, `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`+"\n\n")
	io.WriteString(w, "event: content_block_delta\n")
	io.WriteString(w, `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`+"\n\n")
	io.WriteString(w, "event: content_block_stop\n")
	io.WriteString(w, `data: {"type":"content_block_stop","index":0}`+"\n\n")
	io.WriteString(w, "event: message_delta\n")
	io.WriteString(w, `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`+"\n\n")
	io.WriteString(w, "event: message_stop\n")
	io.WriteString(w, `data: {"type":"message_stop"}`+"\n\n")
	return body
}

func drainStream(client Client, conv *conversation.Manager) {
	events, errs := client.Stream(context.Background(), conv, nil)
	for range events {
	}
	select {
	case <-errs:
	default:
	}
}

func TestAnthropicThinkingAdaptive(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
		Thinking: config.ThinkingHigh, ThinkingMode: "adaptive",
	}, "test system prompt")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	thinking, ok := captured["thinking"].(map[string]any)
	if !ok {
		t.Fatal("thinking field missing from request")
	}
	if thinking["type"] != "adaptive" {
		t.Errorf("thinking.type = %q, want \"adaptive\"", thinking["type"])
	}
	if _, hasBudget := thinking["budget_tokens"]; hasBudget {
		t.Error("adaptive mode should not have budget_tokens")
	}
	outputConfig, ok := captured["output_config"].(map[string]any)
	if !ok {
		t.Fatalf("output_config missing from request: %v", captured)
	}
	if outputConfig["effort"] != "high" {
		t.Errorf("output_config.effort = %v, want \"high\"", outputConfig["effort"])
	}
}

func TestAnthropicThinkingAdaptiveNarrowing(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	// minimal maps down to low and xhigh maps down to high in adaptive mode
	// (TS toReasoningEffort narrowing).
	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
		Thinking: config.ThinkingXHigh, ThinkingMode: "adaptive",
	}, "test system prompt")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	outputConfig, _ := captured["output_config"].(map[string]any)
	if outputConfig == nil || outputConfig["effort"] != "high" {
		t.Errorf("xhigh must narrow to high in adaptive mode, got %v", outputConfig)
	}
}

func TestAnthropicThinkingEnabled(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "glm-4.7",
		Thinking: config.ThinkingHigh,
	}, "test system prompt")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	thinking, ok := captured["thinking"].(map[string]any)
	if !ok {
		t.Fatal("thinking field missing from request")
	}
	if thinking["type"] != "enabled" {
		t.Errorf("thinking.type = %q, want \"enabled\"", thinking["type"])
	}
	// budget = min(THINKING_BUDGETS[high]=16384, maxOutput-1024)
	budget, _ := thinking["budget_tokens"].(float64)
	if budget != 16384 {
		t.Errorf("budget_tokens = %v, want 16384", budget)
	}
	maxTokens, _ := captured["max_tokens"].(float64)
	if maxTokens != 128000 {
		t.Errorf("max_tokens = %v, want 128000 (default cap)", maxTokens)
	}
}

func TestAnthropicThinkingBudgetClampedByOutputCeiling(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "glm-4.7",
		Thinking: config.ThinkingMax, MaxOutputTokens: 10000,
	}, "test system prompt")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	thinking, _ := captured["thinking"].(map[string]any)
	budget, _ := thinking["budget_tokens"].(float64)
	// min(65536, 10000-1024) = 8976
	if budget != 8976 {
		t.Errorf("budget_tokens = %v, want 8976 (clamped to ceiling minus answer room)", budget)
	}
}

func TestAnthropicThinkingDisabled(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
		Thinking: config.ThinkingOff,
	}, "test system prompt")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	// Off sends an explicit disabled config (TS: thinking = {type:"disabled"}).
	thinking, ok := captured["thinking"].(map[string]any)
	if !ok {
		t.Fatal("thinking field missing from request")
	}
	if thinking["type"] != "disabled" {
		t.Errorf("thinking.type = %q, want \"disabled\"", thinking["type"])
	}
}

func TestAnthropicReasoningFalseOmitsThinking(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	reasoning := false
	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
		Thinking: config.ThinkingHigh, Reasoning: &reasoning,
	}, "test system prompt")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	if _, ok := captured["thinking"]; ok {
		t.Error("reasoning:false must omit the thinking field entirely")
	}
}

func TestAnthropicThinkingBlocksInConversation(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
		Thinking: config.ThinkingHigh,
	}, "test system prompt")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	conv.AddAssistantFull("hi there", []conversation.ThinkingBlock{
		{Thinking: "let me think about this", Signature: "sig123"},
	}, nil)
	conv.AddUserMessage("thanks")
	drainStream(client, conv)

	messages, _ := captured["messages"].([]any)
	if len(messages) < 2 {
		t.Fatalf("expected at least 2 messages, got %d", len(messages))
	}

	assistantMsg, _ := messages[1].(map[string]any)
	content, _ := assistantMsg["content"].([]any)

	foundThinking := false
	for _, block := range content {
		blockMap, _ := block.(map[string]any)
		if blockMap["type"] == "thinking" {
			foundThinking = true
			if blockMap["thinking"] != "let me think about this" {
				t.Errorf("thinking text = %q, want %q", blockMap["thinking"], "let me think about this")
			}
			if blockMap["signature"] != "sig123" {
				t.Errorf("signature = %q, want %q", blockMap["signature"], "sig123")
			}
		}
	}
	if !foundThinking {
		body, _ := json.MarshalIndent(captured, "", "  ")
		t.Fatalf("no thinking block found in assistant message.\nRequest body:\n%s", string(body))
	}
}

func fakeOpenAIResponsesSSE(w http.ResponseWriter, r *http.Request) []byte {
	body, _ := io.ReadAll(r.Body)
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	lines := []string{
		`data: {"type":"response.output_text.delta","delta":"hi"}`,
		`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`,
	}
	io.WriteString(w, strings.Join(lines, "\n\n")+"\n\n")
	return body
}

func TestOpenAIThinkingEnabled(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeOpenAIResponsesSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	cfg := &config.ProviderConfig{
		Protocol: "openai",
		BaseURL:  srv.URL,
		APIKey:   "test-key",
		Model:    "o3",
		Thinking: config.ThinkingHigh,
	}
	client, err := newOpenAIClient(cfg, "test system prompt")
	if err != nil {
		t.Fatal(err)
	}

	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	reasoningMap, ok := captured["reasoning"].(map[string]any)
	if !ok {
		body, _ := json.MarshalIndent(captured, "", "  ")
		t.Fatalf("reasoning field missing from API request.\nFull request body:\n%s", string(body))
	}
	if effort, _ := reasoningMap["effort"].(string); effort != "high" {
		t.Errorf("reasoning.effort = %q, want \"high\"", effort)
	}
	if summary, _ := reasoningMap["summary"].(string); summary != "auto" {
		t.Errorf("reasoning.summary = %q, want \"auto\"", summary)
	}

	include, _ := captured["include"].([]any)
	foundEncrypted := false
	for _, v := range include {
		if v == "reasoning.encrypted_content" {
			foundEncrypted = true
		}
	}
	if !foundEncrypted {
		t.Errorf("include should contain reasoning.encrypted_content, got: %v", include)
	}
}

func TestOpenAIThinkingOffSendsNone(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeOpenAIResponsesSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	cfg := &config.ProviderConfig{
		Protocol: "openai",
		BaseURL:  srv.URL,
		APIKey:   "test-key",
		Model:    "gpt-4o",
		Thinking: config.ThinkingOff,
	}
	client, err := newOpenAIClient(cfg, "test system prompt")
	if err != nil {
		t.Fatal(err)
	}

	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	// Off explicitly disables server-default reasoning (TS sends effort "none").
	reasoningMap, ok := captured["reasoning"].(map[string]any)
	if !ok {
		t.Fatalf("reasoning field missing: %v", captured)
	}
	if effort, _ := reasoningMap["effort"].(string); effort != "none" {
		t.Errorf("reasoning.effort = %q, want \"none\"", effort)
	}
	if _, hasSummary := reasoningMap["summary"]; hasSummary {
		t.Error("summary must not be requested while reasoning is off")
	}
	if _, hasInclude := captured["include"]; hasInclude {
		t.Error("include must not be set while reasoning is off")
	}
}

func TestOpenAIReasoningFalseOmitsReasoning(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeOpenAIResponsesSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	reasoning := false
	cfg := &config.ProviderConfig{
		Protocol: "openai", BaseURL: srv.URL, APIKey: "test-key", Model: "gpt-4o",
		Thinking: config.ThinkingHigh, Reasoning: &reasoning,
	}
	client, err := newOpenAIClient(cfg, "test system prompt")
	if err != nil {
		t.Fatal(err)
	}
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	drainStream(client, conv)

	if _, ok := captured["reasoning"]; ok {
		t.Error("reasoning:false must omit the reasoning field entirely")
	}
}

func TestClientThinkingLevelControl(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fakeAnthropicSSE(w, r)
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
		Thinking: config.ThinkingMedium,
	}, "")
	if got := client.GetThinkingLevel(); got != config.ThinkingMedium {
		t.Fatalf("initial level = %q, want medium", got)
	}
	if got := client.SetThinkingLevel(config.ThinkingMax); got != config.ThinkingMax {
		t.Fatalf("SetThinkingLevel(max) = %q, want max", got)
	}
	supported := client.GetSupportedThinkingLevels()
	if len(supported) == 0 {
		t.Fatal("supported levels must not be empty")
	}

	// reasoning:false clamps every request down to off.
	reasoning := false
	limited, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
		Thinking: config.ThinkingHigh, Reasoning: &reasoning,
	}, "")
	if got := limited.GetThinkingLevel(); got != config.ThinkingOff {
		t.Fatalf("reasoning:false level = %q, want off", got)
	}
	if got := limited.SetThinkingLevel(config.ThinkingMax); got != config.ThinkingOff {
		t.Fatalf("reasoning:false SetThinkingLevel = %q, want off", got)
	}
}
