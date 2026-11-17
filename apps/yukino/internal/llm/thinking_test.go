package llm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

func testProvider(protocol, baseURL string, mutate func(*config.ProviderConfig)) *config.ProviderConfig {
	p := &config.ProviderConfig{
		Name:     "test",
		Protocol: protocol,
		BaseURL:  baseURL,
		APIKey:   "test",
		Model:    "arbitrary-model-name",
	}
	if mutate != nil {
		mutate(p)
	}
	return p
}

// captureServer exercises real SDK serialization at the HTTP boundary without
// calling a provider: it records every request payload and answers with
// terminal SSE events for the protocol.
type captureServer struct {
	srv      *httptest.Server
	protocol string
	mu       sync.Mutex
	payloads []map[string]any
}

func newCaptureServer(t *testing.T, protocol string) *captureServer {
	t.Helper()
	cs := &captureServer{protocol: protocol}
	cs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var captured map[string]any
		if err := json.Unmarshal(body, &captured); err != nil {
			t.Errorf("capture request body: %s", err)
		}
		cs.mu.Lock()
		cs.payloads = append(cs.payloads, captured)
		cs.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		switch protocol {
		case "anthropic":
			io.WriteString(w, "event: message_start\n")
			io.WriteString(w, `data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"test","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}`+"\n\n")
			io.WriteString(w, "event: message_delta\n")
			io.WriteString(w, `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`+"\n\n")
			io.WriteString(w, "event: message_stop\n")
			io.WriteString(w, `data: {"type":"message_stop"}`+"\n\n")
		case "openai":
			io.WriteString(w, "event: response.completed\n")
			io.WriteString(w, `data: {"type":"response.completed","sequence_number":0,"response":{"id":"resp_test","status":"completed"}}`+"\n\n")
		default:
			io.WriteString(w, `data: {"id":"chunk_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`+"\n\n")
			io.WriteString(w, "data: [DONE]\n\n")
		}
	}))
	t.Cleanup(cs.srv.Close)
	return cs
}

func (cs *captureServer) request(t *testing.T, client Client) {
	t.Helper()
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	events, errs := client.Stream(context.Background(), conv, nil)
	sawEnd := false
	for ev := range events {
		if _, ok := ev.(StreamEnd); ok {
			sawEnd = true
		}
	}
	select {
	case err := <-errs:
		if err != nil {
			t.Fatalf("stream error: %s", err)
		}
	default:
	}
	if !sawEnd {
		t.Fatal("no stream_end event")
	}
}

func (cs *captureServer) last(t *testing.T) map[string]any {
	t.Helper()
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if len(cs.payloads) == 0 {
		t.Fatal("no request captured")
	}
	return cs.payloads[len(cs.payloads)-1]
}

func TestAnthropicBudgetModeByDefault(t *testing.T) {
	for _, level := range config.ThinkingLevels {
		t.Run(level, func(t *testing.T) {
			cs := newCaptureServer(t, "anthropic")
			p := testProvider("anthropic", cs.srv.URL, func(p *config.ProviderConfig) {
				p.Thinking = level
			})
			client, err := newAnthropicClient(p, "system")
			if err != nil {
				t.Fatal(err)
			}
			cs.request(t, client)
			if client.GetThinkingLevel() != level {
				t.Fatalf("level = %s, want %s", client.GetThinkingLevel(), level)
			}
			payload := cs.last(t)
			thinking, _ := payload["thinking"].(map[string]any)
			if level == "off" {
				if thinking == nil || thinking["type"] != "disabled" {
					t.Fatalf("thinking = %v, want disabled", payload["thinking"])
				}
			} else {
				if thinking == nil || thinking["type"] != "enabled" {
					t.Fatalf("thinking = %v, want enabled", payload["thinking"])
				}
				if got := int(thinking["budget_tokens"].(float64)); got != config.ThinkingBudgetForLevel(level) {
					t.Fatalf("budget_tokens = %d, want %d", got, config.ThinkingBudgetForLevel(level))
				}
			}
			if got := int(payload["max_tokens"].(float64)); got != config.DefaultMaxOutputTokens {
				t.Fatalf("max_tokens = %d, want %d", got, config.DefaultMaxOutputTokens)
			}
			if _, ok := payload["output_config"]; ok {
				t.Fatal("budget mode must not send output_config")
			}
		})
	}
}

