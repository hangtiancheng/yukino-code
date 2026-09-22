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
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/openai/openai-go"
)

func TestUnknownProtocolWording(t *testing.T) {
	_, err := NewClient(&config.ProviderConfig{Protocol: "bogus"}, "sys")
	if err == nil || err.Error() != "Unknown protocol: bogus" {
		t.Fatalf("err = %q, want %q", err, "Unknown protocol: bogus")
	}
}

func TestDiscoverModelsErrorMasked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()
	_, err := DiscoverModels(context.Background(), discoveryCfg("anthropic", srv.URL, "k"))
	if err == nil || err.Error() != "Model discovery failed" {
		t.Fatalf("err = %q, want the masked %q", err, "Model discovery failed")
	}
}

func TestAnthropicAuthErrorWording(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	_, err := newAnthropicClient(&config.ProviderConfig{Protocol: "anthropic"}, "sys")
	want := "Anthropic API key not found, set ANTHROPIC_API_KEY in ~/.yukino/config.yaml, or via ANTHROPIC_API_KEY env variable."
	if err == nil || err.Error() != want {
		t.Fatalf("err = %q, want %q", err, want)
	}
}

func TestOpenAIAuthErrorWordings(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	_, err := newOpenAIClient(&config.ProviderConfig{Protocol: "openai"}, "sys")
	want := "OpenAI API key not found, set OPENAI_API_KEY in ~/.yukino/config.yaml, or via OPENAI_API_KEY env variable."
	if err == nil || err.Error() != want {
		t.Fatalf("responses err = %q, want %q", err, want)
	}
	_, err = newOpenAICompatClient(&config.ProviderConfig{Protocol: "openai-compat"}, "sys")
	want = "OpenAI API key not found. Set OPENAI_API_KEY in ~/.yukino/config.yaml, or via OPENAI_API_KEY env variable."
	if err == nil || err.Error() != want {
		t.Fatalf("compat err = %q, want %q", err, want)
	}
}

// TestAnthropicComputerToolUseRenamed pins the send-side mapping: ComputerUse
// tool uses go out under the provider name "computer" (TS buildAnthropicMessages).
func TestAnthropicComputerToolUseRenamed(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
	}, "sys")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	conv.AddToolUseMessage("", "cu_1", "ComputerUse", map[string]any{"actions": []any{}})
	conv.AddToolResultMessage("cu_1", "done", false, nil)
	drainStream(client, conv)

	messages, _ := captured["messages"].([]any)
	if len(messages) < 2 {
		t.Fatalf("expected assistant message in request, got %v", captured)
	}
	assistant, _ := messages[1].(map[string]any)
	blocks, _ := assistant["content"].([]any)
	found := false
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		if block["type"] == "tool_use" {
			if block["name"] != "computer" {
				t.Errorf("tool_use name = %v, want \"computer\"", block["name"])
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("no tool_use block in assistant message: %v", assistant)
	}
}

// TestAnthropicStreamComputerNameMapping pins the receive-side mapping: a
// "computer" content block surfaces as a ComputerUse tool call (TS stream).
func TestAnthropicStreamComputerNameMapping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		io.WriteString(w, "event: message_start\n")
		io.WriteString(w, `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}`+"\n\n")
		io.WriteString(w, "event: content_block_start\n")
		io.WriteString(w, `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"cu_1","name":"computer","input":{}}}`+"\n\n")
		io.WriteString(w, "event: content_block_stop\n")
		io.WriteString(w, `data: {"type":"content_block_stop","index":0}`+"\n\n")
		io.WriteString(w, "event: message_delta\n")
		io.WriteString(w, `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}`+"\n\n")
		io.WriteString(w, "event: message_stop\n")
		io.WriteString(w, `data: {"type":"message_stop"}`+"\n\n")
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
	}, "sys")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")

	events, errs := client.Stream(context.Background(), conv, nil)
	var start *ToolCallStart
	var complete *ToolCallComplete
	for ev := range events {
		switch e := ev.(type) {
		case ToolCallStart:
			start = &e
		case ToolCallComplete:
			complete = &e
		}
	}
	if err := <-errs; err != nil {
		t.Fatalf("stream error: %v", err)
	}
	if start == nil || start.ToolName != "ComputerUse" || start.ToolID != "cu_1" {
		t.Fatalf("tool_call_start = %+v, want ComputerUse/cu_1", start)
	}
	if complete == nil || complete.ToolName != "ComputerUse" {
		t.Fatalf("tool_call_complete = %+v, want ComputerUse", complete)
	}
}

