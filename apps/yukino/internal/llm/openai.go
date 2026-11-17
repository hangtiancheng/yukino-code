package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/packages/param"
	"github.com/openai/openai-go/responses"
	"github.com/openai/openai-go/shared"
)

const openaiStreamIdleTimeout = 5 * time.Minute

type openaiClient struct {
	client          openai.Client
	model           string
	cfg             config.ProviderConfig
	thinkingLevel   string
	systemPrompt    string
	maxOutputTokens int
}

func newOpenAIClient(cfg *config.ProviderConfig, systemPrompt string) (*openaiClient, error) {
	apiKey := config.ResolveAPIKey(cfg)
	if apiKey == "" {
		return nil, &AuthenticationError{
			Message: OpenAIAPIKeyMissingError,
		}
	}

	client := openai.NewClient(
		option.WithAPIKey(apiKey),
		option.WithBaseURL(cfg.BaseURL),
	)

	return &openaiClient{
		client:          client,
		model:           cfg.Model,
		cfg:             *cfg,
		thinkingLevel:   config.GetThinkingLevel(cfg),
		systemPrompt:    systemPrompt,
		maxOutputTokens: config.GetMaxOutputTokens(cfg),
	}, nil
}

func (c *openaiClient) SetSystemPrompt(prompt string) {
	c.systemPrompt = prompt
}

func (c *openaiClient) Protocol() string { return "openai" }

func (c *openaiClient) SetMaxOutputTokens(tokens int) {
	c.maxOutputTokens = tokens
}

func (c *openaiClient) SetThinkingLevel(level string) string {
	c.thinkingLevel = config.ClampThinkingLevel(&c.cfg, level)
	return c.thinkingLevel
}

func (c *openaiClient) GetThinkingLevel() string {
	return c.thinkingLevel
}

func (c *openaiClient) GetSupportedThinkingLevels() []string {
	return config.GetSupportedThinkingLevels(&c.cfg)
}

func (c *openaiClient) GetOutputBudget() OutputBudget {
	return OutputBudget{
		MaxOutputTokens: c.maxOutputTokens,
		ThinkingTokens:  config.ThinkingBudgetForProvider(&c.cfg, c.thinkingLevel),
	}
}