func TestAnthropicAdaptiveMode(t *testing.T) {
	cases := []struct {
		level  string
		effort string
	}{
		{"off", ""},
		{"minimal", "low"},
		{"low", "low"},
		{"medium", "medium"},
		{"high", "high"},
		{"xhigh", "high"},
		{"max", "max"},
	}
	for _, tc := range cases {
		t.Run(tc.level, func(t *testing.T) {
			cs := newCaptureServer(t, "anthropic")
			p := testProvider("anthropic", cs.srv.URL, func(p *config.ProviderConfig) {
				p.ThinkingMode = "adaptive"
				p.Thinking = tc.level
			})
			client, err := newAnthropicClient(p, "system")
			if err != nil {
				t.Fatal(err)
			}
			cs.request(t, client)
			if client.GetThinkingLevel() != tc.level {
				t.Fatalf("level = %s, want %s", client.GetThinkingLevel(), tc.level)
			}
			payload := cs.last(t)
			thinking, _ := payload["thinking"].(map[string]any)
			wantType := "adaptive"
			if tc.level == "off" {
				wantType = "disabled"
			}
			if thinking == nil || thinking["type"] != wantType {
				t.Fatalf("thinking = %v, want %s", payload["thinking"], wantType)
			}
			outputConfig, hasConfig := payload["output_config"].(map[string]any)
			if tc.effort == "" {
				if hasConfig {
					t.Fatalf("output_config = %v, want absent", payload["output_config"])
				}
				return
			}
			if !hasConfig || outputConfig["effort"] != tc.effort {
				t.Fatalf("output_config = %v, want effort %s", payload["output_config"], tc.effort)
			}
		})
	}
}

func TestAnthropicAdaptiveOverridesNeverSendIllegalEffort(t *testing.T) {
	cs := newCaptureServer(t, "anthropic")
	p := testProvider("anthropic", cs.srv.URL, func(p *config.ProviderConfig) {
		p.ThinkingMode = "adaptive"
		p.ThinkingLevelMap = map[string]config.LevelOverride{
			"high":  {Effort: "minimal"},
			"xhigh": {Effort: "xhigh"},
			"max":   {Effort: "low"},
		}
	})
	client, err := newAnthropicClient(p, "system")
	if err != nil {
		t.Fatal(err)
	}
	for _, level := range client.GetSupportedThinkingLevels() {
		if level == "high" {
			t.Fatal("high maps to a non-anthropic effort and must not be supported")
		}
	}
	if client.GetThinkingLevel() != "medium" {
		t.Fatalf("level = %s, want medium", client.GetThinkingLevel())
	}
	cs.request(t, client)
	if got := cs.last(t)["output_config"].(map[string]any)["effort"]; got != "medium" {
		t.Fatalf("effort = %v, want medium", got)
	}
	if client.SetThinkingLevel("xhigh") != "xhigh" {
		t.Fatalf("setThinkingLevel(xhigh) = %s", client.SetThinkingLevel("xhigh"))
	}
	cs.request(t, client)
	if got := cs.last(t)["output_config"].(map[string]any)["effort"]; got != "xhigh" {
		t.Fatalf("effort = %v, want xhigh", got)
	}
	client.SetThinkingLevel("max")
	cs.request(t, client)
	if got := cs.last(t)["output_config"].(map[string]any)["effort"]; got != "low" {
		t.Fatalf("effort = %v, want low", got)
	}
}