// TestAnthropicUnsupportedUserContentBlock pins the TS userBlocksFor throw:
// tool_reference (and anything unrecognized) in user content fails the stream
// with the exact error message.
func TestAnthropicUnsupportedUserContentBlock(t *testing.T) {
	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: "http://127.0.0.1:0", APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
	}, "sys")
	conv := conversation.NewManager()
	conv.AddUserMessageWithBlocks("see here", []map[string]any{
		{"type": "tool_reference", "tool_name": "mcp__x"},
	})

	events, errs := client.Stream(context.Background(), conv, nil)
	for range events {
	}
	err := <-errs
	if err == nil || err.Error() != "Unsupported user content block: tool_reference" {
		t.Fatalf("err = %q, want the TS unsupported-block error", err)
	}
}

// TestAnthropicToolResultTrailingUserContent pins that user content on a
// tool-result message is appended after the tool_result blocks (TS
// buildAnthropicMessages).
func TestAnthropicToolResultTrailingUserContent(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := fakeAnthropicSSE(w, r)
		json.Unmarshal(body, &captured)
	}))
	defer srv.Close()

	client, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
	}, "sys")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	conv.AddToolUseMessage("", "t1", "ReadFile", map[string]any{"file_path": "x"})
	conv.AppendMessages([]conversation.Message{{
		Role:    "user",
		Content: "extra note",
		ToolResults: []conversation.ToolResultBlock{{
			ToolUseID: "t1",
			Content:   "file contents",
		}},
	}})
	drainStream(client, conv)

	messages, _ := captured["messages"].([]any)
	last, _ := messages[len(messages)-1].(map[string]any)
	blocks, _ := last["content"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("expected [tool_result, text] blocks, got %v", blocks)
	}
	first, _ := blocks[0].(map[string]any)
	second, _ := blocks[1].(map[string]any)
	if first["type"] != "tool_result" {
		t.Errorf("blocks[0].type = %v, want tool_result", first["type"])
	}
	if second["type"] != "text" || second["text"] != "extra note" {
		t.Errorf("blocks[1] = %v, want the trailing text block", second)
	}
}

