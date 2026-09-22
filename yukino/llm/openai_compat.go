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
	"fmt"
	std_log "log"
	"os"
	"strings"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/packages/param"
	"github.com/openai/openai-go/shared"
)

const openaiCompatStreamIdleTimeout = 5 * time.Minute

type openaiCompatClient struct {
	client          openai.Client
	cfg             *config.ProviderConfig
	model           string
	thinkingLevel   config.ThinkingLevel
	systemPrompt    string
	maxOutputTokens int
}

func newOpenAICompatClient(cfg *config.ProviderConfig, systemPrompt string) (*openaiCompatClient, error) {
	apiKey := cfg.ResolveAPIKey()
	if apiKey == "" {
		return nil, &AuthenticationError{
			Message: "OpenAI API key not found. Set OPENAI_API_KEY in ~/.yukino/config.yaml, or via OPENAI_API_KEY env variable.",
		}
	}

	opts := []option.RequestOption{
		option.WithAPIKey(apiKey),
		option.WithBaseURL(cfg.BaseURL),
	}
	if os.Getenv("YUKINO_LLM_DEBUG") != "" {
		opts = append(opts, option.WithDebugLog(std_log.New(os.Stderr, "[llm] ", std_log.LstdFlags)))
	}
	client := openai.NewClient(opts...)

	return &openaiCompatClient{
		client:          client,
		cfg:             cfg,
		model:           cfg.Model,
		thinkingLevel:   config.GetThinkingLevel(cfg),
		systemPrompt:    systemPrompt,
		maxOutputTokens: cfg.GetMaxOutputTokens(),
	}, nil
}

func (c *openaiCompatClient) SetSystemPrompt(prompt string) {
	c.systemPrompt = prompt
}

func (c *openaiCompatClient) Protocol() string { return c.cfg.Protocol }

func (c *openaiCompatClient) GetThinkingLevel() config.ThinkingLevel { return c.thinkingLevel }

func (c *openaiCompatClient) SetThinkingLevel(level config.ThinkingLevel) config.ThinkingLevel {
	c.thinkingLevel = config.ClampThinkingLevel(c.cfg, level)
	return c.thinkingLevel
}

func (c *openaiCompatClient) GetSupportedThinkingLevels() []config.ThinkingLevel {
	return config.GetSupportedThinkingLevels(c.cfg)
}

// SetMaxOutputTokens implements MaxTokensSetter so the agent loop's
// max_tokens recovery can raise/lower the output cap between turns.
func (c *openaiCompatClient) SetMaxOutputTokens(tokens int) {
	c.maxOutputTokens = tokens
}

