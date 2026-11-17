package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/packages/param"
	"github.com/openai/openai-go/shared"
)

const openaiCompatStreamIdleTimeout = 5 * time.Minute

type openaiCompatClient struct {
	client          openai.Client
	model           string
	cfg             config.ProviderConfig
	thinkingLevel   string
	systemPrompt    string
	maxOutputTokens int
}

func newOpenAICompatClient(cfg *config.ProviderConfig, systemPrompt string) (*openaiCompatClient, error) {
	apiKey := config.ResolveAPIKey(cfg)
	if apiKey == "" {
		return nil, &AuthenticationError{Message: OpenAIAPIKeyMissingError}
	}

	opts := []option.RequestOption{
		option.WithAPIKey(apiKey),
		option.WithBaseURL(cfg.BaseURL),
	}
	if os.Getenv("YUKINO_LLM_DEBUG") != "" {
		opts = append(opts, option.WithDebugLog(log.New(os.Stderr, "[llm] ", log.LstdFlags)))
	}
	client := openai.NewClient(opts...)

	return &openaiCompatClient{
		client:          client,
		model:           cfg.Model,
		cfg:             *cfg,
		thinkingLevel:   config.GetThinkingLevel(cfg),
		systemPrompt:    systemPrompt,
		maxOutputTokens: config.GetMaxOutputTokens(cfg),
	}, nil
}

func (c *openaiCompatClient) SetSystemPrompt(prompt string) {
	c.systemPrompt = prompt
}

func (c *openaiCompatClient) Protocol() string { return "openai-compat" }

func (c *openaiCompatClient) SetMaxOutputTokens(tokens int) {
	c.maxOutputTokens = tokens
}

func (c *openaiCompatClient) SetThinkingLevel(level string) string {
	c.thinkingLevel = config.ClampThinkingLevel(&c.cfg, level)
	return c.thinkingLevel
}

func (c *openaiCompatClient) GetThinkingLevel() string {
	return c.thinkingLevel
}

func (c *openaiCompatClient) GetSupportedThinkingLevels() []string {
	return config.GetSupportedThinkingLevels(&c.cfg)
}

func (c *openaiCompatClient) GetOutputBudget() OutputBudget {
	return OutputBudget{
		MaxOutputTokens: c.maxOutputTokens,
		ThinkingTokens:  config.ThinkingBudgetForProvider(&c.cfg, c.thinkingLevel),
	}
}

type compatToolCall struct {
	id      string
	name    string
	args    string
	started bool
}