// TestAnthropicMergeOnlyIntoTextUser pins the TS merge condition: consecutive
// user messages merge only when the previous one starts with a text or image
// block; a tool_result-headed user message is never merged into.
func TestAnthropicMergeOnlyIntoTextUser(t *testing.T) {
	// Two plain user messages merge into one entry with two text blocks.
	msgs, err := buildAnthropicMessages([]conversation.Message{
		{Role: "user", Content: "first"},
		{Role: "user", Content: "second"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || len(msgs[0].Content) != 2 {
		t.Fatalf("consecutive user text must merge into one message with two blocks, got %d messages", len(msgs))
	}

	// A user message after a tool_result-headed user message stays separate.
	msgs, err = buildAnthropicMessages([]conversation.Message{
		{Role: "user", ToolResults: []conversation.ToolResultBlock{{ToolUseID: "t1", Content: "r"}}},
		{Role: "user", Content: "after"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("user text after a tool_result user must not merge, got %d messages", len(msgs))
	}
}

// TestAnthropicCustomToolTypeOnOfficialEndpoint pins toAnthropicToolSchema:
// the official endpoint gets the explicit type:"custom"; other endpoints get
// no type field.
func TestAnthropicCustomToolTypeOnOfficialEndpoint(t *testing.T) {
	schema := []map[string]any{{
		"name":         "ReadFile",
		"description":  "reads",
		"input_schema": map[string]any{"type": "object", "properties": map[string]any{}},
	}}

	official, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: "https://api.anthropic.com", APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
	}, "sys")
	tools, err := official.toAnthropicToolSchemas(schema)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(tools)
	if !strings.Contains(string(raw), `"type":"custom"`) {
		t.Errorf("official endpoint tools must carry type:custom, got %s", raw)
	}

	gateway, _ := newAnthropicClient(&config.ProviderConfig{
		BaseURL: "https://gateway.example.com", APIKey: "k", Model: "claude-sonnet-4-6", Protocol: "anthropic",
	}, "sys")
	tools, err = gateway.toAnthropicToolSchemas(schema)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(tools)
	var decoded []map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 1 {
		t.Fatalf("decoded tools = %v", decoded)
	}
	if _, hasType := decoded[0]["type"]; hasType {
		t.Errorf("gateway endpoint tools must not carry a top-level type field, got %s", raw)
	}

	// A schema without input_schema is rejected with the TS wording.
	if _, err := official.toAnthropicToolSchemas([]map[string]any{{"name": "x"}}); err == nil ||
		err.Error() != "Anthropic received a tool schema serialized for another protocol." {
		t.Errorf("foreign-protocol schema error = %v", err)
	}
}

// TestAnthropicCacheMarkerPrefersNonImage pins markLastUserTailForCache: the
// marker lands on the last non-image block, falling back to the true tail
// when everything is an image.
func TestAnthropicCacheMarkerPrefersNonImage(t *testing.T) {
	var unmarked anthropic.CacheControlEphemeralParam
	isMarked := func(cc anthropic.CacheControlEphemeralParam) bool { return cc != unmarked }

	textBlock := anthropic.NewTextBlock("t")
	imageBlock := anthropic.ContentBlockParamUnion{OfImage: &anthropic.ImageBlockParam{}}
	msgs := []anthropic.MessageParam{{
		Role:    anthropic.MessageParamRoleUser,
		Content: []anthropic.ContentBlockParamUnion{textBlock, imageBlock},
	}}
	markLastUserTailForCache(msgs)
	if !isMarked(msgs[0].Content[0].OfText.CacheControl) {
		t.Error("the last non-image block must carry the cache marker")
	}
	if isMarked(msgs[0].Content[1].OfImage.CacheControl) {
		t.Error("the image block must not carry the cache marker when a text block precedes it")
	}

	img1 := anthropic.ContentBlockParamUnion{OfImage: &anthropic.ImageBlockParam{}}
	img2 := anthropic.ContentBlockParamUnion{OfImage: &anthropic.ImageBlockParam{}}
	msgs = []anthropic.MessageParam{{
		Role:    anthropic.MessageParamRoleUser,
		Content: []anthropic.ContentBlockParamUnion{img1, img2},
	}}
	markLastUserTailForCache(msgs)
	if !isMarked(msgs[0].Content[1].OfImage.CacheControl) {
		t.Error("an all-image tail must fall back to the true tail")
	}
}

// TestClassifyAnthropicErrorByStatus pins the TS classifier: the branches key
// off the HTTP status (not the body error type) and use the SDK's
// makeMessage-rendered message ("<status> <whole body JSON>" — the Anthropic
// SDK keys makeMessage off the full response body).
func TestClassifyAnthropicErrorByStatus(t *testing.T) {
	makeErr := func(status int, body string) *anthropic.Error {
		var apiErr anthropic.Error
		if err := json.Unmarshal([]byte(body), &apiErr); err != nil {
			t.Fatal(err)
		}
		apiErr.StatusCode = status
		return &apiErr
	}

	// 429 without a retry-after header.
	got := classifyAnthropicError(makeErr(429, `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`))
	var rate *RateLimitError
	if !errors.As(got, &rate) || rate.Message != "Rate Limited, please wait." {
		t.Errorf("429 classified as %T %q, want RateLimitError please-wait", got, got)
	}

	// 400 with the context-length phrasing: the message is the SDK's
	// makeMessage output — "<status> <whole body JSON>".
	body400 := `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 100 tokens > 50 maximum"}}`
	got = classifyAnthropicError(makeErr(400, body400))
	var ctl *ContextTooLongError
	if !errors.As(got, &ctl) || ctl.Message != "Prompt too long: 400 "+body400 {
		t.Errorf("400 context classified as %T %q", got, got)
	}

	// 401 keys off the status even when the body type differs.
	body401 := `{"type":"error","error":{"type":"api_error","message":"bad key"}}`
	got = classifyAnthropicError(makeErr(401, body401))
	var auth *AuthenticationError
	if !errors.As(got, &auth) || auth.Message != "Invalid API key: 401 "+body401 {
		t.Errorf("401 classified as %T %q", got, got)
	}

	// Generic status: the TS wording repeats the status (SDK message already
	// carries it).
	body500 := `{"type":"error","error":{"type":"api_error","message":"boom"}}`
	got = classifyAnthropicError(makeErr(500, body500))
	var llmErr *LLMError
	if !errors.As(got, &llmErr) || llmErr.Message != "Anthropic API error (500): 500 "+body500 {
		t.Errorf("500 classified as %T %q", got, got)
	}
}

// TestClassifyOpenAIErrorUsesBodyMessage pins the OpenAI classifier's
// makeMessage wording: the OpenAI SDK keys makeMessage off the body's error
// object, so err.message is "<status> <error.message>".
func TestClassifyOpenAIErrorUsesBodyMessage(t *testing.T) {
	got := classifyOpenAIError(&openai.Error{StatusCode: 400, Message: "maximum context length is 100 tokens"})
	var ctl *ContextTooLongError
	if !errors.As(got, &ctl) || ctl.Message != "Context Too Long: 400 maximum context length is 100 tokens" {
		t.Errorf("400 classified as %T %q", got, got)
	}

	got = classifyOpenAIError(&openai.Error{StatusCode: 500, Message: "boom"})
	var llmErr *LLMError
	if !errors.As(got, &llmErr) || llmErr.Message != "OpenAI API error (500): 500 boom" {
		t.Errorf("500 classified as %T %q", got, got)
	}
}

// responsesSSE writes a Responses-API SSE stream.
func responsesSSE(w http.ResponseWriter, events ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	for _, ev := range events {
		io.WriteString(w, "data: "+ev+"\n\n")
	}
}

func drainEvents(t *testing.T, client Client, conv *conversation.Manager) ([]StreamEvent, error) {
	t.Helper()
	events, errs := client.Stream(context.Background(), conv, nil)
	var out []StreamEvent
	for ev := range events {
		out = append(out, ev)
	}
	select {
	case err := <-errs:
		return out, err
	default:
		return out, nil
	}
}

// TestOpenAIResponsesSystemPromptFirstInputItem pins that the system prompt
// goes out as the first input item — the instructions field stays unset.
func TestOpenAIResponsesSystemPromptFirstInputItem(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &captured)
		responsesSSE(w,
			`{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}`,
		)
	}))
	defer srv.Close()

	client, _ := newOpenAIClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "gpt-x", Protocol: "openai",
	}, "SYS PROMPT")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	if _, err := drainEvents(t, client, conv); err != nil {
		t.Fatalf("stream error: %v", err)
	}

	if _, hasInstructions := captured["instructions"]; hasInstructions {
		t.Error("the instructions field must not be used (TS sends a system input item)")
	}
	input, _ := captured["input"].([]any)
	if len(input) < 2 {
		t.Fatalf("expected [system, user] input items, got %v", captured)
	}
	first, _ := input[0].(map[string]any)
	if first["role"] != "system" || first["content"] != "SYS PROMPT" {
		t.Errorf("input[0] = %v, want the system prompt item", first)
	}
}