func TestAnthropicBudgetStaysInsideOutputCeiling(t *testing.T) {
	for _, cap := range []float64{1, 1024, 1151, 1152, 2048, 4096} {
		t.Run("", func(t *testing.T) {
			cs := newCaptureServer(t, "anthropic")
			p := testProvider("anthropic", cs.srv.URL, func(p *config.ProviderConfig) {
				p.ThinkingMode = "budget"
				p.Thinking = "max"
				p.MaxOutputTokens = cap
			})
			client, err := newAnthropicClient(p, "system")
			if err != nil {
				t.Fatal(err)
			}
			cs.request(t, client)
			payload := cs.last(t)
			if got := int(payload["max_tokens"].(float64)); float64(got) != cap {
				t.Fatalf("max_tokens = %d, want %v", got, cap)
			}
			thinking, _ := payload["thinking"].(map[string]any)
			if cap < float64(config.MinThinkingBudgetTokens+config.MinThinkingAnswerTokens) {
				if !reflect.DeepEqual(client.GetSupportedThinkingLevels(), []string{"off"}) {
					t.Fatalf("supported = %v, want [off]", client.GetSupportedThinkingLevels())
				}
				if client.GetThinkingLevel() != "off" {
					t.Fatalf("level = %s, want off", client.GetThinkingLevel())
				}
				if client.SetThinkingLevel("high") != "off" {
					t.Fatal("setThinkingLevel(high) must clamp to off")
				}
				if thinking == nil || thinking["type"] != "disabled" {
					t.Fatalf("thinking = %v, want disabled", payload["thinking"])
				}
				return
			}
			if client.GetThinkingLevel() != "max" {
				t.Fatalf("level = %s, want max", client.GetThinkingLevel())
			}
			wantBudget := int(cap) - config.MinThinkingAnswerTokens
			if got := int(thinking["budget_tokens"].(float64)); got != wantBudget {
				t.Fatalf("budget_tokens = %d, want %d", got, wantBudget)
			}
		})
	}
}

func TestAnthropicRuntimeOutputLimitChanges(t *testing.T) {
	cs := newCaptureServer(t, "anthropic")
	p := testProvider("anthropic", cs.srv.URL, func(p *config.ProviderConfig) {
		p.ContextWindow = 4096
	})
	client, err := newAnthropicClient(p, "system")
	if err != nil {
		t.Fatal(err)
	}
	client.SetMaxOutputTokens(1151)
	if !reflect.DeepEqual(client.GetSupportedThinkingLevels(), []string{"off"}) {
		t.Fatalf("supported = %v, want [off]", client.GetSupportedThinkingLevels())
	}
	if client.GetThinkingLevel() != "off" {
		t.Fatalf("level = %s, want off", client.GetThinkingLevel())
	}
	cs.request(t, client)
	if got := cs.last(t)["thinking"].(map[string]any)["type"]; got != "disabled" {
		t.Fatalf("thinking type = %v, want disabled", got)
	}
	client.SetMaxOutputTokens(8192)
	if !reflect.DeepEqual(client.GetSupportedThinkingLevels(), config.ThinkingLevels) {
		t.Fatalf("supported = %v, want all levels", client.GetSupportedThinkingLevels())
	}
	if client.SetThinkingLevel("high") != "high" {
		t.Fatal("setThinkingLevel(high) must stick")
	}
	cs.request(t, client)
	payload := cs.last(t)
	if got := int(payload["max_tokens"].(float64)); got != 4096 {
		t.Fatalf("max_tokens = %d, want 4096", got)
	}
	thinking := payload["thinking"].(map[string]any)
	if got := int(thinking["budget_tokens"].(float64)); got != 4096-config.MinThinkingAnswerTokens {
		t.Fatalf("budget_tokens = %d, want %d", got, 4096-config.MinThinkingAnswerTokens)
	}
}

func TestAnthropicAdaptiveIgnoresBudgetMinimum(t *testing.T) {
	cs := newCaptureServer(t, "anthropic")
	p := testProvider("anthropic", cs.srv.URL, func(p *config.ProviderConfig) {
		p.ThinkingMode = "adaptive"
		p.MaxOutputTokens = 1024
	})
	client, err := newAnthropicClient(p, "system")
	if err != nil {
		t.Fatal(err)
	}
	cs.request(t, client)
	if client.GetThinkingLevel() != "high" {
		t.Fatalf("level = %s, want high", client.GetThinkingLevel())
	}
	if got := cs.last(t)["thinking"].(map[string]any)["type"]; got != "adaptive" {
		t.Fatalf("thinking type = %v, want adaptive", got)
	}
}