func (c *openaiClient) Stream(ctx context.Context, conv *conversation.Manager, toolSchemas []map[string]any) (<-chan StreamEvent, <-chan error) {
	events := make(chan StreamEvent, 64)
	errs := make(chan error, 1)

	input := responses.ResponseInputParam{responses.ResponseInputItemUnionParam{
		OfMessage: &responses.EasyInputMessageParam{
			Role:    responses.EasyInputMessageRoleSystem,
			Content: responses.EasyInputMessageContentUnionParam{OfString: param.NewOpt(c.systemPrompt)},
		},
	}}
	input = append(input, buildOpenAIInput(conversation.EnsureToolPairing(conv.GetMessages()))...)

	var tools []responses.ToolUnionParam
	for _, s := range toolSchemas {
		name, _ := s["name"].(string)
		desc, _ := s["description"].(string)
		params, _ := s["parameters"].(map[string]any)
		strict, _ := s["strict"].(bool)
		tools = append(tools, responses.ToolUnionParam{
			OfFunction: &responses.FunctionToolParam{
				Name:        name,
				Description: param.NewOpt(desc),
				Parameters:  params,
				Strict:      param.NewOpt(strict),
			},
		})
	}

	go func() {
		defer close(events)
		defer close(errs)

		requestConfig := c.cfg
		requestConfig.MaxOutputTokens = float64(maxOutputTokens(ctx, c.maxOutputTokens))
		reqParams := responses.ResponseNewParams{
			MaxOutputTokens: param.NewOpt(int64(config.GetMaxOutputTokens(&requestConfig))),
			Model:           c.model,
			Input: responses.ResponseNewParamsInputUnion{
				OfInputItemList: input,
			},
		}
		// Only explicit reasoning:false omits the field. Off sends none to
		// defeat server-default reasoning; requesting a summary while off is
		// unnecessary.
		if effort := config.ToReasoningEffort(c.GetThinkingLevel(), &c.cfg); effort != "" {
			reqParams.Reasoning = shared.ReasoningParam{
				Effort: shared.ReasoningEffort(effort),
			}
			if effort != "none" {
				reqParams.Reasoning.Summary = shared.ReasoningSummaryAuto
			}
		}
		if len(tools) > 0 {
			reqParams.Tools = tools
		}

		var requestOpts []option.RequestOption
		if retries, ok := maxRetries(ctx); ok {
			requestOpts = append(requestOpts, option.WithMaxRetries(retries))
		}
		stream := c.client.Responses.NewStreaming(ctx, reqParams, requestOpts...)
		defer stream.Close()

		var currentToolName, currentCallID, jsonAccum string
		var reasoningID, reasoningText, reasoningPartText string
		startedComputerCalls := map[string]bool{}
		sawTerminalResponse := false

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
			case "response.reasoning_summary_text.delta":
				reasoningText += event.Delta.OfString
				reasoningPartText += event.Delta.OfString
				events <- ThinkingDelta{Text: event.Delta.OfString}
			case "response.reasoning_summary_text.done":
				if reasoningPartText == "" {
					reasoningText += event.Text
					events <- ThinkingDelta{Text: event.Text}
				}
				reasoningPartText = ""
			case "response.function_call_arguments.delta":
				if currentCallID == "" || currentToolName == "" {
					errs <- &NetworkError{Message: "Responses tool arguments arrived before a valid tool call"}
					return
				}
				jsonAccum += event.Delta.OfString
				events <- ToolCallDelta{Text: event.Delta.OfString}
			case "response.output_item.added":
				switch event.Item.Type {
				case "function_call":
					if event.Item.CallID == "" || event.Item.Name == "" {
						errs <- &NetworkError{Message: "Responses tool call started without a valid id or name"}
						return
					}
					currentToolName = event.Item.Name
					currentCallID = event.Item.CallID
					jsonAccum = ""
					events <- ToolCallStart{ToolName: currentToolName, ToolID: currentCallID}
				case "computer_call":
					if event.Item.CallID == "" || event.Item.ID == "" {
						errs <- &NetworkError{Message: "Responses computer call started without a valid id"}
						return
					}
					startedComputerCalls[event.Item.CallID] = true
					events <- ToolCallStart{ToolName: "ComputerUse", ToolID: event.Item.CallID}
				case "reasoning":
					reasoningID = event.Item.ID
					reasoningText = ""
					reasoningPartText = ""
				}
			case "response.output_item.done":
				switch event.Item.Type {
				case "reasoning":
					if reasoningText != "" {
						events <- ThinkingComplete{Thinking: reasoningText, Signature: reasoningID}
					}
					reasoningID = ""
					reasoningText = ""
					reasoningPartText = ""
				case "function_call":
					if currentCallID == "" || currentToolName == "" {
						errs <- &NetworkError{Message: "Responses tool call completed without a valid start event"}
						return
					}
					raw := jsonAccum
					if strings.TrimSpace(raw) == "" {
						raw = event.Item.Arguments
					}
					args, parseError := ParseToolArguments(raw)
					events <- ToolCallComplete{
						ToolID:     currentCallID,
						ToolName:   currentToolName,
						Arguments:  args,
						ParseError: parseError,
					}
					currentToolName = ""
					currentCallID = ""
					jsonAccum = ""
				case "computer_call":
					if event.Item.CallID == "" || event.Item.ID == "" || !startedComputerCalls[event.Item.CallID] {
						errs <- &NetworkError{Message: "Responses computer call completed without a valid start event"}
						return
					}
					delete(startedComputerCalls, event.Item.CallID)
					var raw map[string]any
					if err := json.Unmarshal([]byte(event.Item.RawJSON()), &raw); err != nil {
						errs <- &NetworkError{Message: err.Error()}
						return
					}
					events <- ToolCallComplete{ToolName: "ComputerUse", ToolID: event.Item.CallID, ProviderItemID: event.Item.ID, Arguments: computerCallArguments(raw)}
				}
			case "response.completed", "response.incomplete":
				sawTerminalResponse = true
				usage := UsageInfo{}
				rawUsage := event.Response.Usage
				usage.OutputTokens = int(rawUsage.OutputTokens)
				usage.CacheReadTokens = int(rawUsage.InputTokensDetails.CachedTokens)
				usage.InputTokens = int(rawUsage.InputTokens) - usage.CacheReadTokens
				if usage.InputTokens < 0 {
					usage.InputTokens = 0
				}
				stopReason := "end_turn"
				if event.Type == "response.incomplete" || event.Response.Status == "incomplete" {
					reason := event.Response.IncompleteDetails.Reason
					if reason == "max_output_tokens" {
						stopReason = "max_tokens"
					} else {
						if reason == "" {
							reason = "unknown reason"
						}
						errs <- &LLMError{Message: "Response incomplete: " + reason}
						return
					}
				}
				events <- StreamEnd{StopReason: stopReason, Usage: usage}
			case "response.failed":
				code := string(event.Response.Error.Code)
				if code == "" {
					code = "unknown"
				}
				message := code + ": " + event.Response.Error.Message
				if event.Response.Error.Message == "" {
					message = code + ": Response failed"
				}
				if ContainsContextLengthError(message) {
					errs <- &ContextTooLongError{Message: message}
				} else {
					errs <- &LLMError{Message: message}
				}
				return
			case "error":
				message := event.Message
				if event.Code != "" {
					message = event.Code + ": " + event.Message
				}
				if ContainsContextLengthError(message) {
					errs <- &ContextTooLongError{Message: message}
				} else {
					errs <- &LLMError{Message: message}
				}
				return
			}

			go readNext()
		}

		if err := stream.Err(); err != nil {
			errs <- classifyOpenAIError(err)
			return
		}
		if !sawTerminalResponse {
			errs <- &NetworkError{Message: "OpenAI Responses stream ended before a terminal response event"}
		}
	}()

	return events, errs
}