// TestOpenAIResponsesComputerCallEvents pins the computer_call streaming path:
// start + completion with the mapped arguments and the provider item id.
func TestOpenAIResponsesComputerCallEvents(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		responsesSSE(w,
			`{"type":"response.output_item.added","output_index":0,"item":{"type":"computer_call","id":"cc_1","call_id":"call_c1","status":"in_progress","action":{"type":"click","button":"left","x":10,"y":20},"pending_safety_checks":[]}}`,
			`{"type":"response.output_item.done","output_index":0,"item":{"type":"computer_call","id":"cc_1","call_id":"call_c1","status":"completed","actions":[{"type":"click","button":"left","x":10,"y":20}],"pending_safety_checks":[{"id":"sc_1","code":"click_denylist"}]}}`,
			`{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}`,
		)
	}))
	defer srv.Close()

	client, _ := newOpenAIClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "gpt-x", Protocol: "openai",
	}, "sys")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	events, err := drainEvents(t, client, conv)
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}

	var start *ToolCallStart
	var complete *ToolCallComplete
	for _, ev := range events {
		switch e := ev.(type) {
		case ToolCallStart:
			start = &e
		case ToolCallComplete:
			complete = &e
		}
	}
	if start == nil || start.ToolName != "ComputerUse" || start.ToolID != "call_c1" {
		t.Fatalf("tool_call_start = %+v, want ComputerUse/call_c1", start)
	}
	if complete == nil {
		t.Fatal("no tool_call_complete for the computer_call item")
	}
	if complete.ToolName != "ComputerUse" || complete.ToolID != "call_c1" {
		t.Errorf("completion identity = %+v", complete)
	}
	if complete.ProviderItemID != "cc_1" {
		t.Errorf("ProviderItemID = %q, want cc_1", complete.ProviderItemID)
	}
	actions, _ := complete.Arguments["actions"].([]any)
	if len(actions) != 1 {
		t.Fatalf("actions = %v, want the batched click", complete.Arguments)
	}
	click, _ := actions[0].(map[string]any)
	if click["type"] != "click" || click["x"] != float64(10) || click["button"] != "left" {
		t.Errorf("mapped click = %v", click)
	}
	checks, _ := complete.Arguments["pendingSafetyChecks"].([]any)
	if len(checks) != 1 {
		t.Fatalf("pendingSafetyChecks = %v", complete.Arguments)
	}
	check, _ := checks[0].(map[string]any)
	if check["id"] != "sc_1" || check["code"] != "click_denylist" {
		t.Errorf("mapped safety check = %v", check)
	}
	if complete.Arguments["status"] != "completed" {
		t.Errorf("status = %v, want completed", complete.Arguments["status"])
	}
}

