package llm

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/anthropics/anthropic-sdk-go/packages/param"
)

const anthropicStreamIdleTimeout = 5 * time.Minute

const nativeToolSearchBeta = "advanced-tool-use-2025-11-20"

var officialAnthropicHosts = map[string]bool{"api.anthropic.com": true}

func isOfficialAnthropicEndpoint(baseURL string) bool {
	if baseURL == "" {
		return true
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	return officialAnthropicHosts[strings.ToLower(parsed.Hostname())]
}

func markToolsForCache(sdkTools []anthropic.ToolUnionParam) {
	for i := len(sdkTools) - 1; i >= 0; i-- {
		t := sdkTools[i].OfTool
		if t == nil || t.DeferLoading.Valid() {
			continue
		}
		t.CacheControl = anthropic.NewCacheControlEphemeralParam()
		return
	}
}

func needsToolSearchBeta(toolSchemas []map[string]any) bool {
	for _, s := range toolSchemas {
		if deferLoading, _ := s["defer_loading"].(bool); deferLoading {
			return true
		}
	}
	return false
}

type anthropicClient struct {
	client anthropic.Client
	model  string
	cfg    config.ProviderConfig
	// Effective logical thinking level (clamped to what the provider
	// supports); translated to a token budget or an adaptive effort per
	// request.
	thinkingLevel string
	systemPrompt  string
}

func newAnthropicClient(cfg *config.ProviderConfig, systemPrompt string) (*anthropicClient, error) {
	apiKey := config.ResolveAPIKey(cfg)
	if apiKey == "" {
		return nil, &AuthenticationError{
			Message: AnthropicAPIKeyMissingError,
		}
	}

	client := anthropic.NewClient(
		option.WithAPIKey(apiKey),
		option.WithBaseURL(cfg.BaseURL),
	)

	return &anthropicClient{
		client:        client,
		model:         cfg.Model,
		cfg:           *cfg,
		thinkingLevel: config.GetThinkingLevel(cfg),
		systemPrompt:  systemPrompt,
	}, nil
}

func (c *anthropicClient) SetSystemPrompt(prompt string) { c.systemPrompt = prompt }

func (c *anthropicClient) Protocol() string { return "anthropic" }

func (c *anthropicClient) SetMaxOutputTokens(tokens int) {
	c.cfg.MaxOutputTokens = float64(tokens)
	c.SetThinkingLevel(c.thinkingLevel)
}

func (c *anthropicClient) SetThinkingLevel(level string) string {
	c.thinkingLevel = config.ClampThinkingLevel(&c.cfg, level)
	return c.thinkingLevel
}

func (c *anthropicClient) GetThinkingLevel() string {
	return c.thinkingLevel
}

func (c *anthropicClient) GetSupportedThinkingLevels() []string {
	return config.GetSupportedThinkingLevels(&c.cfg)
}

func (c *anthropicClient) GetOutputBudget() OutputBudget {
	return OutputBudget{
		MaxOutputTokens: config.GetMaxOutputTokens(&c.cfg),
		ThinkingTokens:  config.ThinkingBudgetForProvider(&c.cfg, c.thinkingLevel),
	}
}

// toAnthropicToolSchema converts a provider tool schema (Anthropic shape with
// input_schema) into the SDK tool param, preserving extra JSON Schema fields
// and applying the explicit custom tool type only for official endpoints.
func toAnthropicToolSchema(s map[string]any, useExplicitCustomType bool) anthropic.ToolUnionParam {
	inputSchema, _ := s["input_schema"].(map[string]any)
	required, _ := inputSchema["required"].([]string)
	desc, _ := s["description"].(string)
	schemaParam := anthropic.ToolInputSchemaParam{
		Properties: inputSchema["properties"],
		Required:   required,
	}
	// The reference spreads the whole input_schema into the tool, so keep any
	// extra JSON Schema fields (e.g. additionalProperties). The typed fields
	// cover properties/required, and type defaults to "object".
	var extra map[string]any
	for key, value := range inputSchema {
		if key == "type" || key == "properties" || key == "required" {
			continue
		}
		if extra == nil {
			extra = map[string]any{}
		}
		extra[key] = value
	}
	schemaParam.ExtraFields = extra
	tool := &anthropic.ToolParam{
		Name:        s["name"].(string),
		Description: param.NewOpt(desc),
		InputSchema: schemaParam,
	}
	if deferLoading, _ := s["defer_loading"].(bool); deferLoading {
		tool.DeferLoading = param.NewOpt(true)
	}
	if useExplicitCustomType {
		tool.Type = anthropic.ToolTypeCustom
	}
	return anthropic.ToolUnionParam{OfTool: tool}
}

func (c *anthropicClient) Stream(ctx context.Context, conv *conversation.Manager, toolSchemas []map[string]any) (<-chan StreamEvent, <-chan error) {
	events := make(chan StreamEvent, 64)
	errs := make(chan error, 1)

	useExplicitCustomType := isOfficialAnthropicEndpoint(c.cfg.BaseURL)
	msgs, err := buildAnthropicMessages(conversation.EnsureToolPairing(conv.GetMessages()))
	if err != nil {
		errs <- err
		close(events)
		close(errs)
		return events, errs
	}

	sendToolSearchBeta := needsToolSearchBeta(toolSchemas)
	var sdkTools []anthropic.ToolUnionParam
	for _, s := range toolSchemas {
		sdkTools = append(sdkTools, toAnthropicToolSchema(s, useExplicitCustomType))
	}

	go func() {
		defer close(events)
		defer close(errs)

		requestConfig := c.cfg
		requestConfig.MaxOutputTokens = float64(maxOutputTokens(ctx, config.GetMaxOutputTokens(&c.cfg)))
		maxTokens := int64(config.GetMaxOutputTokens(&requestConfig))
		params := anthropic.MessageNewParams{
			Model:     c.model,
			MaxTokens: maxTokens,
			System: []anthropic.TextBlockParam{{
				Text:         c.systemPrompt,
				CacheControl: anthropic.NewCacheControlEphemeralParam(),
			}},
			Messages: msgs,
		}
		markLastUserTailForCache(params.Messages)
		level := config.ClampThinkingLevel(&requestConfig, c.GetThinkingLevel())
		if c.cfg.Reasoning == nil || *c.cfg.Reasoning {
			switch {
			case level == "off":
				params.Thinking = anthropic.ThinkingConfigParamUnion{
					OfDisabled: &anthropic.ThinkingConfigDisabledParam{},
				}
			case c.cfg.ThinkingMode == "adaptive":
				if effort := config.ToAnthropicThinkingEffort(level, &c.cfg); effort != "" {
					params.Thinking = anthropic.ThinkingConfigParamUnion{
						OfAdaptive: &anthropic.ThinkingConfigAdaptiveParam{},
					}
					params.OutputConfig = anthropic.OutputConfigParam{
						Effort: anthropic.OutputConfigEffort(effort),
					}
				}
			default:
				answerReserve := config.MinThinkingAnswerTokens
				if reserve := answerReserveTokens(ctx); reserve > answerReserve {
					answerReserve = reserve
				}
				thinkingTokens := config.ThinkingBudgetForProvider(&requestConfig, level)
				if reserve := int(maxTokens) - answerReserve; thinkingTokens > reserve {
					thinkingTokens = reserve
				}
				if thinkingTokens >= config.MinThinkingBudgetTokens {
					params.Thinking = anthropic.ThinkingConfigParamUnion{
						OfEnabled: &anthropic.ThinkingConfigEnabledParam{
							BudgetTokens: int64(thinkingTokens),
						},
					}
				} else {
					params.Thinking = anthropic.ThinkingConfigParamUnion{
						OfDisabled: &anthropic.ThinkingConfigDisabledParam{},
					}
				}
			}
		}
		if len(sdkTools) > 0 {
			markToolsForCache(sdkTools)
			params.Tools = sdkTools
		}

		var reqOpts []option.RequestOption
		if sendToolSearchBeta {
			reqOpts = append(reqOpts, option.WithHeaderAdd("anthropic-beta", nativeToolSearchBeta))
		}
		if retries, ok := maxRetries(ctx); ok {
			reqOpts = append(reqOpts, option.WithMaxRetries(retries))
		}

		stream := c.client.Messages.NewStreaming(ctx, params, reqOpts...)
		defer stream.Close()

		var currentToolName, currentToolID, jsonAccum string
		var thinkingAccum, thinkingSignature string
		var redactedData string
		inThinking := false
		inRedactedThinking := false
		var inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens int
		stopReason := "end_turn"
		// Terminal-event guard: a stream cut between message_start and
		// message_stop (gateway dropping the SSE) must not be committed as a
		// complete end_turn turn with near-zero usage.
		sawMessageStop := false

		type sseResult struct {
			hasNext bool
		}
		nextCh := make(chan sseResult, 1)

		readNext := func() {
			nextCh <- sseResult{hasNext: stream.Next()}
		}

		idle := time.NewTimer(anthropicStreamIdleTimeout)
		defer idle.Stop()

		go readNext()
		for {
			var res sseResult
			select {
			case <-ctx.Done():
				errs <- &NetworkError{Message: fmt.Sprintf("context cancelled: %v", ctx.Err())}
				return
			case <-idle.C:
				errs <- &NetworkError{Message: fmt.Sprintf("stream idle timeout: no SSE events for %s", anthropicStreamIdleTimeout)}
				return
			case res = <-nextCh:
			}

			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(anthropicStreamIdleTimeout)

			if !res.hasNext {
				break
			}

			event := stream.Current()
			switch ev := event.AsAny().(type) {
			case anthropic.MessageStartEvent:
				inputTokens = int(ev.Message.Usage.InputTokens)
				outputTokens = int(ev.Message.Usage.OutputTokens)
				cacheReadInputTokens = int(ev.Message.Usage.CacheReadInputTokens)
				cacheCreationInputTokens = int(ev.Message.Usage.CacheCreationInputTokens)
			case anthropic.MessageDeltaEvent:
				if ev.Delta.StopReason != "" {
					stopReason = string(ev.Delta.StopReason)
				}
				if ev.Usage.JSON.OutputTokens.Valid() {
					outputTokens = int(ev.Usage.OutputTokens)
				}
				if ev.Usage.JSON.InputTokens.Valid() {
					inputTokens = int(ev.Usage.InputTokens)
				}
				if ev.Usage.JSON.CacheReadInputTokens.Valid() {
					cacheReadInputTokens = int(ev.Usage.CacheReadInputTokens)
				}
				if ev.Usage.JSON.CacheCreationInputTokens.Valid() {
					cacheCreationInputTokens = int(ev.Usage.CacheCreationInputTokens)
				}
			case anthropic.MessageStopEvent:
				sawMessageStop = true
			case anthropic.ContentBlockStartEvent:
				switch ev.ContentBlock.Type {
				case "redacted_thinking":
					redactedData = ev.ContentBlock.Data
					inRedactedThinking = true
				case "thinking":
					inThinking = true
					thinkingAccum = ""
					thinkingSignature = ""
				case "tool_use":
					if ev.ContentBlock.ID == "" || ev.ContentBlock.Name == "" {
						errs <- &NetworkError{Message: "Anthropic tool call started without a valid id or name"}
						return
					}
					currentToolName = ev.ContentBlock.Name
					if currentToolName == "computer" {
						currentToolName = "ComputerUse"
					}
					currentToolID = ev.ContentBlock.ID
					jsonAccum = ""
					events <- ToolCallStart{ToolName: currentToolName, ToolID: currentToolID}
				}
			case anthropic.ContentBlockDeltaEvent:
				switch delta := ev.Delta.AsAny().(type) {
				case anthropic.ThinkingDelta:
					thinkingAccum += delta.Thinking
					events <- ThinkingDelta{Text: delta.Thinking}
				case anthropic.SignatureDelta:
					thinkingSignature += delta.Signature
				case anthropic.TextDelta:
					events <- TextDelta{Text: delta.Text}
				case anthropic.InputJSONDelta:
					if currentToolID == "" || currentToolName == "" {
						errs <- &NetworkError{Message: "Anthropic tool arguments arrived before a valid tool call"}
						return
					}
					jsonAccum += delta.PartialJSON
					events <- ToolCallDelta{Text: delta.PartialJSON}
				}
			case anthropic.ContentBlockStopEvent:
				if inThinking {
					events <- ThinkingComplete{
						Thinking:  thinkingAccum,
						Signature: thinkingSignature,
					}
					inThinking = false
				}
				if inRedactedThinking {
					events <- RedactedThinkingComplete{Data: redactedData}
					inRedactedThinking = false
				}
				if currentToolName != "" {
					args, parseError := ParseToolArguments(jsonAccum)
					events <- ToolCallComplete{
						ToolID:     currentToolID,
						ToolName:   currentToolName,
						Arguments:  args,
						ParseError: parseError,
					}
					currentToolName = ""
					currentToolID = ""
					jsonAccum = ""
				}
			}

			go readNext()
		}

		if err := stream.Err(); err != nil {
			errs <- classifyAnthropicError(err)
			return
		}

		// Without message_stop the response is truncated, not complete: throw a
		// NetworkError instead of yielding stream_end so the run surfaces an
		// error rather than persisting a half response as a finished turn.
		if !sawMessageStop {
			errs <- &NetworkError{Message: "Anthropic stream ended without message_stop; response was truncated"}
			return
		}

		events <- StreamEnd{StopReason: stopReason, Usage: UsageInfo{
			InputTokens:         inputTokens,
			OutputTokens:        outputTokens,
			CacheReadTokens:     cacheReadInputTokens,
			CacheCreationTokens: cacheCreationInputTokens,
		}}
	}()

	return events, errs
}

func markLastUserTailForCache(messages []anthropic.MessageParam) {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role != anthropic.MessageParamRoleUser {
			continue
		}
		blocks := messages[i].Content
		if len(blocks) == 0 {
			return
		}
		// Prefer the last non-image block: some gateways reject cache_control
		// on image blocks. Fall back to the true tail if everything is an
		// image.
		idx := len(blocks) - 1
		for j := len(blocks) - 1; j >= 0; j-- {
			if blocks[j].OfImage == nil {
				idx = j
				break
			}
		}
		last := &blocks[idx]
		switch {
		case last.OfText != nil:
			last.OfText.CacheControl = anthropic.NewCacheControlEphemeralParam()
		case last.OfToolResult != nil:
			last.OfToolResult.CacheControl = anthropic.NewCacheControlEphemeralParam()
		case last.OfDocument != nil:
			last.OfDocument.CacheControl = anthropic.NewCacheControlEphemeralParam()
		case last.OfImage != nil:
			last.OfImage.CacheControl = anthropic.NewCacheControlEphemeralParam()
		}
		return
	}
}