func (c *openaiCompatClient) Stream(ctx context.Context, conv *conversation.Manager, toolSchemas []map[string]any) (<-chan StreamEvent, <-chan error) {
	events := make(chan StreamEvent, 64)
	errs := make(chan error, 1)

	messages := buildChatCompletionMessages(c.systemPrompt, conversation.EnsureToolPairing(conv.GetMessages()))

	var tools []openai.ChatCompletionToolParam
	for _, schema := range toolSchemas {
		s, _ := schema["function"].(map[string]any)
		name, _ := s["name"].(string)
		desc, _ := s["description"].(string)
		params, _ := s["parameters"].(map[string]any)
		strict, _ := s["strict"].(bool)
		tools = append(tools, openai.ChatCompletionToolParam{
			Function: shared.FunctionDefinitionParam{
				Name:        name,
				Description: param.NewOpt(desc),
				Parameters:  shared.FunctionParameters(params),
				Strict:      param.NewOpt(strict),
			},
		})
	}

	go func() {
		defer close(events)
		defer close(errs)

		requestConfig := c.cfg
		requestConfig.MaxOutputTokens = float64(maxOutputTokens(ctx, c.maxOutputTokens))
		reqParams := openai.ChatCompletionNewParams{
			Model:               c.model,
			Messages:            messages,
			MaxCompletionTokens: param.NewOpt(int64(config.GetMaxOutputTokens(&requestConfig))),
			StreamOptions: openai.ChatCompletionStreamOptionsParam{
				IncludeUsage: param.NewOpt(true),
			},
		}
		if len(tools) > 0 {
			reqParams.Tools = tools
		}
		// Configured non-reasoning providers omit the field; off otherwise
		// sends none explicitly so a server default cannot silently enable
		// reasoning.
		if effort := config.ToReasoningEffort(c.GetThinkingLevel(), &c.cfg); effort != "" {
			reqParams.ReasoningEffort = shared.ReasoningEffort(effort)
		}

		var requestOpts []option.RequestOption
		if retries, ok := maxRetries(ctx); ok {
			requestOpts = append(requestOpts, option.WithMaxRetries(retries))
		}
		stream := c.client.Chat.Completions.NewStreaming(ctx, reqParams, requestOpts...)
		defer stream.Close()

		toolCalls := map[int64]*compatToolCall{}
		var toolCallOrder []int64
		var reasoningAccum string
		finishReason := ""
		sawFinish := false
		var inputTokens, outputTokens, cacheReadTokens int

		type sseResult struct {
			hasNext bool
		}
		nextCh := make(chan sseResult, 1)

		readNext := func() {
			nextCh <- sseResult{hasNext: stream.Next()}
		}

		idle := time.NewTimer(openaiCompatStreamIdleTimeout)
		defer idle.Stop()

		finish := func(err error) {
			errs <- err
		}

		go readNext()
		for {
			var res sseResult
			select {
			case <-ctx.Done():
				finish(&NetworkError{Message: fmt.Sprintf("context cancelled: %v", ctx.Err())})
				return
			case <-idle.C:
				finish(&NetworkError{Message: fmt.Sprintf("stream idle timeout: no SSE events for %s", openaiCompatStreamIdleTimeout)})
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
				inputTokens = int(chunk.Usage.PromptTokens) - cacheReadTokens
				if inputTokens < 0 {
					inputTokens = 0
				}
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
				entry, exists := toolCalls[tc.Index]
				if !exists {
					entry = &compatToolCall{}
					toolCalls[tc.Index] = entry
					toolCallOrder = append(toolCallOrder, tc.Index)
				}
				if tc.ID != "" {
					entry.id = tc.ID
				}
				if tc.Function.Name != "" {
					entry.name = tc.Function.Name
				}
				// Emit start as soon as both id and name are known: compat
				// gateways sometimes deliver the id only in a later delta, and
				// consumers must never see deltas/complete for a call that
				// never "started".
				if !entry.started && entry.id != "" && entry.name != "" {
					entry.started = true
					events <- ToolCallStart{ToolName: entry.name, ToolID: entry.id}
				}
				if tc.Function.Arguments != "" {
					entry.args += tc.Function.Arguments
					if entry.started {
						events <- ToolCallDelta{Text: tc.Function.Arguments}
					}
				}
			}

			if choice.FinishReason != "" {
				finishReason = choice.FinishReason
				sawFinish = true
				if reasoningAccum != "" {
					events <- ThinkingComplete{Thinking: reasoningAccum}
					reasoningAccum = ""
				}
				for _, index := range toolCallOrder {
					call := toolCalls[index]
					if call.started {
						continue
					}
					missing := ""
					if call.id == "" {
						missing = "id"
					}
					if call.name == "" {
						if missing != "" {
							missing += " and "
						}
						missing += "name"
					}
					finish(&NetworkError{Message: fmt.Sprintf("Chat Completions tool call ended without a valid %s", missing)})
					return
				}
				for _, index := range toolCallOrder {
					call := toolCalls[index]
					args, parseError := ParseToolArguments(call.args)
					events <- ToolCallComplete{
						ToolID:     call.id,
						ToolName:   call.name,
						Arguments:  args,
						ParseError: parseError,
					}
				}
			}

			go readNext()
		}

		if err := stream.Err(); err != nil {
			finish(classifyOpenAIError(err))
			return
		}

		if !sawFinish {
			finish(&NetworkError{Message: "Chat Completions stream ended before a finish reason"})
			return
		}

		// Map the raw finish_reason explicitly. content_filter is a blocked
		// response, not a normal completion, and must fail even when tool
		// deltas arrived — never run pending tools from an invalid stop state.
		// Unknown reasons are surfaced rather than silently treated as
		// end_turn.
		var stopReason string
		switch {
		case finishReason == "content_filter":
			finish(&LLMError{Message: "Chat Completions response was blocked by the content filter"})
			return
		case finishReason == "length":
			stopReason = "max_tokens"
		case finishReason == "tool_calls" || finishReason == "function_call" || (finishReason == "stop" && len(toolCalls) > 0):
			stopReason = "tool_use"
		case finishReason == "stop":
			stopReason = "end_turn"
		default:
			finish(&LLMError{Message: fmt.Sprintf("Chat Completions returned an unsupported finish reason: %s", finishReason)})
			return
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

// userPartsFor mirrors the reference: string content stays a string; block
// arrays become Chat Completions parts (text / image_url data URL; other
// block types are dropped).
func userPartsFor(m conversation.Message) openai.ChatCompletionUserMessageParamContentUnion {
	if len(m.ContentBlocks) == 0 {
		return openai.ChatCompletionUserMessageParamContentUnion{OfString: param.NewOpt(m.Content)}
	}
	var parts []openai.ChatCompletionContentPartUnionParam
	for _, raw := range m.ContentBlocks {
		block := conversation.NormalizeToolResultContentBlock(raw)
		if block == nil {
			continue
		}
		if block["type"] == "text" {
			text, _ := block["text"].(string)
			parts = append(parts, openai.ChatCompletionContentPartUnionParam{
				OfText: &openai.ChatCompletionContentPartTextParam{Text: text},
			})
			continue
		}
		if url := imageDataURL(block); url != "" {
			parts = append(parts, openai.ChatCompletionContentPartUnionParam{
				OfImageURL: &openai.ChatCompletionContentPartImageParam{
					ImageURL: openai.ChatCompletionContentPartImageImageURLParam{URL: url},
				},
			})
		}
	}
	return openai.ChatCompletionUserMessageParamContentUnion{OfArrayOfContentParts: parts}
}

func userMessageParam(m conversation.Message) openai.ChatCompletionMessageParamUnion {
	return openai.ChatCompletionMessageParamUnion{
		OfUser: &openai.ChatCompletionUserMessageParam{Content: userPartsFor(m)},
	}
}

func buildChatCompletionMessages(systemPrompt string, messages []conversation.Message) []openai.ChatCompletionMessageParamUnion {
	result := []openai.ChatCompletionMessageParamUnion{openai.SystemMessage(systemPrompt)}

	for _, m := range messages {
		reasoning := ""
		for _, tb := range m.ThinkingBlocks {
			if tb.Type == "thinking" {
				reasoning += tb.Thinking
			}
		}
		assistantText := m.ContentText()

		if len(m.ToolUses) > 0 {
			assistant := openai.ChatCompletionAssistantMessageParam{}
			if assistantText != "" {
				assistant.Content.OfString = param.NewOpt(assistantText)
			}
			for _, tu := range m.ToolUses {
				argsJSON, _ := json.Marshal(tu.Arguments)
				assistant.ToolCalls = append(assistant.ToolCalls, openai.ChatCompletionMessageToolCallParam{
					ID: tu.ToolUseID,
					Function: openai.ChatCompletionMessageToolCallFunctionParam{
						Name:      tu.ToolName,
						Arguments: string(argsJSON),
					},
				})
			}
			if reasoning != "" {
				assistant.SetExtraFields(map[string]any{"reasoning_content": reasoning})
			}
			result = append(result, openai.ChatCompletionMessageParamUnion{OfAssistant: &assistant})
		} else if len(m.ToolResults) > 0 {
			var pendingRichParts []openai.ChatCompletionContentPartUnionParam
			for _, tr := range m.ToolResults {
				result = append(result, openai.ToolMessage(tr.Content, tr.ToolUseID))
				pendingRichParts = append(pendingRichParts, collectRichParts(tr)...)
			}
			if m.HasContent() {
				content := userPartsFor(m)
				if content.OfString.Valid() {
					pendingRichParts = append(pendingRichParts, openai.ChatCompletionContentPartUnionParam{
						OfText: &openai.ChatCompletionContentPartTextParam{Text: content.OfString.Value},
					})
				} else {
					pendingRichParts = append(pendingRichParts, content.OfArrayOfContentParts...)
				}
			}
			if len(pendingRichParts) > 0 {
				result = append(result, openai.ChatCompletionMessageParamUnion{
					OfUser: &openai.ChatCompletionUserMessageParam{
						Content: openai.ChatCompletionUserMessageParamContentUnion{OfArrayOfContentParts: pendingRichParts},
					},
				})
			}
		} else if m.Role == "assistant" {
			assistant := openai.ChatCompletionAssistantMessageParam{}
			assistant.Content.OfString = param.NewOpt(assistantText)
			if reasoning != "" {
				assistant.SetExtraFields(map[string]any{"reasoning_content": reasoning})
			}
			result = append(result, openai.ChatCompletionMessageParamUnion{OfAssistant: &assistant})
		} else if m.Role == "system" {
			result = append(result, openai.SystemMessage(m.ContentText()))
		} else {
			result = append(result, userMessageParam(m))
		}
	}

	return result
}

// collectRichParts preserves tool-result images and documents as Chat
// Completions parts, prefixed with a marker naming the tool call.
func collectRichParts(tr conversation.ToolResultBlock) []openai.ChatCompletionContentPartUnionParam {
	if len(tr.ContentBlocks) == 0 {
		return nil
	}
	var rich []openai.ChatCompletionContentPartUnionParam
	for _, raw := range tr.ContentBlocks {
		block := conversation.NormalizeToolResultContentBlock(raw)
		if block == nil {
			continue
		}
		if url := imageDataURL(block); url != "" {
			rich = append(rich, openai.ChatCompletionContentPartUnionParam{
				OfImageURL: &openai.ChatCompletionContentPartImageParam{
					ImageURL: openai.ChatCompletionContentPartImageImageURLParam{URL: url},
				},
			})
			continue
		}
		rich = append(rich, documentForChat(block)...)
	}
	if len(rich) == 0 {
		return nil
	}
	return append([]openai.ChatCompletionContentPartUnionParam{{
		OfText: &openai.ChatCompletionContentPartTextParam{Text: "[Rich content returned by tool call " + tr.ToolUseID + "]"},
	}}, rich...)
}

// documentForChat carries a document as an inline base64 file; every accepted
// source produces explicit parts, and an unrepresentable URL source becomes a
// diagnostic text part rather than being silently dropped.
func documentForChat(block map[string]any) []openai.ChatCompletionContentPartUnionParam {
	if block["type"] != "document" {
		return nil
	}
	source, _ := block["source"].(map[string]any)
	if source == nil {
		return nil
	}
	title, _ := block["title"].(string)
	if title == "" {
		title = "tool-result"
	}
	filePart := func(data, filename string) []openai.ChatCompletionContentPartUnionParam {
		if data == "" {
			return nil
		}
		return []openai.ChatCompletionContentPartUnionParam{openai.FileContentPart(openai.ChatCompletionContentPartFileFileParam{
			FileData: param.NewOpt(data),
			Filename: param.NewOpt(filename),
		})}
	}
	switch source["type"] {
	case "base64":
		data, _ := source["data"].(string)
		return filePart(data, title+".pdf")
	case "text":
		data, _ := source["data"].(string)
		if data == "" {
			return nil
		}
		return filePart(base64.StdEncoding.EncodeToString([]byte(data)), title+".txt")
	case "url":
		url, _ := source["url"].(string)
		if url == "" {
			url = "unknown"
		}
		return []openai.ChatCompletionContentPartUnionParam{{
			OfText: &openai.ChatCompletionContentPartTextParam{Text: "[Document source \"url\" (" + url + ") is not supported by Chat Completions and was not fetched.]"},
		}}
	case "content":
		content, _ := source["content"].([]map[string]any)
		var parts []openai.ChatCompletionContentPartUnionParam
		for _, sub := range content {
			if url := imageDataURL(sub); url != "" {
				parts = append(parts, openai.ChatCompletionContentPartUnionParam{
					OfImageURL: &openai.ChatCompletionContentPartImageParam{
						ImageURL: openai.ChatCompletionContentPartImageImageURLParam{URL: url},
					},
				})
				continue
			}
			if sub["type"] == "text" {
				text, _ := sub["text"].(string)
				parts = append(parts, openai.ChatCompletionContentPartUnionParam{
					OfText: &openai.ChatCompletionContentPartTextParam{Text: text},
				})
			}
		}
		return parts
	}
	return nil
}