// TestOpenAIResponsesFunctionCallCompletesOnOutputItemDone pins that function
// calls complete on output_item.done using the accumulated argument deltas.
func TestOpenAIResponsesFunctionCallCompletesOnOutputItemDone(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		responsesSSE(w,
			`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"ReadFile","arguments":"","status":"in_progress"}}`,
			`{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"content_index":0,"delta":"{\"file_path\":\"x\"}"}`,
			`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"ReadFile","arguments":"{\"file_path\":\"WRONG\"}","status":"completed"}}`,
			`{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}`,
		)
	}))
	defer srv.Close()

	client, _ := newOpenAIClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "gpt-x", Protocol: "openai",
	}, "sys")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	events, err := drainEvents(t, client, conv)
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}

	var complete *ToolCallComplete
	for _, ev := range events {
		if e, ok := ev.(ToolCallComplete); ok {
			complete = &e
		}
	}
	if complete == nil {
		t.Fatal("no tool_call_complete emitted")
	}
	// TS parses the accumulated deltas, not the done item's arguments field.
	if complete.Arguments["file_path"] != "x" {
		t.Errorf("arguments = %v, want the accumulated deltas", complete.Arguments)
	}
}

// compatSSE writes a Chat Completions SSE stream.
func compatSSE(w http.ResponseWriter, chunks ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	for _, chunk := range chunks {
		io.WriteString(w, "data: "+chunk+"\n\n")
	}
	io.WriteString(w, "data: [DONE]\n\n")
}

// TestOpenAICompatOrderedToolCompletions pins that completions emit in
// first-seen index order (TS Map insertion order), not map order.
func TestOpenAICompatOrderedToolCompletions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		compatSSE(w,
			`{"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"Grep","arguments":""}}]}}]}`,
			`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"ReadFile","arguments":"{}"}}]}}]}`,
			`{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
		)
	}))
	defer srv.Close()

	client, _ := newOpenAICompatClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "deepseek-chat", Protocol: "openai-compat",
	}, "sys")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	events, err := drainEvents(t, client, conv)
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}

	var order []string
	for _, ev := range events {
		if e, ok := ev.(ToolCallComplete); ok {
			order = append(order, e.ToolName)
		}
	}
	if len(order) != 2 || order[0] != "Grep" || order[1] != "ReadFile" {
		t.Fatalf("completion order = %v, want [Grep ReadFile] (arrival order)", order)
	}
}

// TestOpenAICompatSystemMessageUnconditional pins that the system message is
// always the first message, even when the prompt is empty (TS pushes it
// unconditionally).
func TestOpenAICompatSystemMessageUnconditional(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &captured)
		compatSSE(w,
			`{"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
		)
	}))
	defer srv.Close()

	client, _ := newOpenAICompatClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "deepseek-chat", Protocol: "openai-compat",
	}, "")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	if _, err := drainEvents(t, client, conv); err != nil {
		t.Fatalf("stream error: %v", err)
	}

	messages, _ := captured["messages"].([]any)
	if len(messages) < 1 {
		t.Fatalf("no messages in request: %v", captured)
	}
	first, _ := messages[0].(map[string]any)
	if first["role"] != "system" {
		t.Errorf("messages[0].role = %v, want system", first["role"])
	}
}