// userBlocksFor mirrors the reference userBlocksFor: string content becomes a
// single text block; block arrays are normalized to the provider shape
// (text/image/document/search_result). tool_reference and unsupported blocks
// are skipped (the reference throws; the Go builder degrades instead of
// failing the whole request on a malformed stored session).
func userBlocksFor(m conversation.Message) ([]anthropic.ContentBlockParamUnion, error) {
	if len(m.ContentBlocks) == 0 {
		return []anthropic.ContentBlockParamUnion{anthropic.NewTextBlock(m.Content)}, nil
	}
	var blocks []anthropic.ContentBlockParamUnion
	for _, raw := range m.ContentBlocks {
		block := conversation.NormalizeToolResultContentBlock(raw)
		if block == nil || block["type"] == "tool_reference" {
			return nil, fmt.Errorf("Unsupported user content block: %s", blockTypeOrUnknown(raw))
		}
		converted, ok := anthropicContentBlock(block)
		if !ok {
			return nil, fmt.Errorf("Unsupported user content block: %s", blockTypeOrUnknown(raw))
		}
		blocks = append(blocks, converted)
	}
	return blocks, nil
}

func blockTypeOrUnknown(raw map[string]any) string {
	if value, ok := raw["type"].(string); ok && value != "" {
		return value
	}
	return "unknown"
}