// imageDataURL mirrors the reference imageDataUrl: url sources pass through;
// base64 sources become data URLs; anything else yields "".
func imageDataURL(block map[string]any) string {
	if block["type"] != "image" {
		return ""
	}
	source, _ := block["source"].(map[string]any)
	if source == nil {
		return ""
	}
	if source["type"] == "url" {
		url, _ := source["url"].(string)
		return url
	}
	if source["type"] != "base64" {
		return ""
	}
	mediaType, _ := source["media_type"].(string)
	data, _ := source["data"].(string)
	if mediaType == "" || data == "" {
		return ""
	}
	return "data:" + mediaType + ";base64," + data
}

// userContentsFor mirrors the reference: string content stays a string; block
// arrays become Responses API parts (text -> input_text, image -> input_image
// data URL with detail auto; other block types are dropped).
func userContentsFor(m conversation.Message) responses.EasyInputMessageContentUnionParam {
	if len(m.ContentBlocks) == 0 {
		return responses.EasyInputMessageContentUnionParam{OfString: param.NewOpt(m.Content)}
	}
	var parts responses.ResponseInputMessageContentListParam
	for _, raw := range m.ContentBlocks {
		block := conversation.NormalizeToolResultContentBlock(raw)
		if block == nil {
			continue
		}
		if block["type"] == "text" {
			text, _ := block["text"].(string)
			parts = append(parts, responses.ResponseInputContentUnionParam{
				OfInputText: &responses.ResponseInputTextParam{Text: text},
			})
			continue
		}
		if url := imageDataURL(block); url != "" {
			parts = append(parts, responses.ResponseInputContentUnionParam{
				OfInputImage: &responses.ResponseInputImageParam{
					Detail:   responses.ResponseInputImageDetailAuto,
					ImageURL: param.NewOpt(url),
				},
			})
		}
	}
	return responses.EasyInputMessageContentUnionParam{OfInputItemContentList: parts}
}