func (c *openaiCompatClient) Stream(ctx context.Context, conv *conversation.Manager, toolSchemas []map[string]any) (<-chan StreamEvent, <-chan error) {
	events := make(chan StreamEvent, 64)
	errs := make(chan error, 1)

	// Ensure tool call/result pairing before sending the request (same rationale as the Anthropic branch).
	messages := buildChatCompletionMessages(c.systemPrompt, conversation.EnsureToolPairing(conv.GetMessages()))

	var tools []openai.ChatCompletionToolParam

	go func() {
		defer close(events)
		defer close(errs)

		// TS converts the tool schemas inside the generator, so a foreign
		// schema shape surfaces to the consumer as a stream error.
		var err error
		tools, err = toOpenAICompatTools(toolSchemas)
		if err != nil {
			errs <- err
			return
		}

		reqParams := openai.ChatCompletionNewParams{
			Model:    c.model,
			Messages: messages,
			StreamOptions: openai.ChatCompletionStreamOptionsParam{
				IncludeUsage: param.NewOpt(true),
			},
			MaxTokens: param.NewOpt(int64(c.maxOutputTokens)),
		}
		// TS sends the effort whenever the mapping yields one, including
		// "none": configured non-reasoning providers omit the field (nil
		// effort), while off otherwise sends none explicitly so a server
		// default cannot silently enable reasoning (openai.ts compat client).
		if effort := config.ToReasoningEffort(c.thinkingLevel, c.cfg); effort != nil {
			reqParams.ReasoningEffort = shared.ReasoningEffort(*effort)
		}
		if len(tools) > 0 {
			reqParams.Tools = tools
		}

		stream := c.client.Chat.Completions.NewStreaming(ctx, reqParams)
		defer stream.Close()

		// Track tool calls being assembled across multiple chunks.
		// The Chat Completions API sends tool call information incrementally:
		// the first chunk for a given index carries the ID and function name,
		// subsequent chunks carry argument fragments. toolCallOrder preserves
		// first-seen index order so completions emit in arrival order (TS
		// iterates a Map, which is insertion-ordered).
		type toolCallAccum struct {
			id       string
			name     string
			argsJSON string
		}
		toolCalls := make(map[int64]*toolCallAccum)
		var toolCallOrder []int64
		var reasoningAccum string
		// Accumulated across chunks (TS: finishReason, null until seen): the
		// finish_reason chunk and the usage chunk may arrive separately — or
		// fused into one event on some compat servers (iFlytek MaaS) — and the
		// single StreamEnd is emitted after the loop from these accumulators.
		// enum: "length" | "tool_calls" | "stop"; "" means not seen yet.
		var finishReason string
		var inputTokens, outputTokens, cacheReadTokens int

		// Read SSE events in a separate goroutine so we can respect ctx cancellation
		// and detect silent connection drops, same pattern as the openai Responses client.
		type sseResult struct {
			hasNext bool
		}
		nextCh := make(chan sseResult, 1)

		readNext := func() {
			nextCh <- sseResult{hasNext: stream.Next()}
		}

		idle := time.NewTimer(openaiCompatStreamIdleTimeout)
		defer idle.Stop()

		go readNext()
		for {
			var res sseResult
			select {
			case <-ctx.Done():
				errs <- &NetworkError{Message: fmt.Sprintf("context cancelled: %v", ctx.Err())}
				return
			case <-idle.C:
				errs <- &NetworkError{Message: fmt.Sprintf("stream idle timeout: no SSE events for %s", openaiCompatStreamIdleTimeout)}
				return
			case res = <-nextCh:
			}

			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(openaiCompatStreamIdleTimeout)

			if !res.hasNext {
				break
			}

			chunk := stream.Current()

			// Usage may arrive in a trailing chunk with empty choices, so
			// check it before the delta guard.
			if chunk.JSON.Usage.Valid() {
				outputTokens = int(chunk.Usage.CompletionTokens)
				cacheReadTokens = int(chunk.Usage.PromptTokensDetails.CachedTokens)
				inputTokens = max(int(chunk.Usage.PromptTokens)-cacheReadTokens, 0)
			}

			if len(chunk.Choices) == 0 {
				go readNext()
				continue
			}
			choice := chunk.Choices[0]
			delta := choice.Delta

			if delta.Content != "" {
				events <- TextDelta{Text: delta.Content}
			}

			// Providers such as DeepSeek and Xiaomi transmit thinking content via the
			// non-standard reasoning_content field in Chat Completions deltas. The SDK
			// does not model it directly, so we extract it from ExtraFields.
			if rc, ok := delta.JSON.ExtraFields["reasoning_content"]; ok && rc.Valid() {
				raw := rc.Raw()
				if len(raw) >= 2 && raw[0] == '"' {
					var text string
					if json.Unmarshal([]byte(raw), &text) == nil && text != "" {
						reasoningAccum += text
						events <- ThinkingDelta{Text: text}
					}
				}
			}

			for _, tc := range delta.ToolCalls {
				acc, exists := toolCalls[tc.Index]
				if !exists {
					// TS emits tool_call_start exactly once per index, on the
					// first chunk that carries an id; later chunks only update
					// the accumulator (a repeated name must not re-emit).
					acc = &toolCallAccum{id: tc.ID, name: tc.Function.Name}
					toolCalls[tc.Index] = acc
					toolCallOrder = append(toolCallOrder, tc.Index)
					if tc.ID != "" {
						events <- ToolCallStart{ToolName: tc.Function.Name, ToolID: tc.ID}
					}
				} else {
					if tc.ID != "" {
						acc.id = tc.ID
					}
					if tc.Function.Name != "" {
						acc.name = tc.Function.Name
					}
				}
				if tc.Function.Arguments != "" {
					acc.argsJSON += tc.Function.Arguments
					events <- ToolCallDelta{Text: tc.Function.Arguments}
				}
			}

			if choice.FinishReason != "" {
				finishReason = choice.FinishReason
				if reasoningAccum != "" {
					events <- ThinkingComplete{Thinking: reasoningAccum}
					reasoningAccum = ""
				}
				for _, idx := range toolCallOrder {
					acc := toolCalls[idx]
					var args map[string]any
					if acc.argsJSON != "" {
						if err := json.Unmarshal([]byte(acc.argsJSON), &args); err != nil {
							// TS: log.error({err}, "llm operation failed"), args = {}
							log.Error("llm operation failed", "err", err)
						}
					}
					if args == nil {
						args = map[string]any{}
					}
					// Emit unconditionally: some compat servers send "" (or nothing)
					// instead of "{}" for no-argument tool calls, and gating the
					// completion on non-empty arguments would silently drop the call.
					events <- ToolCallComplete{
						ToolID:    acc.id,
						ToolName:  acc.name,
						Arguments: args,
					}
				}
			}

			go readNext()
		}

		if err := stream.Err(); err != nil {
			// TS logs in the generic catch before classifying (openai.ts:1030).
			log.Error("llm operation failed", "err", err)
			errs <- classifyOpenAIError(err)
			return
		}
		if finishReason == "" {
			errs <- &NetworkError{Message: "Chat Completions stream ended before a finish reason"}
			return
		}

		// Map Chat Completions finish_reason to Yukino's internal stop reason:
		// "length" means the model hit max_tokens, "tool_calls" means tool use,
		// "stop" (or anything else) means normal end_turn. The tool-call count
		// is a fallback for servers that finish with "stop" despite streaming
		// tool calls.
		var stopReason string
		switch {
		case finishReason == "length":
			stopReason = "max_tokens"
		case finishReason == "tool_calls" || len(toolCalls) > 0:
			stopReason = "tool_use"
		default:
			stopReason = "end_turn"
		}

		events <- StreamEnd{
			StopReason: stopReason,
			Usage: UsageInfo{
				InputTokens:     inputTokens,
				OutputTokens:    outputTokens,
				CacheReadTokens: cacheReadTokens,
			},
		}
	}()

	return events, errs
}