func anthropicContentBlock(block map[string]any) (anthropic.ContentBlockParamUnion, bool) {
	switch block["type"] {
	case "text":
		text, _ := block["text"].(string)
		return anthropic.NewTextBlock(text), true
	case "image":
		source, _ := block["source"].(map[string]any)
		if source == nil {
			return anthropic.ContentBlockParamUnion{}, false
		}
		if source["type"] == "url" {
			url, _ := source["url"].(string)
			if url == "" {
				return anthropic.ContentBlockParamUnion{}, false
			}
			return anthropic.ContentBlockParamUnion{
				OfImage: &anthropic.ImageBlockParam{
					Source: anthropic.ImageBlockParamSourceUnion{
						OfURL: &anthropic.URLImageSourceParam{URL: url},
					},
				},
			}, true
		}
		mediaType, _ := source["media_type"].(string)
		data, _ := source["data"].(string)
		if mediaType == "" || data == "" {
			return anthropic.ContentBlockParamUnion{}, false
		}
		return anthropic.NewImageBlockBase64(mediaType, data), true
	case "document":
		source, _ := block["source"].(map[string]any)
		if source == nil {
			return anthropic.ContentBlockParamUnion{}, false
		}
		var union anthropic.ContentBlockParamUnion
		switch source["type"] {
		case "url":
			url, _ := source["url"].(string)
			if url == "" {
				return union, false
			}
			union = anthropic.NewDocumentBlock(anthropic.URLPDFSourceParam{URL: url})
		case "base64":
			data, _ := source["data"].(string)
			if data == "" {
				return union, false
			}
			union = anthropic.NewDocumentBlock(anthropic.Base64PDFSourceParam{Data: data})
		case "text":
			data, _ := source["data"].(string)
			union = anthropic.NewDocumentBlock(anthropic.PlainTextSourceParam{Data: data})
		case "content":
			contentSource := anthropic.ContentBlockSourceParam{}
			switch content := source["content"].(type) {
			case string:
				contentSource.Content.OfString = param.NewOpt(content)
			case []map[string]any:
				var items []anthropic.ContentBlockSourceContentItemUnionParam
				for _, item := range content {
					switch item["type"] {
					case "text":
						text, _ := item["text"].(string)
						items = append(items, anthropic.ContentBlockSourceContentItemUnionParam{
							OfText: &anthropic.TextBlockParam{Text: text},
						})
					case "image":
						itemSource, _ := item["source"].(map[string]any)
						if itemSource == nil {
							continue
						}
						mediaType, _ := itemSource["media_type"].(string)
						data, _ := itemSource["data"].(string)
						if mediaType == "" || data == "" {
							continue
						}
						items = append(items, anthropic.ContentBlockSourceContentItemUnionParam{
							OfImage: &anthropic.ImageBlockParam{
								Source: anthropic.ImageBlockParamSourceUnion{
									OfBase64: &anthropic.Base64ImageSourceParam{
										MediaType: anthropic.Base64ImageSourceMediaType(mediaType),
										Data:      data,
									},
								},
							},
						})
					}
				}
				contentSource.Content.OfContentBlockSourceContent = items
			default:
				return union, false
			}
			union = anthropic.NewDocumentBlock(contentSource)
		default:
			return union, false
		}
		if union.OfDocument != nil {
			if title, ok := block["title"].(string); ok {
				union.OfDocument.Title = param.NewOpt(title)
			}
			if context, ok := block["context"].(string); ok {
				union.OfDocument.Context = param.NewOpt(context)
			}
		}
		return union, true
	case "search_result":
		source, _ := block["source"].(string)
		title, _ := block["title"].(string)
		var textBlocks []anthropic.TextBlockParam
		if content, ok := block["content"].([]map[string]any); ok {
			for _, item := range content {
				text, _ := item["text"].(string)
				textBlocks = append(textBlocks, anthropic.TextBlockParam{Text: text})
			}
		}
		return anthropic.NewSearchResultBlock(textBlocks, source, title), true
	}
	return anthropic.ContentBlockParamUnion{}, false
}