func TestReasoningFalseOmitsReasoningFields(t *testing.T) {
	for _, protocol := range []string{"anthropic", "openai", "openai-compat"} {
		for _, level := range config.ThinkingLevels {
			cs := newCaptureServer(t, protocol)
			p := testProvider(protocol, cs.srv.URL, func(p *config.ProviderConfig) {
				reasoning := false
				p.Reasoning = &reasoning
				p.Model = "reasoning-max-model"
				p.Thinking = level
			})
			client, err := NewClient(p, "system")
			if err != nil {
				t.Fatal(err)
			}
			control, _ := client.(ThinkingLevelControl)
			if !reflect.DeepEqual(control.GetSupportedThinkingLevels(), []string{"off"}) {
				t.Fatalf("%s: supported = %v, want [off]", protocol, control.GetSupportedThinkingLevels())
			}
			if control.GetThinkingLevel() != "off" {
				t.Fatalf("%s: level = %s, want off", protocol, control.GetThinkingLevel())
			}
			if control.SetThinkingLevel(level) != "off" {
				t.Fatalf("%s: setThinkingLevel(%s) must clamp to off", protocol, level)
			}
			cs.request(t, client)
			payload := cs.last(t)
			for _, field := range []string{"reasoning", "reasoning_effort", "thinking", "output_config"} {
				if _, ok := payload[field]; ok {
					t.Fatalf("%s: payload must not contain %s: %v", protocol, field, payload[field])
				}
			}
		}
	}
}

func TestOpenAINativeEfforts(t *testing.T) {
	for _, level := range config.ThinkingLevels {
		t.Run("openai/"+level, func(t *testing.T) {
			cs := newCaptureServer(t, "openai")
			p := testProvider("openai", cs.srv.URL, nil)
			client, err := newOpenAIClient(p, "system")
			if err != nil {
				t.Fatal(err)
			}
			if client.GetThinkingLevel() != "high" {
				t.Fatalf("default level = %s, want high", client.GetThinkingLevel())
			}
			if client.SetThinkingLevel(level) != level {
				t.Fatalf("setThinkingLevel(%s) did not stick", level)
			}
			cs.request(t, client)
			payload := cs.last(t)
			reasoning, _ := payload["reasoning"].(map[string]any)
			wantEffort := level
			if level == "off" {
				wantEffort = "none"
			}
			if reasoning == nil || reasoning["effort"] != wantEffort {
				t.Fatalf("reasoning = %v, want effort %s", payload["reasoning"], wantEffort)
			}
			if level == "off" {
				if _, ok := reasoning["summary"]; ok {
					t.Fatalf("off must not request a summary: %v", reasoning)
				}
			} else if reasoning["summary"] != "auto" {
				t.Fatalf("summary = %v, want auto", reasoning["summary"])
			}
		})
		t.Run("openai-compat/"+level, func(t *testing.T) {
			cs := newCaptureServer(t, "openai-compat")
			p := testProvider("openai-compat", cs.srv.URL, nil)
			client, err := newOpenAICompatClient(p, "system")
			if err != nil {
				t.Fatal(err)
			}
			client.SetThinkingLevel(level)
			cs.request(t, client)
			payload := cs.last(t)
			wantEffort := level
			if level == "off" {
				wantEffort = "none"
			}
			if payload["reasoning_effort"] != wantEffort {
				t.Fatalf("reasoning_effort = %v, want %s", payload["reasoning_effort"], wantEffort)
			}
		})
	}
}

func TestOpenAIIgnoresAnthropicAdaptiveMode(t *testing.T) {
	for _, protocol := range []string{"openai", "openai-compat"} {
		cs := newCaptureServer(t, protocol)
		p := testProvider(protocol, cs.srv.URL, func(p *config.ProviderConfig) {
			p.ThinkingMode = "adaptive"
			p.Thinking = "minimal"
		})
		client, err := NewClient(p, "system")
		if err != nil {
			t.Fatal(err)
		}
		cs.request(t, client)
		payload := cs.last(t)
		if protocol == "openai" {
			reasoning := payload["reasoning"].(map[string]any)
			if reasoning["effort"] != "minimal" || reasoning["summary"] != "auto" {
				t.Fatalf("reasoning = %v", reasoning)
			}
		} else if payload["reasoning_effort"] != "minimal" {
			t.Fatalf("reasoning_effort = %v, want minimal", payload["reasoning_effort"])
		}
		if _, ok := payload["output_config"]; ok {
			t.Fatal("output_config must not appear for OpenAI protocols")
		}
	}
}