// toOpenAICompatTools mirrors TS toOpenAICompatTool: the anthropic
// input_schema shape is converted first (nested under "function", strict
// defaults to false), an already-Chat-Completions-shaped schema
// ({type:"function", function}) passes through untouched, and anything else
// fails with the TS wording.
func toOpenAICompatTools(toolSchemas []map[string]any) ([]openai.ChatCompletionToolParam, error) {
	var tools []openai.ChatCompletionToolParam
	for _, s := range toolSchemas {
		if inputSchema, ok := s["input_schema"].(map[string]any); ok {
			strict, _ := s["strict"].(bool) // `tool.strict ?? false`
			fn := shared.FunctionDefinitionParam{
				Name:       stringArgOr(s, "name"),
				Parameters: shared.FunctionParameters(inputSchema),
				Strict:     param.NewOpt(strict),
			}
			// TS omits an absent description; a present empty string is sent.
			if desc, ok := s["description"].(string); ok {
				fn.Description = param.NewOpt(desc)
			}
			tools = append(tools, openai.ChatCompletionToolParam{Function: fn})
			continue
		}
		// Passthrough: `{...schema}` for a Chat Completions function tool.
		if rawFn, ok := s["function"].(map[string]any); ok {
			fn := shared.FunctionDefinitionParam{}
			if params, ok := rawFn["parameters"].(map[string]any); ok {
				fn.Parameters = shared.FunctionParameters(params)
			}
			fn.Name = stringArgOr(rawFn, "name")
			if desc, ok := rawFn["description"].(string); ok {
				fn.Description = param.NewOpt(desc)
			}
			if strict, ok := rawFn["strict"].(bool); ok {
				fn.Strict = param.NewOpt(strict)
			}
			tools = append(tools, openai.ChatCompletionToolParam{Function: fn})
			continue
		}
		return nil, errors.New("OpenAI Chat Completions received a tool schema serialized for another protocol.")
	}
	return tools, nil
}