func buildAnthropicMessages(messages []conversation.Message) ([]anthropic.MessageParam, error) {
	var result []anthropic.MessageParam
	for _, m := range messages {
		if m.Role == "assistant" {
			var blocks []anthropic.ContentBlockParamUnion
			for _, tb := range m.ThinkingBlocks {
				if tb.Type == "redacted_thinking" {
					blocks = append(blocks, anthropic.NewRedactedThinkingBlock(tb.Data))
					continue
				}
				blocks = append(blocks, anthropic.NewThinkingBlock(tb.Signature, tb.Thinking))
			}
			if m.Content != "" {
				blocks = append(blocks, anthropic.NewTextBlock(m.Content))
			}
			for _, tu := range m.ToolUses {
				name := tu.ToolName
				if name == "ComputerUse" {
					name = "computer"
				}
				blocks = append(blocks, anthropic.ContentBlockParamUnion{
					OfToolUse: &anthropic.ToolUseBlockParam{
						ID:    tu.ToolUseID,
						Name:  name,
						Input: tu.Arguments,
					},
				})
			}
			if len(blocks) == 0 {
				blocks = append(blocks, anthropic.NewTextBlock(""))
			}
			result = append(result, anthropic.MessageParam{
				Role:    anthropic.MessageParamRoleAssistant,
				Content: blocks,
			})
		} else if len(m.ToolResults) > 0 {
			var blocks []anthropic.ContentBlockParamUnion
			for _, tr := range m.ToolResults {
				content := []anthropic.ToolResultBlockParamContentUnion{{
					OfText: &anthropic.TextBlockParam{Text: tr.Content},
				}}
				if structured := toolResultContentBlocks(tr.ContentBlocks); len(structured) > 0 {
					content = structured
				}
				blocks = append(blocks, anthropic.ContentBlockParamUnion{
					OfToolResult: &anthropic.ToolResultBlockParam{
						ToolUseID: tr.ToolUseID,
						IsError:   param.NewOpt(tr.IsError),
						Content:   content,
					},
				})
			}
			if m.HasContent() {
				userBlocks, err := userBlocksFor(m)
				if err != nil {
					return nil, err
				}
				blocks = append(blocks, userBlocks...)
			}
			result = append(result, anthropic.MessageParam{
				Role:    anthropic.MessageParamRoleUser,
				Content: blocks,
			})
		} else {
			// Anthropic messages must alternate roles. Merge every consecutive
			// user turn, including reminders or steering immediately after
			// tool results.
			userBlocks, err := userBlocksFor(m)
			if err != nil {
				return nil, err
			}
			if n := len(result); n > 0 && result[n-1].Role == anthropic.MessageParamRoleUser {
				result[n-1].Content = append(result[n-1].Content, userBlocks...)
				continue
			}
			result = append(result, anthropic.MessageParam{
				Role:    anthropic.MessageParamRoleUser,
				Content: userBlocks,
			})
		}
	}
	return result, nil
}