func TestThinkingLevelMapNativeEffort(t *testing.T) {
	for _, protocol := range []string{"anthropic", "openai", "openai-compat"} {
		cs := newCaptureServer(t, protocol)
		p := testProvider(protocol, cs.srv.URL, func(p *config.ProviderConfig) {
			p.ThinkingLevelMap = map[string]config.LevelOverride{"low": {Effort: "medium"}}
		})
		client, err := NewClient(p, "system")
		if err != nil {
			t.Fatal(err)
		}
		control := client.(ThinkingLevelControl)
		if control.SetThinkingLevel("low") != "low" {
			t.Fatalf("%s: setThinkingLevel(low) did not stick", protocol)
		}
		budget := client.(OutputBudgetProvider).GetOutputBudget()
		if budget.ThinkingTokens != 8192 {
			t.Fatalf("%s: thinkingTokens = %d, want 8192", protocol, budget.ThinkingTokens)
		}
		cs.request(t, client)
		payload := cs.last(t)
		switch protocol {
		case "anthropic":
			thinking := payload["thinking"].(map[string]any)
			if thinking["type"] != "enabled" || int(thinking["budget_tokens"].(float64)) != 8192 {
				t.Fatalf("thinking = %v", thinking)
			}
		case "openai":
			reasoning := payload["reasoning"].(map[string]any)
			if reasoning["effort"] != "medium" || reasoning["summary"] != "auto" {
				t.Fatalf("reasoning = %v", reasoning)
			}
		default:
			if payload["reasoning_effort"] != "medium" {
				t.Fatalf("reasoning_effort = %v, want medium", payload["reasoning_effort"])
			}
		}
	}
}

func TestOutputBudgetRefreshesAfterRuntimeChanges(t *testing.T) {
	for _, protocol := range []string{"anthropic", "openai", "openai-compat"} {
		p := testProvider(protocol, "https://example.invalid", func(p *config.ProviderConfig) {
			p.Thinking = "high"
			p.ThinkingLevelMap = map[string]config.LevelOverride{
				"high": {Effort: "max"},
				"low":  {Effort: "medium"},
			}
		})
		client, err := NewClient(p, "system")
		if err != nil {
			t.Fatal(err)
		}
		budget := client.(OutputBudgetProvider).GetOutputBudget()
		if budget.MaxOutputTokens != config.DefaultMaxOutputTokens || budget.ThinkingTokens != 65536 {
			t.Fatalf("%s: budget = %+v", protocol, budget)
		}
		client.(ThinkingLevelControl).SetThinkingLevel("low")
		client.(MaxTokensSetter).SetMaxOutputTokens(64000)
		budget = client.(OutputBudgetProvider).GetOutputBudget()
		if budget.MaxOutputTokens != 64000 || budget.ThinkingTokens != 8192 {
			t.Fatalf("%s: refreshed budget = %+v", protocol, budget)
		}
	}
}

func TestClampNullNoneMappingsDown(t *testing.T) {
	for _, protocol := range []string{"anthropic", "openai", "openai-compat"} {
		cs := newCaptureServer(t, protocol)
		p := testProvider(protocol, cs.srv.URL, func(p *config.ProviderConfig) {
			p.Thinking = "max"
			p.ThinkingLevelMap = map[string]config.LevelOverride{
				"max":   {Null: true},
				"xhigh": {Null: true},
				"high":  {Effort: "none"},
			}
		})
		client, err := NewClient(p, "system")
		if err != nil {
			t.Fatal(err)
		}
		control := client.(ThinkingLevelControl)
		want := []string{"off", "minimal", "low", "medium"}
		if !reflect.DeepEqual(control.GetSupportedThinkingLevels(), want) {
			t.Fatalf("%s: supported = %v, want %v", protocol, control.GetSupportedThinkingLevels(), want)
		}
		if control.GetThinkingLevel() != "medium" {
			t.Fatalf("%s: level = %s, want medium", protocol, control.GetThinkingLevel())
		}
		if control.SetThinkingLevel("high") != "medium" {
			t.Fatalf("%s: setThinkingLevel(high) must clamp to medium", protocol)
		}
		cs.request(t, client)
		payload := cs.last(t)
		switch protocol {
		case "anthropic":
			thinking := payload["thinking"].(map[string]any)
			if thinking["type"] != "enabled" || int(thinking["budget_tokens"].(float64)) != 8192 {
				t.Fatalf("thinking = %v", thinking)
			}
		case "openai":
			reasoning := payload["reasoning"].(map[string]any)
			if reasoning["effort"] != "medium" || reasoning["summary"] != "auto" {
				t.Fatalf("reasoning = %v", reasoning)
			}
		default:
			if payload["reasoning_effort"] != "medium" {
				t.Fatalf("reasoning_effort = %v, want medium", payload["reasoning_effort"])
			}
		}
	}
}