// buildChatCompletionMessages converts Yukino's conversation into Chat Completions
// messages (TS: buildChatCompletionMessages), preserving assistant tool_calls and
// tool_results (role: "tool") turns so multi-turn tool use works over the
// openai-compat endpoint. Thinking blocks are sent back as the reasoning_content
// field of assistant messages for providers that support it (e.g. DeepSeek, Xiaomi).
func buildChatCompletionMessages(systemPrompt string, messages []conversation.Message) []openai.ChatCompletionMessageParamUnion {
	var result []openai.ChatCompletionMessageParamUnion

	// System prompt as the first message (TS pushes it unconditionally, even
	// when empty).
	result = append(result, openai.SystemMessage(systemPrompt))

	for _, m := range messages {
		var reasoning strings.Builder
		for _, tb := range m.ThinkingBlocks {
			reasoning.WriteString(tb.Thinking)
		}
		text := assistantText(m)

		switch {
		case len(m.ToolUses) > 0:
			assistant := openai.ChatCompletionAssistantMessageParam{}
			extras := map[string]any{}
			if text != "" {
				assistant.Content.OfString = param.NewOpt(text)
			} else {
				// TS sends content: null on a tool-call turn without text;
				// the SDK union cannot express null, so it is injected via
				// the extra-fields extension.
				extras["content"] = nil
			}
			for _, tu := range m.ToolUses {
				// TS: JSON.stringify — no HTML escaping of <, > and &.
				assistant.ToolCalls = append(assistant.ToolCalls, openai.ChatCompletionMessageToolCallParam{
					ID: tu.ToolUseID,
					Function: openai.ChatCompletionMessageToolCallFunctionParam{
						Name:      tu.ToolName,
						Arguments: jsonMarshalNoEscape(tu.Arguments),
					},
				})
			}
			if reasoning.Len() > 0 {
				extras["reasoning_content"] = reasoning.String()
			}
			if len(extras) > 0 {
				assistant.SetExtraFields(extras)
			}
			result = append(result, openai.ChatCompletionMessageParamUnion{OfAssistant: &assistant})
		case len(m.ToolResults) > 0:
			// Rich content blocks (images/documents) do not fit the tool
			// role's string content, so TS collects them into a follow-up
			// user message with a marker attributing them to the tool call.
			var richParts []openai.ChatCompletionContentPartUnionParam
			for _, tr := range m.ToolResults {
				result = append(result, openai.ToolMessage(tr.Content, tr.ToolUseID))
				richParts = append(richParts, collectRichParts(tr)...)
			}
			if m.Content != "" || len(m.ContentBlocks) > 0 {
				if parts := userPartsFor(m); parts != nil {
					richParts = append(richParts, parts...)
				} else {
					richParts = append(richParts, openai.ChatCompletionContentPartUnionParam{
						OfText: &openai.ChatCompletionContentPartTextParam{Text: m.Content},
					})
				}
			}
			if len(richParts) > 0 {
				user := openai.ChatCompletionUserMessageParam{
					Content: openai.ChatCompletionUserMessageParamContentUnion{
						OfArrayOfContentParts: richParts,
					},
				}
				result = append(result, openai.ChatCompletionMessageParamUnion{OfUser: &user})
			}
		case m.Role == "assistant":
			assistant := openai.ChatCompletionAssistantMessageParam{}
			assistant.Content.OfString = param.NewOpt(text)
			if reasoning.Len() > 0 {
				assistant.SetExtraFields(map[string]any{"reasoning_content": reasoning.String()})
			}
			result = append(result, openai.ChatCompletionMessageParamUnion{OfAssistant: &assistant})
		case m.Role == "system":
			result = append(result, openai.SystemMessage(text))
		default:
			if parts := userPartsFor(m); parts != nil {
				user := openai.ChatCompletionUserMessageParam{
					Content: openai.ChatCompletionUserMessageParamContentUnion{
						OfArrayOfContentParts: parts,
					},
				}
				result = append(result, openai.ChatCompletionMessageParamUnion{OfUser: &user})
			} else {
				result = append(result, openai.UserMessage(m.Content))
			}
		}
	}

	return result
}