func classifyAnthropicError(err error) error {
	switch err.(type) {
	case *LLMError, *AuthenticationError, *RateLimitError, *NetworkError, *ServerError, *ContextTooLongError:
		return err
	}
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		status := apiErr.StatusCode
		msg := apiErr.Error()
		// 413 Request Too Large — the request body itself exceeds size limits.
		// Prompt-too-long (token count over the context window) arrives as 400
		// invalid_request_error, not 413.
		if status == 413 || (status == 400 && ContainsContextLengthError(msg)) {
			return &ContextTooLongError{Message: fmt.Sprintf("Prompt too long: %s", msg)}
		}
		if status == 401 {
			return &AuthenticationError{Message: fmt.Sprintf("Invalid API key: %s", msg)}
		}
		if status == 429 {
			retryAfter := ""
			if apiErr.Response != nil {
				retryAfter = apiErr.Response.Header.Get("Retry-After")
			}
			message := "Rate Limited"
			if retryAfter != "" {
				if _, err := strconv.Atoi(strings.TrimSpace(retryAfter)); err != nil {
					message += ", please wait."
				} else {
					message += fmt.Sprintf(", retry after %ss.", strings.TrimSpace(retryAfter))
				}
			} else {
				message += ", please wait."
			}
			return &RateLimitError{Message: message, RetryAfter: retryAfter}
		}
		if status >= 500 || status == 408 {
			retryAfter := ""
			if apiErr.Response != nil {
				retryAfter = apiErr.Response.Header.Get("Retry-After")
			}
			return &ServerError{
				Message:    fmt.Sprintf("Anthropic API error (%d): %s", status, msg),
				RetryAfter: retryAfter,
			}
		}
		return &LLMError{Message: fmt.Sprintf("Anthropic API error (%d): %s", status, msg)}
	}
	return &NetworkError{Message: fmt.Sprintf("Network error: %s", err.Error())}
}

func toolResultContentBlocks(raw []map[string]any) []anthropic.ToolResultBlockParamContentUnion {
	if len(raw) == 0 {
		return nil
	}
	out := make([]anthropic.ToolResultBlockParamContentUnion, 0, len(raw))
	for _, b := range raw {
		blockType, _ := b["type"].(string)
		if blockType != "tool_reference" {
			return nil
		}
		name, _ := b["tool_name"].(string)
		if name == "" {
			return nil
		}
		out = append(out, anthropic.ToolResultBlockParamContentUnion{
			OfToolReference: &anthropic.ToolReferenceBlockParam{ToolName: name},
		})
	}
	return out
}
