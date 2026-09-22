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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/packages/param"
	"github.com/openai/openai-go/responses"
	"github.com/openai/openai-go/shared"
)

const openaiStreamIdleTimeout = 5 * time.Minute

// jsonMarshalNoEscape mirrors JSON.stringify: unlike json.Marshal it does not
// HTML-escape <, > and & inside tool-call argument strings.
func jsonMarshalNoEscape(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "{}"
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

type openaiClient struct {
	client          openai.Client
	cfg             *config.ProviderConfig
	model           string
	thinkingLevel   config.ThinkingLevel
	systemPrompt    string
	maxOutputTokens int
}

func newOpenAIClient(cfg *config.ProviderConfig, systemPrompt string) (*openaiClient, error) {
	apiKey := cfg.ResolveAPIKey()
	if apiKey == "" {
		return nil, &AuthenticationError{
			Message: "OpenAI API key not found, set OPENAI_API_KEY in ~/.yukino/config.yaml, or via OPENAI_API_KEY env variable.",
		}
	}

	client := openai.NewClient(
		option.WithAPIKey(apiKey),
		option.WithBaseURL(cfg.BaseURL),
	)

	return &openaiClient{
		client:          client,
		cfg:             cfg,
		model:           cfg.Model,
		thinkingLevel:   config.GetThinkingLevel(cfg),
		systemPrompt:    systemPrompt,
		maxOutputTokens: cfg.GetMaxOutputTokens(),
	}, nil
}

func (c *openaiClient) SetSystemPrompt(prompt string) {
	c.systemPrompt = prompt
}

func (c *openaiClient) Protocol() string { return c.cfg.Protocol }

func (c *openaiClient) GetThinkingLevel() config.ThinkingLevel { return c.thinkingLevel }

func (c *openaiClient) SetThinkingLevel(level config.ThinkingLevel) config.ThinkingLevel {
	c.thinkingLevel = config.ClampThinkingLevel(c.cfg, level)
	return c.thinkingLevel
}

func (c *openaiClient) GetSupportedThinkingLevels() []config.ThinkingLevel {
	return config.GetSupportedThinkingLevels(c.cfg)
}

func (c *openaiClient) SetMaxOutputTokens(tokens int) {
	c.maxOutputTokens = tokens
}

func (c *openaiClient) Stream(ctx context.Context, conv *conversation.Manager, toolSchemas []map[string]any) (<-chan StreamEvent, <-chan error) {
	events := make(chan StreamEvent, 64)
	errs := make(chan error, 1)

	// Ensure tool call/result pairing before sending the request (same rationale as the Anthropic branch).
	// TS pushes the system prompt as the first input item — the Responses
	// `instructions` field is not used.
	input := buildOpenAIInput(conversation.EnsureToolPairing(conv.GetMessages()))
	input = append([]responses.ResponseInputItemUnionParam{
		{
			OfMessage: &responses.EasyInputMessageParam{
				Role: responses.EasyInputMessageRoleSystem,
				Content: responses.EasyInputMessageContentUnionParam{
					OfString: param.NewOpt(c.systemPrompt),
				},
			},
		},
	}, input...)

	var tools []responses.ToolUnionParam

	go func() {
		defer close(events)
		defer close(errs)

		// TS converts the tool schemas inside the generator, so a foreign
		// schema shape surfaces to the consumer as a stream error.
		var err error
		tools, err = toOpenAIResponsesTools(toolSchemas)
		if err != nil {
			errs <- err
			return
		}

		reqParams := responses.ResponseNewParams{
			Model: c.model,
			Input: responses.ResponseNewParamsInputUnion{
				OfInputItemList: input,
			},
			MaxOutputTokens: param.NewOpt(int64(c.maxOutputTokens)),
		}
		// Reasoning wiring mirrors TS openai.ts: the effort comes from the
		// logical thinking level mapped through provider capabilities; "none"
		// explicitly disables server-default reasoning, and a summary is only
		// requested while reasoning is on.
		if effort := config.ToReasoningEffort(c.thinkingLevel, c.cfg); effort != nil {
			reqParams.Reasoning = shared.ReasoningParam{
				Effort: shared.ReasoningEffort(*effort),
			}
			if *effort != "none" {
				reqParams.Reasoning.Summary = shared.ReasoningSummaryAuto
				reqParams.Include = []responses.ResponseIncludable{
					responses.ResponseIncludableReasoningEncryptedContent,
				}
			}
		}
		if len(tools) > 0 {
			reqParams.Tools = tools
		}

		stream := c.client.Responses.NewStreaming(ctx, reqParams)
		defer stream.Close()

		var currentToolName, currentCallID, jsonAccum string
		var reasoningID, reasoningText string
		// Guards against streams that end without a terminal response event
		// (TS: sawTerminalResponse); without it a truncated stream would be
		// silently treated as an empty turn.
		sawTerminalResponse := false

		// Read SSE events in a separate goroutine so we can respect ctx cancellation
		// and detect silent connection drops. The SDK's stream.Next() may block
		// indefinitely if the underlying connection dies without FIN/RST.
		type sseResult struct {
			hasNext bool
		}
		nextCh := make(chan sseResult, 1)

		readNext := func() {
			nextCh <- sseResult{hasNext: stream.Next()}
		}

		idle := time.NewTimer(openaiStreamIdleTimeout)
		defer idle.Stop()

		go readNext()
		for {
			var res sseResult
			select {
			case <-ctx.Done():
				errs <- &NetworkError{Message: fmt.Sprintf("context cancelled: %v", ctx.Err())}
				return
			case <-idle.C:
				errs <- &NetworkError{Message: fmt.Sprintf("stream idle timeout: no SSE events for %s", openaiStreamIdleTimeout)}
				return
			case res = <-nextCh:
			}

			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(openaiStreamIdleTimeout)

			if !res.hasNext {
				break
			}

			event := stream.Current()
			switch event.Type {
			case "response.output_text.delta":
				events <- TextDelta{Text: event.Delta.OfString}
			case "response.output_item.added":
				switch event.Item.Type {
				case "function_call":
					currentToolName = event.Item.Name
					currentCallID = event.Item.CallID
					jsonAccum = ""
					events <- ToolCallStart{ToolName: currentToolName, ToolID: currentCallID}
				case "computer_call":
					events <- ToolCallStart{ToolName: "ComputerUse", ToolID: event.Item.CallID}
				case "reasoning":
					reasoningID = event.Item.ID
					reasoningText = ""
				}
			case "response.reasoning_summary_text.delta":
				reasoningText += event.Delta.OfString
				events <- ThinkingDelta{Text: event.Delta.OfString}
			case "response.reasoning_summary_text.done":
				events <- ThinkingComplete{Thinking: reasoningText, Signature: reasoningID}
			case "response.function_call_arguments.delta":
				jsonAccum += event.Delta.OfString
				events <- ToolCallDelta{Text: event.Delta.OfString}
			case "response.output_item.done":
				// TS completes tool calls on output_item.done (not on the
				// arguments-done event), so computer_call items get their
				// completion too.
				switch event.Item.Type {
				case "function_call":
					if currentToolName == "" {
						break
					}
					var args map[string]any
					if jsonAccum != "" {
						if err := json.Unmarshal([]byte(jsonAccum), &args); err != nil {
							// TS: log.error({err}, "llm operation failed"), args = {}
							log.Error("llm operation failed", "err", err)
						}
					}
					if args == nil {
						args = map[string]any{}
					}
					events <- ToolCallComplete{
						ToolID:    currentCallID,
						ToolName:  currentToolName,
						Arguments: args,
					}
					currentToolName = ""
					currentCallID = ""
					jsonAccum = ""
				case "computer_call":
					events <- ToolCallComplete{
						ToolID:         event.Item.CallID,
						ToolName:       "ComputerUse",
						Arguments:      computerCallArguments(event.Item.RawJSON()),
						ProviderItemID: event.Item.ID,
					}
				}
			case "response.completed", "response.incomplete":
				sawTerminalResponse = true
				usage := UsageInfo{}
				// TS: `if (usage)` is a pure presence check on the terminal
				// response's usage object; the SDK exposes exactly that through
				// the response's JSON metadata (not through a non-zero test,
				// which would drop a legitimate all-zero usage report).
				if event.Response.JSON.Usage.Valid() {
					usage.InputTokens = int(event.Response.Usage.InputTokens)
					usage.OutputTokens = int(event.Response.Usage.OutputTokens)
					// cache_read from input_tokens_details.cached_tokens; the
					// Responses API has no cache_creation counterpart, so it's 0.
					usage.CacheReadTokens = int(event.Response.Usage.InputTokensDetails.CachedTokens)
					// input_tokens already includes the cached prefix; subtract so the
					// usage anchor (input + cache_read) doesn't double-count it.
					usage.InputTokens -= usage.CacheReadTokens
					if usage.InputTokens < 0 {
						usage.InputTokens = 0
					}
				}
				// Parse the actual stop reason from the Responses API. When the
				// response is incomplete, check incomplete_details.reason for
				// "max_output_tokens" so the agent loop's max_tokens recovery can
				// trigger; otherwise default to "end_turn".
				stopReason := "end_turn"
				if event.Type == "response.incomplete" || event.Response.Status == "incomplete" {
					reason := event.Response.IncompleteDetails.Reason
					if reason == "max_output_tokens" {
						stopReason = "max_tokens"
					} else {
						// TS: `details?.reason ?? "unknown reason"` — ?? only
						// falls back on nullish, so an explicit empty string
						// stays empty. Valid() is false exactly for absent or
						// JSON-null fields.
						if !event.Response.IncompleteDetails.JSON.Reason.Valid() {
							reason = "unknown reason"
						}
						errs <- &LLMError{Message: fmt.Sprintf("Response incomplete: %s", reason)}
						return
					}
				}
				events <- StreamEnd{StopReason: stopReason, Usage: usage}
			case "response.failed":
				// TS: `${error?.code ?? "unknown"}: ${error?.message ?? "Response failed"}`
				// — the fallbacks only trigger on nullish, not on empty strings.
				code := "unknown"
				if event.Response.Error.JSON.Code.Valid() {
					code = string(event.Response.Error.Code)
				}
				message := "Response failed"
				if event.Response.Error.JSON.Message.Valid() {
					message = event.Response.Error.Message
				}
				msg := fmt.Sprintf("%s: %s", code, message)
				if ContainsContextLengthError(msg) {
					errs <- &ContextTooLongError{Message: msg}
				} else {
					errs <- &LLMError{Message: msg}
				}
				return
			case "error":
				// TS: `${event.code ?? "unknown"}: ${event.message}` — the
				// message has no fallback at all, so the template literal
				// renders a missing field as JS's "undefined" and an explicit
				// null (or any other JSON value) as its raw text.
				code := "unknown"
				if event.JSON.Code.Valid() {
					code = event.Code
				}
				message := "undefined"
				if event.JSON.Message.Valid() {
					message = event.Message
				} else if raw := event.JSON.Message.Raw(); raw != "" {
					message = raw
				}
				msg := fmt.Sprintf("%s: %s", code, message)
				if ContainsContextLengthError(msg) {
					errs <- &ContextTooLongError{Message: msg}
				} else {
					errs <- &LLMError{Message: msg}
				}
				return
			}

			go readNext()
		}

		if err := stream.Err(); err != nil {
			// TS logs in the generic catch before classifying (openai.ts:413).
			log.Error("llm operation failed", "err", err)
			errs <- classifyOpenAIError(err)
			return
		}
		if !sawTerminalResponse {
			errs <- &NetworkError{Message: "OpenAI Responses stream ended before a terminal response event"}
		}
	}()

	return events, errs
}

// toOpenAIResponsesTools mirrors TS toOpenAIResponsesTool: the anthropic
// input_schema shape is converted first (strict defaults to false), an
// already-Responses-shaped schema ({type:"function", parameters}) passes
// through untouched, and anything else fails with the TS wording.
func toOpenAIResponsesTools(toolSchemas []map[string]any) ([]responses.ToolUnionParam, error) {
	var tools []responses.ToolUnionParam
	for _, s := range toolSchemas {
		if inputSchema, ok := s["input_schema"].(map[string]any); ok {
			strict, _ := s["strict"].(bool) // `tool.strict ?? false`
			tool := &responses.FunctionToolParam{
				Name:       stringArgOr(s, "name"),
				Parameters: inputSchema,
				Strict:     param.NewOpt(strict),
			}
			// TS omits an absent description; a present empty string is sent.
			if desc, ok := s["description"].(string); ok {
				tool.Description = param.NewOpt(desc)
			}
			tools = append(tools, responses.ToolUnionParam{OfFunction: tool})
			continue
		}
		// Passthrough: `{...schema}` for a Responses-shaped function tool.
		if t, _ := s["type"].(string); t == "function" {
			if params, ok := s["parameters"].(map[string]any); ok {
				tool := &responses.FunctionToolParam{
					Name:       stringArgOr(s, "name"),
					Parameters: params,
				}
				if desc, ok := s["description"].(string); ok {
					tool.Description = param.NewOpt(desc)
				}
				if strict, ok := s["strict"].(bool); ok {
					tool.Strict = param.NewOpt(strict)
				}
				tools = append(tools, responses.ToolUnionParam{OfFunction: tool})
				continue
			}
		}
		return nil, errors.New("OpenAI Responses received a tool schema serialized for another protocol.")
	}
	return tools, nil
}

// stringArgOr returns the string value at key, or "" when absent/non-string.
func stringArgOr(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// buildOpenAIInput converts Yukino's conversation into Responses API input
// items (TS: buildOpenAIInput): assistant tool calls become function_call
// items (ComputerUse calls become computer_call items), tool results become
// function_call_output / computer_call_output items, and user messages carry
// structured text/image parts.
func buildOpenAIInput(messages []conversation.Message) responses.ResponseInputParam {
	var input responses.ResponseInputParam

	// Pre-scan ComputerUse tool uses so their results can be answered with
	// computer_call_output items (TS: computerCalls map).
	computerCalls := make(map[string]conversation.ToolUseBlock)
	for _, m := range messages {
		for _, tu := range m.ToolUses {
			if tu.ToolName == "ComputerUse" {
				computerCalls[tu.ToolUseID] = tu
			}
		}
	}

	for _, m := range messages {
		for _, tb := range m.ThinkingBlocks {
			input = append(input, responses.ResponseInputItemParamOfReasoning(
				tb.Signature,
				[]responses.ResponseReasoningItemSummaryParam{{Text: tb.Thinking}},
			))
		}

		switch {
		case len(m.ToolUses) > 0:
			if text := assistantText(m); text != "" {
				input = append(input, userOrAssistantMessage(responses.EasyInputMessageRoleAssistant, text))
			}
			for _, tu := range m.ToolUses {
				if tu.ToolName == "ComputerUse" {
					input = append(input, computerCallInput(tu))
					continue
				}
				// TS: JSON.stringify — no HTML escaping of <, > and &.
				input = append(input, responses.ResponseInputItemUnionParam{
					OfFunctionCall: &responses.ResponseFunctionToolCallParam{
						Name:      tu.ToolName,
						CallID:    tu.ToolUseID,
						Arguments: jsonMarshalNoEscape(tu.Arguments),
					},
				})
			}
		case len(m.ToolResults) > 0:
			for _, tr := range m.ToolResults {
				computerCall, isComputer := computerCalls[tr.ToolUseID]
				if isComputer {
					item, imageURL := computerCallOutputInput(tr, computerCall)
					input = append(input, item)
					// TS: an errored result, or one without a screenshot, is
					// additionally re-sent as a plain user message.
					if tr.IsError || imageURL == "" {
						input = append(input, userOrAssistantMessage(responses.EasyInputMessageRoleUser, tr.Content))
					}
					continue
				}
				output, rich := toolOutputForResponses(tr)
				out := &responses.ResponseInputItemFunctionCallOutputParam{
					CallID: tr.ToolUseID,
					Output: output,
				}
				if len(rich) > 0 {
					// The Go SDK models function_call_output.output as a plain
					// string while the TS SDK accepts the rich item list;
					// inject it through the SDK's extra-fields extension so
					// the wire format matches TS.
					out.SetExtraFields(map[string]any{"output": rich})
				}
				input = append(input, responses.ResponseInputItemUnionParam{OfFunctionCallOutput: out})
			}
			if m.Content != "" || len(m.ContentBlocks) > 0 {
				input = append(input, responses.ResponseInputItemUnionParam{
					OfMessage: &responses.EasyInputMessageParam{
						Role:    responses.EasyInputMessageRoleUser,
						Content: userContentsFor(m),
					},
				})
			}
		case m.Role == "assistant":
			input = append(input, userOrAssistantMessage(responses.EasyInputMessageRoleAssistant, assistantText(m)))
		default:
			// TS pushes the message's own role here ("user" or "system").
			role := responses.EasyInputMessageRoleUser
			if m.Role == "system" {
				role = responses.EasyInputMessageRoleSystem
			}
			input = append(input, responses.ResponseInputItemUnionParam{
				OfMessage: &responses.EasyInputMessageParam{
					Role:    role,
					Content: userContentsFor(m),
				},
			})
		}
	}
	return input
}

// userOrAssistantMessage builds a plain-text EasyInputMessage item.
func userOrAssistantMessage(role responses.EasyInputMessageRole, text string) responses.ResponseInputItemUnionParam {
	return responses.ResponseInputItemUnionParam{
		OfMessage: &responses.EasyInputMessageParam{
			Role: role,
			Content: responses.EasyInputMessageContentUnionParam{
				OfString: param.NewOpt(text),
			},
		},
	}
}

// computerCallInput mirrors the TS computer_call input item. The Go SDK
// predates the batched `actions` field (it models the older singular
// `action`), so the action list and the pending safety checks are injected
// through the SDK's extra-fields extension to match the TS wire format.
func computerCallInput(tu conversation.ToolUseBlock) responses.ResponseInputItemUnionParam {
	status := responses.ResponseComputerToolCallStatusCompleted
	switch s, _ := tu.Arguments["status"].(string); s {
	case "in_progress":
		status = responses.ResponseComputerToolCallStatusInProgress
	case "incomplete":
		status = responses.ResponseComputerToolCallStatusIncomplete
	}
	id := tu.ProviderItemID
	if id == "" {
		id = tu.ToolUseID
	}
	call := &responses.ResponseComputerToolCallParam{
		ID:     id,
		CallID: tu.ToolUseID,
		Status: status,
	}
	checks := safetyChecksForResponses(tu.Arguments)
	if checks == nil {
		// TS always sends the array ([] when there are no checks).
		checks = []map[string]any{}
	}
	call.SetExtraFields(map[string]any{
		"actions":               computerActionsForResponses(tu.Arguments),
		"pending_safety_checks": checks,
	})
	return responses.ResponseInputItemUnionParam{OfComputerCall: call}
}

// computerCallOutputInput mirrors the TS computer_call_output item: the
// result's first image block becomes the screenshot. The screenshot URL is
// returned so the caller can decide whether the text needs re-sending.
func computerCallOutputInput(tr conversation.ToolResultBlock, computerCall conversation.ToolUseBlock) (responses.ResponseInputItemUnionParam, string) {
	imageURL := computerScreenshotUrl(tr)
	output := responses.ResponseComputerToolCallOutputScreenshotParam{}
	if imageURL != "" {
		output.ImageURL = param.NewOpt(imageURL)
	}
	var checks []responses.ResponseInputItemComputerCallOutputAcknowledgedSafetyCheckParam
	for _, check := range safetyChecksForResponses(computerCall.Arguments) {
		item := responses.ResponseInputItemComputerCallOutputAcknowledgedSafetyCheckParam{
			ID: check["id"].(string),
		}
		if code, ok := check["code"].(string); ok {
			item.Code = param.NewOpt(code)
		}
		if message, ok := check["message"].(string); ok {
			item.Message = param.NewOpt(message)
		}
		checks = append(checks, item)
	}
	return responses.ResponseInputItemUnionParam{
		OfComputerCallOutput: &responses.ResponseInputItemComputerCallOutputParam{
			CallID:                   tr.ToolUseID,
			Output:                   output,
			AcknowledgedSafetyChecks: checks,
		},
	}, imageURL
}

// openaiAPIMessage renders err.message exactly like the TS SDK: the OpenAI
// SDK's makeMessage keys off the body's "error" object (which is also the
// slice openai-go keeps in RawJSON()), yielding "<status> <error.message>".
// The Go SDK's Error() renders a request dump instead, so it is rebuilt here.
func openaiAPIMessage(apiErr *openai.Error) string {
	// The parsed body field is makeMessage's primary branch (error.message as a
	// string); it also covers errors the SDK built without retaining the raw
	// slice.
	if apiErr.Message != "" {
		if apiErr.StatusCode != 0 {
			return fmt.Sprintf("%d %s", apiErr.StatusCode, apiErr.Message)
		}
		return apiErr.Message
	}
	raw := apiErr.RawJSON()
	var body any
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		body = nil
	}
	return stainlessMakeMessage(apiErr.StatusCode, body, raw)
}

func classifyOpenAIError(err error) error {
	// TS: already-classified errors pass through unchanged.
	switch err.(type) {
	case *LLMError, *AuthenticationError, *RateLimitError, *NetworkError, *ContextTooLongError:
		return err
	}
	var apiErr *openai.Error
	if errors.As(err, &apiErr) {
		message := openaiAPIMessage(apiErr)
		if apiErr.StatusCode == 413 || (apiErr.StatusCode == 400 && ContainsContextLengthError(message)) {
			return &ContextTooLongError{Message: fmt.Sprintf("Context Too Long: %s", message)}
		}
		switch apiErr.StatusCode {
		case 401:
			return &AuthenticationError{Message: fmt.Sprintf("Invalid API key: %s", message)}
		case 429:
			retry := ""
			if apiErr.Response != nil {
				retry = apiErr.Response.Header.Get("Retry-After")
			}
			return &RateLimitError{Message: "Rate limit error, please wait.", RetryAfter: retry}
		default:
			return &LLMError{Message: fmt.Sprintf("OpenAI API error (%d): %s", apiErr.StatusCode, message)}
		}
	}
	// Transport-level failures: the TS SDK wraps them in APIError subclasses
	// with an undefined status, so the classifier renders the connection text.
	return classifyTransportError(err, "OpenAI")
}