func TestAllDisabledMappingsClampToOff(t *testing.T) {
	for _, protocol := range []string{"anthropic", "openai", "openai-compat"} {
		cs := newCaptureServer(t, protocol)
		p := testProvider(protocol, cs.srv.URL, func(p *config.ProviderConfig) {
			p.ThinkingLevelMap = map[string]config.LevelOverride{
				"off": {Null: true}, "minimal": {Null: true}, "low": {Null: true},
				"medium": {Null: true}, "high": {Null: true}, "xhigh": {Null: true}, "max": {Null: true},
			}
		})
		client, err := NewClient(p, "system")
		if err != nil {
			t.Fatal(err)
		}
		control := client.(ThinkingLevelControl)
		if !reflect.DeepEqual(control.GetSupportedThinkingLevels(), []string{"off"}) {
			t.Fatalf("%s: supported = %v, want [off]", protocol, control.GetSupportedThinkingLevels())
		}
		if control.SetThinkingLevel("max") != "off" {
			t.Fatalf("%s: setThinkingLevel(max) must clamp to off", protocol)
		}
		cs.request(t, client)
		payload := cs.last(t)
		switch protocol {
		case "anthropic":
			if got := payload["thinking"].(map[string]any)["type"]; got != "disabled" {
				t.Fatalf("thinking type = %v, want disabled", got)
			}
		case "openai":
			reasoning := payload["reasoning"].(map[string]any)
			if reasoning["effort"] != "none" {
				t.Fatalf("reasoning = %v, want effort none", reasoning)
			}
			if _, ok := reasoning["summary"]; ok {
				t.Fatalf("off must not request a summary: %v", reasoning)
			}
		default:
			if payload["reasoning_effort"] != "none" {
				t.Fatalf("reasoning_effort = %v, want none", payload["reasoning_effort"])
			}
		}
	}
}

func TestAnthropicThinkingBlocksInConversation(t *testing.T) {
	cs := newCaptureServer(t, "anthropic")
	p := testProvider("anthropic", cs.srv.URL, nil)
	client, err := newAnthropicClient(p, "system")
	if err != nil {
		t.Fatal(err)
	}
	conv := conversation.NewManager()
	conv.AddUserMessage("hi")
	conv.AddAssistantFull("hi there", []conversation.ThinkingBlock{
		{Thinking: "let me think about this", Signature: "sig123"},
	}, nil)
	conv.AddUserMessage("continue")

	events, errs := client.Stream(context.Background(), conv, nil)
	for range events {
	}
	select {
	case err := <-errs:
		if err != nil {
			t.Fatal(err)
		}
	default:
	}

	payload := cs.last(t)
	messages, _ := payload["messages"].([]any)
	if len(messages) == 0 {
		t.Fatal("no messages in request")
	}
	assistant, _ := messages[1].(map[string]any)
	blocks, _ := assistant["content"].([]any)
	foundThinking := false
	for _, b := range blocks {
		blockMap, _ := b.(map[string]any)
		if blockMap["type"] == "thinking" {
			foundThinking = true
			if blockMap["thinking"] != "let me think about this" || blockMap["signature"] != "sig123" {
				t.Fatalf("thinking block = %v", blockMap)
			}
		}
	}
	if !foundThinking {
		t.Fatal("thinking block missing from assistant replay")
	}
}

func TestAnthropicTruncatedStreamErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		io.WriteString(w, "event: message_start\n")
		io.WriteString(w, `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}`+"\n\n")
	}))
	defer srv.Close()

	client, err := newAnthropicClient(testProvider("anthropic", srv.URL, nil), "system")
	if err != nil {
		t.Fatal(err)
	}
	conv := conversation.NewManager()
	conv.AddUserMessage("hi")
	events, errs := client.Stream(context.Background(), conv, nil)
	for range events {
	}
	select {
	case err := <-errs:
		var netErr *NetworkError
		if !errors.As(err, &netErr) {
			t.Fatalf("err = %v, want NetworkError", err)
		}
	default:
		t.Fatal("truncated stream must surface an error")
	}
}