func buildOpenAIInput(messages []conversation.Message) responses.ResponseInputParam {
	var input responses.ResponseInputParam
	computerCalls := map[string]conversation.ToolUseBlock{}
	for _, message := range messages {
		for _, call := range message.ToolUses {
			if call.ToolName == "ComputerUse" {
				computerCalls[call.ToolUseID] = call
			}
		}
	}
	for _, m := range messages {
		for _, tb := range m.ThinkingBlocks {
			if tb.Type != "thinking" || !strings.HasPrefix(tb.Signature, "rs_") {
				continue
			}
			input = append(input, responses.ResponseInputItemParamOfReasoning(
				tb.Signature,
				[]responses.ResponseReasoningItemSummaryParam{{Text: tb.Thinking}},
			))
		}
		if len(m.ToolUses) > 0 {
			if text := m.ContentText(); text != "" {
				input = append(input, responses.ResponseInputItemUnionParam{
					OfMessage: &responses.EasyInputMessageParam{
						Role:    responses.EasyInputMessageRoleAssistant,
						Content: responses.EasyInputMessageContentUnionParam{OfString: param.NewOpt(text)},
					},
				})
			}
			for _, tu := range m.ToolUses {
				if tu.ToolName == "ComputerUse" {
					id := tu.ProviderItemID
					if id == "" {
						id = tu.ToolUseID
					}
					status, _ := tu.Arguments["status"].(string)
					if status != "in_progress" && status != "incomplete" {
						status = "completed"
					}
					input = append(input, param.Override[responses.ResponseInputItemUnionParam](map[string]any{"type": "computer_call", "id": id, "call_id": tu.ToolUseID, "status": status, "actions": computerActionsForResponses(tu.Arguments), "pending_safety_checks": safetyChecksForResponses(tu.Arguments)}))
					continue
				}
				argsJSON, _ := json.Marshal(tu.Arguments)
				input = append(input, responses.ResponseInputItemUnionParam{
					OfFunctionCall: &responses.ResponseFunctionToolCallParam{
						Name:      tu.ToolName,
						CallID:    tu.ToolUseID,
						Arguments: string(argsJSON),
					},
				})
			}
		} else if len(m.ToolResults) > 0 {
			for _, tr := range m.ToolResults {
				if call, ok := computerCalls[tr.ToolUseID]; ok {
					url := computerScreenshotURL(tr)
					output := map[string]any{"type": "computer_screenshot"}
					if url != "" {
						output["image_url"] = url
					}
					input = append(input, param.Override[responses.ResponseInputItemUnionParam](map[string]any{"type": "computer_call_output", "call_id": tr.ToolUseID, "output": output, "acknowledged_safety_checks": safetyChecksForResponses(call.Arguments)}))
					if tr.IsError || url == "" {
						input = append(input, param.Override[responses.ResponseInputItemUnionParam](map[string]any{"role": "user", "content": tr.Content}))
					}
				} else {
					input = append(input, param.Override[responses.ResponseInputItemUnionParam](map[string]any{"type": "function_call_output", "call_id": tr.ToolUseID, "output": toolOutputForResponses(tr)}))
				}
			}
			if m.HasContent() {
				input = append(input, responses.ResponseInputItemUnionParam{
					OfMessage: &responses.EasyInputMessageParam{
						Role:    responses.EasyInputMessageRoleUser,
						Content: userContentsFor(m),
					},
				})
			}
		} else if m.Role == "assistant" {
			input = append(input, responses.ResponseInputItemUnionParam{
				OfMessage: &responses.EasyInputMessageParam{
					Role:    responses.EasyInputMessageRoleAssistant,
					Content: responses.EasyInputMessageContentUnionParam{OfString: param.NewOpt(m.ContentText())},
				},
			})
		} else if m.Role == "system" {
			input = append(input, responses.ResponseInputItemUnionParam{
				OfMessage: &responses.EasyInputMessageParam{
					Role:    responses.EasyInputMessageRoleSystem,
					Content: responses.EasyInputMessageContentUnionParam{OfString: param.NewOpt(m.ContentText())},
				},
			})
		} else {
			input = append(input, responses.ResponseInputItemUnionParam{
				OfMessage: &responses.EasyInputMessageParam{
					Role:    responses.EasyInputMessageRoleUser,
					Content: userContentsFor(m),
				},
			})
		}
	}
	return input
}

func toolOutputForResponses(tr conversation.ToolResultBlock) any {
	if len(tr.ContentBlocks) == 0 {
		return tr.Content
	}
	parts := []map[string]any{}
	if tr.Content != "" {
		parts = append(parts, map[string]any{"type": "input_text", "text": tr.Content})
	}
	for _, block := range tr.ContentBlocks {
		if url := imageDataURL(block); url != "" {
			parts = append(parts, map[string]any{"type": "input_image", "image_url": url, "detail": "auto"})
		} else if document := documentForResponses(block); document != nil {
			parts = append(parts, document)
		}
	}
	if len(parts) == 0 {
		return tr.Content
	}
	return parts
}

func classifyOpenAIError(err error) error {
	switch err.(type) {
	case *LLMError, *AuthenticationError, *RateLimitError, *NetworkError, *ServerError, *ContextTooLongError:
		return err
	}
	var apiErr *openai.Error
	if errors.As(err, &apiErr) {
		status := apiErr.StatusCode
		msg := apiErr.Error()
		if status == 413 || (status == 400 && ContainsContextLengthError(msg)) {
			return &ContextTooLongError{Message: fmt.Sprintf("Context Too Long: %s", msg)}
		}
		if status == 401 {
			return &AuthenticationError{Message: fmt.Sprintf("Invalid API key: %s", msg)}
		}
		if status == 429 {
			retryAfter := ""
			if apiErr.Response != nil {
				retryAfter = apiErr.Response.Header.Get("Retry-After")
			}
			return &RateLimitError{Message: "Rate limit error, please wait.", RetryAfter: retryAfter}
		}
		if status >= 500 || status == 408 {
			retryAfter := ""
			if apiErr.Response != nil {
				retryAfter = apiErr.Response.Header.Get("Retry-After")
			}
			return &ServerError{
				Message:    fmt.Sprintf("OpenAI API error (%d): %s", status, msg),
				RetryAfter: retryAfter,
			}
		}
		return &LLMError{Message: fmt.Sprintf("OpenAI API error (%d): %s", status, msg)}
	}
	return &NetworkError{Message: fmt.Sprintf("Network error: %s", err.Error())}
}