// TestOpenAICompatAssistantContentNullAndNoEscape pins two wire details: a
// tool-call turn without text sends content: null, and tool arguments are
// JSON.stringify'd without HTML escaping.
func TestOpenAICompatAssistantContentNullAndNoEscape(t *testing.T) {
	var rawBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawBody, _ = io.ReadAll(r.Body)
		compatSSE(w,
			`{"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
		)
	}))
	defer srv.Close()

	client, _ := newOpenAICompatClient(&config.ProviderConfig{
		BaseURL: srv.URL, APIKey: "k", Model: "deepseek-chat", Protocol: "openai-compat",
	}, "sys")
	conv := conversation.NewManager()
	conv.AddUserMessage("hello")
	conv.AddToolUseMessage("", "t1", "Bash", map[string]any{"command": "echo '<a> & b'"})
	conv.AddToolResultMessage("t1", "ok", false, nil)
	if _, err := drainEvents(t, client, conv); err != nil {
		t.Fatalf("stream error: %v", err)
	}

	var captured map[string]any
	json.Unmarshal(rawBody, &captured)
	messages, _ := captured["messages"].([]any)
	var assistant map[string]any
	for _, raw := range messages {
		m, _ := raw.(map[string]any)
		if m["role"] == "assistant" {
			assistant = m
			break
		}
	}
	if assistant == nil {
		t.Fatalf("no assistant message in %s", rawBody)
	}
	// content must be JSON null on the wire (TS: assistantText || null).
	if !strings.Contains(string(rawBody), `"content":null`) {
		t.Errorf("assistant content must serialize as null, body: %s", rawBody)
	}
	toolCalls, _ := assistant["tool_calls"].([]any)
	if len(toolCalls) != 1 {
		t.Fatalf("tool_calls = %v", toolCalls)
	}
	call, _ := toolCalls[0].(map[string]any)
	fn, _ := call["function"].(map[string]any)
	args, _ := fn["arguments"].(string)
	if !strings.Contains(args, "<a> & b") {
		t.Errorf("arguments must not HTML-escape, got %q", args)
	}
}

// TestJsonMarshalNoEscape pins the JSON.stringify parity helper.
func TestJsonMarshalNoEscape(t *testing.T) {
	got := jsonMarshalNoEscape(map[string]any{"cmd": "a<b>&c"})
	want := `{"cmd":"a<b>&c"}`
	if got != want {
		t.Errorf("jsonMarshalNoEscape = %s, want %s", got, want)
	}
}

// marshalWireMessages renders built messages the way the SDK sends them and
// decodes the result for assertions.
func marshalWireMessages(t *testing.T, msgs []anthropic.MessageParam) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(msgs)
	if err != nil {
		t.Fatalf("marshal messages: %v", err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode messages: %v (raw %s)", err, raw)
	}
	return decoded
}

// TestAnthropicDocumentSourceVariants pins the TS normalizeDocumentBlock union
// (tools/types.ts:101-160): a content source accepts a plain string as well as
// the text/image block array, an empty array marshals as [] (not null), and
// title/context pass through when they are a string or an explicit null.
func TestAnthropicDocumentSourceVariants(t *testing.T) {
	build := func(blocks ...map[string]any) []map[string]any {
		t.Helper()
		msgs, err := buildAnthropicMessages([]conversation.Message{{Role: "user", ContentBlocks: blocks}})
		if err != nil {
			t.Fatalf("buildAnthropicMessages: %v", err)
		}
		decoded := marshalWireMessages(t, msgs)
		content, _ := decoded[0]["content"].([]any)
		return func() []map[string]any {
			out := make([]map[string]any, 0, len(content))
			for _, raw := range content {
				block, _ := raw.(map[string]any)
				out = append(out, block)
			}
			return out
		}()
	}

	// The string variant of source.content goes out as a JSON string.
	blocks := build(map[string]any{
		"type":   "document",
		"source": map[string]any{"type": "content", "content": "plain text body"},
	})
	src, _ := blocks[0]["source"].(map[string]any)
	if src["type"] != "content" || src["content"] != "plain text body" {
		t.Errorf("string content source = %v", src)
	}

	// The array variant still maps each text/image item.
	blocks = build(map[string]any{
		"type": "document",
		"source": map[string]any{"type": "content", "content": []any{
			map[string]any{"type": "text", "text": "hi"},
		}},
	})
	src, _ = blocks[0]["source"].(map[string]any)
	items, ok := src["content"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("array content source = %v", src)
	}
	item, _ := items[0].(map[string]any)
	if item["type"] != "text" || item["text"] != "hi" {
		t.Errorf("array content item = %v", item)
	}

	// An explicitly empty array marshals as [] — TS sends the empty array
	// through instead of null.
	blocks = build(map[string]any{
		"type":   "document",
		"source": map[string]any{"type": "content", "content": []any{}},
	})
	src, _ = blocks[0]["source"].(map[string]any)
	if items, ok := src["content"].([]any); !ok || len(items) != 0 {
		t.Errorf("empty array content source = %v, want []", src)
	}

	// title/context: a string passes through, an explicit null is sent as null.
	blocks = build(map[string]any{
		"type":    "document",
		"source":  map[string]any{"type": "text", "media_type": "text/plain", "data": "hi"},
		"title":   nil,
		"context": "ctx",
	})
	if title, present := blocks[0]["title"]; !present || title != nil {
		t.Errorf("title = %v (present %v), want explicit null", title, present)
	}
	if blocks[0]["context"] != "ctx" {
		t.Errorf("context = %v, want ctx", blocks[0]["context"])
	}

	blocks = build(map[string]any{
		"type":    "document",
		"source":  map[string]any{"type": "text", "media_type": "text/plain", "data": "hi"},
		"title":   "doc",
		"context": nil,
	})
	if blocks[0]["title"] != "doc" {
		t.Errorf("title = %v, want doc", blocks[0]["title"])
	}
	if context, present := blocks[0]["context"]; !present || context != nil {
		t.Errorf("context = %v (present %v), want explicit null", context, present)
	}

	// A content source that is neither string nor array rejects the block with
	// the TS unsupported-block wording.
	_, err := buildAnthropicMessages([]conversation.Message{{Role: "user", ContentBlocks: []map[string]any{{
		"type":   "document",
		"source": map[string]any{"type": "content", "content": 42},
	}}}})
	if err == nil || err.Error() != "Unsupported user content block: document" {
		t.Errorf("err = %v, want the TS unsupported-block error", err)
	}
}

// TestAnthropicToolResultContentPassthrough pins the TS raw pass-through
// (anthropic.ts:224): without structured blocks the plain string goes out as a
// JSON string (not a wrapped text block), and structured blocks go out
// verbatim — including `context: null` on a search-result block and block
// types the SDK's typed union cannot carry.
func TestAnthropicToolResultContentPassthrough(t *testing.T) {
	msgs, err := buildAnthropicMessages([]conversation.Message{{
		Role: "user",
		ToolResults: []conversation.ToolResultBlock{
			{ToolUseID: "t1", Content: "plain text", IsError: false},
			{ToolUseID: "t2", IsError: true, ContentBlocks: []map[string]any{
				{
					"type":    "search_result",
					"source":  "web",
					"title":   "T",
					"content": []any{map[string]any{"type": "text", "text": "snippet"}},
					"context": nil,
				},
				{"type": "future_block", "payload": map[string]any{"k": float64(1)}},
			}},
		},
	}})
	if err != nil {
		t.Fatalf("buildAnthropicMessages: %v", err)
	}
	decoded := marshalWireMessages(t, msgs)
	blocks, _ := decoded[0]["content"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("expected two tool_result blocks, got %v", blocks)
	}

	first, _ := blocks[0].(map[string]any)
	if first["content"] != "plain text" {
		t.Errorf("plain tool result content = %#v, want the bare string", first["content"])
	}
	if first["is_error"] != false || first["tool_use_id"] != "t1" {
		t.Errorf("plain tool result = %v", first)
	}

	second, _ := blocks[1].(map[string]any)
	structured, ok := second["content"].([]any)
	if !ok || len(structured) != 2 {
		t.Fatalf("structured content = %#v", second["content"])
	}
	searchResult, _ := structured[0].(map[string]any)
	if context, present := searchResult["context"]; !present || context != nil {
		t.Errorf("search_result context = %v (present %v), want explicit null", context, present)
	}
	if searchResult["source"] != "web" || searchResult["title"] != "T" {
		t.Errorf("search_result = %v", searchResult)
	}
	unknown, _ := structured[1].(map[string]any)
	if unknown["type"] != "future_block" {
		t.Fatalf("unknown block = %v, want the verbatim pass-through", unknown)
	}
	payload, _ := unknown["payload"].(map[string]any)
	if payload["k"] != float64(1) {
		t.Errorf("unknown block payload = %v", payload)
	}

	// The cache marker still lands on a raw-passthrough tool_result: the
	// SetExtraFields content and the struct's cache_control must coexist.
	markLastUserTailForCache(msgs)
	decoded = marshalWireMessages(t, msgs)
	blocks, _ = decoded[0]["content"].([]any)
	second, _ = blocks[1].(map[string]any)
	cc, _ := second["cache_control"].(map[string]any)
	if cc["type"] != "ephemeral" {
		t.Errorf("cache_control = %v, want the ephemeral marker", second["cache_control"])
	}
	if structured, ok := second["content"].([]any); !ok || len(structured) != 2 {
		t.Errorf("content after marking = %#v, want the raw block array", second["content"])
	}
}

// TestOpenAIResponsesTerminalErrorFallbacks pins the TS ?? semantics on the
// Responses terminal events (openai.ts:375-401): the fallbacks trigger only on
// nullish values, so explicit empty strings stay empty; the error event's
// message has no fallback at all and renders as JS's "undefined" when the
// field is missing (or as its raw JSON when null).
func TestOpenAIResponsesTerminalErrorFallbacks(t *testing.T) {
	cases := []struct {
		name  string
		event string
		want  string
	}{
		{
			"failed with explicit empty strings",
			`{"type":"response.failed","response":{"id":"r1","status":"failed","error":{"code":"","message":""}}}`,
			": ",
		},
		{
			"failed with missing error fields",
			`{"type":"response.failed","response":{"id":"r1","status":"failed","error":{}}}`,
			"unknown: Response failed",
		},
		{
			"failed with a null error",
			`{"type":"response.failed","response":{"id":"r1","status":"failed","error":null}}`,
			"unknown: Response failed",
		},
		{
			"incomplete with an explicit empty reason",
			`{"type":"response.incomplete","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":""}}}`,
			"Response incomplete: ",
		},
		{
			"incomplete with missing details",
			`{"type":"response.incomplete","response":{"id":"r1","status":"incomplete"}}`,
			"Response incomplete: unknown reason",
		},
		{
			"incomplete with a content_filter reason",
			`{"type":"response.incomplete","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":"content_filter"}}}`,
			"Response incomplete: content_filter",
		},
		{
			"error event without a message",
			`{"type":"error","code":"server_error"}`,
			"server_error: undefined",
		},
		{
			"error event with a null message",
			`{"type":"error","code":"server_error","message":null}`,
			"server_error: null",
		},
		{
			"error event without a code",
			`{"type":"error","message":"boom"}`,
			"unknown: boom",
		},
		{
			"error event with an explicit empty code",
			`{"type":"error","code":"","message":"boom"}`,
			": boom",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.ReadAll(r.Body)
				responsesSSE(w, c.event)
			}))
			defer srv.Close()

			client, _ := newOpenAIClient(&config.ProviderConfig{
				BaseURL: srv.URL, APIKey: "k", Model: "gpt-x", Protocol: "openai",
			}, "sys")
			conv := conversation.NewManager()
			conv.AddUserMessage("hello")
			_, err := drainEvents(t, client, conv)
			if err == nil || err.Error() != c.want {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
		})
	}
}
