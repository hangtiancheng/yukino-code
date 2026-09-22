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
	"slices"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/mcp"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/anthropics/anthropic-sdk-go/packages/param"
	"github.com/anthropics/anthropic-sdk-go/shared/constant"
)

const anthropicStreamIdleTimeout = 5 * time.Minute

// markToolsForCache places the cache breakpoint on the last non-deferred tool.
//
// Tool schemas are stable across turns, so marking the tail caches the entire tool block at
// essentially no cost. However, the breakpoint must not land on a tool with defer_loading: a tool
// carrying both defer_loading and cache_control causes the official endpoint to reject the entire
// request. MCP tools are registered after built-in tools, so after sorting the tail is often a
// deferred tool — hence the backward scan. Built-in tools are never deferred, so a valid landing
// spot always exists.
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

// needsToolSearchBeta checks whether any tool in this batch carries defer_loading.
//
// The beta header is only sent when actually needed: endpoints that do not
// recognize it will reject the request outright, and the dispatch / eager
// paths do not need it at all.
func needsToolSearchBeta(toolSchemas []map[string]any) bool {
	for _, s := range toolSchemas {
		if deferLoading, _ := s["defer_loading"].(bool); deferLoading {
			return true
		}
	}
	return false
}

// toAnthropicInputSchema passes the entire input_schema through to the SDK
// (TS: toAnthropicToolSchema spreads the whole schema). MCP tool schemas are
// JSON-decoded, so "required" arrives as []any and must be converted, and any
// top-level extension keys ($schema, additionalProperties, definitions, ...)
// are preserved via ExtraFields instead of being dropped.
func toAnthropicInputSchema(inputSchema map[string]any) anthropic.ToolInputSchemaParam {
	out := anthropic.ToolInputSchemaParam{}
	var extras map[string]any
	for key, value := range inputSchema {
		switch key {
		case "properties":
			out.Properties = value
		case "required":
			out.Required = toStringSlice(value)
		case "type":
			if t, ok := value.(string); ok {
				out.Type = constant.Object(t)
			}
		default:
			if extras == nil {
				extras = make(map[string]any)
			}
			extras[key] = value
		}
	}
	out.ExtraFields = extras
	return out
}

// toStringSlice normalizes a JSON-decoded string array ([]any) or a native
// []string into []string; non-string elements are dropped.
func toStringSlice(v any) []string {
	switch list := v.(type) {
	case []string:
		return list
	case []any:
		out := make([]string, 0, len(list))
		for _, item := range list {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

type anthropicClient struct {
	client          anthropic.Client
	cfg             *config.ProviderConfig
	model           string
	thinkingLevel   config.ThinkingLevel
	systemPrompt    string
	maxOutputTokens int
	// useExplicitCustomToolType mirrors the TS client: tools sent to the
	// official endpoint carry the explicit type:"custom"; other endpoints get
	// no type field because gateways reject values they do not recognize.
	useExplicitCustomToolType bool
}

func newAnthropicClient(cfg *config.ProviderConfig, systemPrompt string) (*anthropicClient, error) {
	apiKey := cfg.ResolveAPIKey()
	if apiKey == "" {
		return nil, &AuthenticationError{
			Message: "Anthropic API key not found, set ANTHROPIC_API_KEY in ~/.yukino/config.yaml, or via ANTHROPIC_API_KEY env variable.",
		}
	}

	client := anthropic.NewClient(
		option.WithAPIKey(apiKey),
		option.WithBaseURL(cfg.BaseURL),
	)

	return &anthropicClient{
		client:                    client,
		cfg:                       cfg,
		model:                     cfg.Model,
		thinkingLevel:             config.GetThinkingLevel(cfg),
		systemPrompt:              systemPrompt,
		maxOutputTokens:           cfg.GetMaxOutputTokens(),
		useExplicitCustomToolType: mcp.IsOfficialAnthropicEndpoint(cfg.BaseURL),
	}, nil
}

func (c *anthropicClient) SetSystemPrompt(prompt string) {
	c.systemPrompt = prompt
}

func (c *anthropicClient) Protocol() string { return c.cfg.Protocol }

func (c *anthropicClient) GetThinkingLevel() config.ThinkingLevel { return c.thinkingLevel }

func (c *anthropicClient) SetThinkingLevel(level config.ThinkingLevel) config.ThinkingLevel {
	c.thinkingLevel = config.ClampThinkingLevel(c.cfg, level)
	return c.thinkingLevel
}

func (c *anthropicClient) GetSupportedThinkingLevels() []config.ThinkingLevel {
	return config.GetSupportedThinkingLevels(c.cfg)
}

// SetMaxOutputTokens mirrors TS setMaxOutputTokens: adopt the requested cap
// into a private config copy, re-resolve it through GetMaxOutputTokens (which
// clamps to the context window), then re-clamp the thinking level against the
// new cap so a shrunken output budget cannot keep an oversized thinking level.
func (c *anthropicClient) SetMaxOutputTokens(tokens int) {
	cfgCopy := *c.cfg
	cfgCopy.MaxOutputTokens = float64(tokens)
	c.cfg = &cfgCopy
	c.maxOutputTokens = c.cfg.GetMaxOutputTokens()
	c.thinkingLevel = config.ClampThinkingLevel(c.cfg, c.thinkingLevel)
}

func (c *anthropicClient) Stream(ctx context.Context, conv *conversation.Manager, toolSchemas []map[string]any) (<-chan StreamEvent, <-chan error) {
	events := make(chan StreamEvent, 64)
	errs := make(chan error, 1)

	// Tools with defer_loading stay in tools[] but the server hides them from
	// the model; the model must first use ToolSearch to obtain a tool_reference
	// before calling them. This field requires the beta header to be accepted.
	sendToolSearchBeta := needsToolSearchBeta(toolSchemas)

	go func() {
		defer close(events)
		defer close(errs)

		// Ensure tool_use/tool_result pairing before sending the request:
		// interruptions, session resumptions, and concurrent interleaving can
		// leave dangling tool_use blocks, which the API rejects outright if
		// unpaired. TS builds the request inside the generator body, so a
		// conversion failure surfaces to the consumer as a plain error rather
		// than a classified LLM error.
		msgs, err := buildAnthropicMessages(conversation.EnsureToolPairing(conv.GetMessages()))
		if err != nil {
			errs <- err
			return
		}
		sdkTools, err := c.toAnthropicToolSchemas(toolSchemas)
		if err != nil {
			errs <- err
			return
		}

		maxTokens := int64(c.maxOutputTokens)
		// Anchor the prompt cache on the longest-stable prefix: the system
		// prompt. Marked once here, plus once on the tool list and once on
		// the tail of the final user message below — Anthropic caches up to
		// each breakpoint and re-checks byte-identity on the next request.
		// tool_result content stays byte-stable past these breakpoints
		// because the toolresult budget finalizes each message at ingest
		// and never rewrites history afterwards.
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
		// Thinking wiring mirrors TS anthropic.ts: explicit capability
		// metadata only, never model-name guesses. Off sends an explicit
		// disabled config; adaptive mode pairs the adaptive thinking type
		// with an output_config effort; budget mode reserves an answer room
		// under the shared output ceiling.
		if c.cfg.Reasoning == nil || *c.cfg.Reasoning {
			level := c.thinkingLevel
			switch {
			case level == config.ThinkingOff:
				disabled := anthropic.NewThinkingConfigDisabledParam()
				params.Thinking = anthropic.ThinkingConfigParamUnion{
					OfDisabled: &disabled,
				}
			case c.cfg.ThinkingMode == "adaptive":
				if effort := config.ToAnthropicThinkingEffort(level, c.cfg); effort != nil {
					params.Thinking = anthropic.ThinkingConfigParamUnion{
						OfAdaptive: &anthropic.ThinkingConfigAdaptiveParam{},
					}
					params.OutputConfig = anthropic.OutputConfigParam{
						Effort: anthropic.OutputConfigEffort(*effort),
					}
				}
			default:
				if effort := config.ToReasoningEffort(level, c.cfg); effort != nil && *effort != "none" {
					budget := config.ThinkingBudgetForLevel(config.ThinkingLevel(*effort))
					if room := c.maxOutputTokens - config.MinThinkingAnswerTokens; budget > room {
						budget = room
					}
					if budget > 0 {
						params.Thinking = anthropic.ThinkingConfigParamUnion{
							OfEnabled: &anthropic.ThinkingConfigEnabledParam{
								BudgetTokens: int64(budget),
							},
						}
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
			reqOpts = append(reqOpts, option.WithHeaderAdd("anthropic-beta", mcp.NativeToolSearchBeta))
		}

		stream := c.client.Messages.NewStreaming(ctx, params, reqOpts...)
		defer stream.Close()

		var currentToolName, currentToolID, jsonAccum string
		var thinkingAccum, thinkingSignature string
		inThinking := false
		// Usage and stop-reason are tracked locally from the raw events exactly
		// like TS, instead of relying on the SDK's Message.Accumulate: the SDK
		// overwrites OutputTokens unconditionally on message_delta and gates the
		// input/cache counters on field presence, whereas TS gates everything on
		// truthiness (anthropic.ts:527-556).
		inputTokens, outputTokens := 0, 0
		cacheReadInputTokens, cacheCreationInputTokens := 0, 0
		stopReason := "end_turn"

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
				u := ev.Message.Usage
				inputTokens = int(u.InputTokens)
				outputTokens = int(u.OutputTokens)
				cacheReadInputTokens = int(u.CacheReadInputTokens)
				cacheCreationInputTokens = int(u.CacheCreationInputTokens)
			case anthropic.MessageDeltaEvent:
				if ev.Delta.StopReason != "" {
					stopReason = string(ev.Delta.StopReason)
				}
				if ev.Usage.OutputTokens > 0 {
					outputTokens = int(ev.Usage.OutputTokens)
					if ev.Usage.InputTokens > 0 {
						inputTokens = int(ev.Usage.InputTokens)
					}
					if ev.Usage.CacheReadInputTokens > 0 {
						cacheReadInputTokens = int(ev.Usage.CacheReadInputTokens)
					}
					if ev.Usage.CacheCreationInputTokens > 0 {
						cacheCreationInputTokens = int(ev.Usage.CacheCreationInputTokens)
					}
				}
			case anthropic.ContentBlockStartEvent:
				switch ev.ContentBlock.Type {
				case "thinking":
					inThinking = true
					thinkingAccum = ""
					thinkingSignature = ""
				case "tool_use":
					// TS maps the provider-side computer tool name back onto
					// the internal ComputerUse tool name.
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
				if currentToolName != "" {
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
						ToolID:    currentToolID,
						ToolName:  currentToolName,
						Arguments: args,
					}
					currentToolName = ""
					currentToolID = ""
					jsonAccum = ""
				}
			}

			go readNext()
		}

		if err := stream.Err(); err != nil {
			// TS logs in the generic catch before classifying (anthropic.ts:571).
			log.Error("llm operation failed", "err", err)
			errs <- classifyAnthropicError(err)
			return
		}

		usage := UsageInfo{
			InputTokens:         inputTokens,
			OutputTokens:        outputTokens,
			CacheReadTokens:     cacheReadInputTokens,
			CacheCreationTokens: cacheCreationInputTokens,
		}
		events <- StreamEnd{StopReason: stopReason, Usage: usage}
	}()

	return events, errs
}

// toAnthropicToolSchemas mirrors TS toAnthropicToolSchema: only the
// input_schema shape is accepted; the official endpoint gets the explicit
// type:"custom" while other endpoints get no type field (gateways reject
// values they do not recognize); strict, eager_input_streaming and a
// non-deferred cache_control pass through from the schema.
func (c *anthropicClient) toAnthropicToolSchemas(toolSchemas []map[string]any) ([]anthropic.ToolUnionParam, error) {
	var sdkTools []anthropic.ToolUnionParam
	for _, s := range toolSchemas {
		inputSchema, ok := s["input_schema"].(map[string]any)
		if !ok {
			return nil, errors.New("Anthropic received a tool schema serialized for another protocol.")
		}
		name, _ := s["name"].(string)
		desc, _ := s["description"].(string)
		tool := &anthropic.ToolParam{
			Name:        name,
			Description: param.NewOpt(desc),
			InputSchema: toAnthropicInputSchema(inputSchema),
		}
		deferred, _ := s["defer_loading"].(bool)
		if deferred {
			tool.DeferLoading = param.NewOpt(true)
		}
		if c.useExplicitCustomToolType {
			tool.Type = anthropic.ToolTypeCustom
		}
		if strict, ok := s["strict"].(bool); ok {
			tool.Strict = param.NewOpt(strict)
		}
		if eager, ok := s["eager_input_streaming"].(bool); ok {
			tool.EagerInputStreaming = param.NewOpt(eager)
		}
		// TS: a deferred tool carrying cache_control makes the API reject the
		// whole request, so the schema-provided marker only passes through on
		// non-deferred tools.
		if !deferred {
			if cc, ok := s["cache_control"].(map[string]any); ok && cc["type"] == "ephemeral" {
				tool.CacheControl = anthropic.NewCacheControlEphemeralParam()
				if ttl, ok := cc["ttl"].(string); ok {
					tool.CacheControl.TTL = anthropic.CacheControlEphemeralTTL(ttl)
				}
			}
		}
		sdkTools = append(sdkTools, anthropic.ToolUnionParam{OfTool: tool})
	}
	return sdkTools, nil
}

// markLastUserTailForCache attaches an ephemeral cache_control marker to the
// tail of the final user-role message. Anthropic caches the prefix up to
// (and including) this block; subsequent requests with a byte-identical
// prefix hit the cache. tool_result content past this breakpoint stays
// byte-stable because the toolresult budget finalizes each message at ingest
// and never rewrites history afterwards.
//
// Mutates `messages` in place. No-op if there's no user message or the
// final user message has no content blocks.
func markLastUserTailForCache(messages []anthropic.MessageParam) {
	for _, v := range slices.Backward(messages) {
		if v.Role != anthropic.MessageParamRoleUser {
			continue
		}
		blocks := v.Content
		if len(blocks) == 0 {
			return
		}
		// Prefer the last non-image block: some gateways reject cache_control
		// on image blocks. Fall back to the true tail if everything is an
		// image (TS markLastUserTailForCache).
		target := &blocks[len(blocks)-1]
		for j := len(blocks) - 1; j >= 0; j-- {
			if blocks[j].OfImage == nil {
				target = &blocks[j]
				break
			}
		}
		setBlockCacheControl(target)
		return
	}
}

// setBlockCacheControl marks whichever content-block variant is present,
// mirroring the TS Reflect.set that works on any block type.
func setBlockCacheControl(block *anthropic.ContentBlockParamUnion) {
	cc := anthropic.NewCacheControlEphemeralParam()
	switch {
	case block.OfText != nil:
		block.OfText.CacheControl = cc
	case block.OfImage != nil:
		block.OfImage.CacheControl = cc
	case block.OfToolResult != nil:
		block.OfToolResult.CacheControl = cc
	case block.OfDocument != nil:
		block.OfDocument.CacheControl = cc
	case block.OfSearchResult != nil:
		block.OfSearchResult.CacheControl = cc
	}
}

func buildAnthropicMessages(messages []conversation.Message) ([]anthropic.MessageParam, error) {
	var result []anthropic.MessageParam
	for _, m := range messages {
		if m.Role == "assistant" {
			var blocks []anthropic.ContentBlockParamUnion
			for _, tb := range m.ThinkingBlocks {
				blocks = append(blocks, anthropic.NewThinkingBlock(tb.Signature, tb.Thinking))
			}
			// Assistant content is model-produced text; flatten defensively
			// (TS: typeof content === "string" ? content : contentToText).
			if text := assistantText(m); text != "" {
				blocks = append(blocks, anthropic.NewTextBlock(text))
			}
			for _, tu := range m.ToolUses {
				// The provider-side name of the ComputerUse tool is "computer"
				// (TS: tool_use request blocks rename it on the way out).
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
				// TS (anthropic.ts:224) passes the tool-result content through
				// raw: the structured block array when present, otherwise the
				// plain string. The blocks reach the wire verbatim — including
				// `context: null` on search-result blocks and block types the
				// SDK's typed union cannot carry — so the content is injected
				// through SetExtraFields instead of re-encoding it.
				toolResult := &anthropic.ToolResultBlockParam{
					ToolUseID: tr.ToolUseID,
					IsError:   param.NewOpt(tr.IsError),
				}
				if len(tr.ContentBlocks) > 0 {
					toolResult.SetExtraFields(map[string]any{"content": tr.ContentBlocks})
				} else {
					toolResult.SetExtraFields(map[string]any{"content": tr.Content})
				}
				blocks = append(blocks, anthropic.ContentBlockParamUnion{OfToolResult: toolResult})
			}
			// TS: trailing user content on a tool-result message is appended
			// after the tool_result blocks.
			if m.Content != "" || len(m.ContentBlocks) > 0 {
				userBlocks, err := userContentBlocks(m)
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
			// Merge consecutive user text messages to maintain alternation.
			blocks, err := userContentBlocks(m)
			if err != nil {
				return nil, err
			}
			canMerge := false
			if n := len(result); n > 0 {
				prev := result[n-1]
				// TS merges only into a plain-text user (first block text or
				// image); a tool_result-headed message is never merged into.
				if prev.Role == anthropic.MessageParamRoleUser && len(prev.Content) > 0 &&
					(prev.Content[0].OfText != nil || prev.Content[0].OfImage != nil) {
					canMerge = true
				}
			}
			if canMerge {
				result[len(result)-1].Content = append(result[len(result)-1].Content, blocks...)
			} else {
				result = append(result, anthropic.MessageParam{
					Role:    anthropic.MessageParamRoleUser,
					Content: blocks,
				})
			}
		}
	}
	return result, nil
}

// blockTypeOrUnknown mirrors strArg(raw, "type", "unknown") in the TS
// userBlocksFor error message.
func blockTypeOrUnknown(b map[string]any) string {
	if t, ok := b["type"].(string); ok {
		return t
	}
	return "unknown"
}

// userContentBlocks builds the content blocks for a user message (TS
// userBlocksFor). Plain text becomes a single text block; structured
// ContentBlocks are normalized like normalizeToolResultContentBlock. A
// tool_reference or a block that fails normalization throws in TS, so the
// same unsupported-block error is returned here.
func userContentBlocks(m conversation.Message) ([]anthropic.ContentBlockParamUnion, error) {
	// TS distinguishes string content from a block array: an explicitly empty
	// array maps to zero blocks, so only a nil slice (string content) turns
	// into the single text block.
	if m.ContentBlocks == nil {
		return []anthropic.ContentBlockParamUnion{anthropic.NewTextBlock(m.Content)}, nil
	}
	out := make([]anthropic.ContentBlockParamUnion, 0, len(m.ContentBlocks))
	for _, b := range m.ContentBlocks {
		blockType, _ := b["type"].(string)
		switch blockType {
		case "text":
			text, ok := b["text"].(string)
			if !ok {
				return nil, fmt.Errorf("Unsupported user content block: %s", blockTypeOrUnknown(b))
			}
			out = append(out, anthropic.NewTextBlock(text))
		case "image":
			img := imageBlockParam(b)
			if img == nil {
				return nil, fmt.Errorf("Unsupported user content block: %s", blockTypeOrUnknown(b))
			}
			out = append(out, anthropic.ContentBlockParamUnion{OfImage: img})
		case "document":
			doc := documentBlockParam(b)
			if doc == nil {
				return nil, fmt.Errorf("Unsupported user content block: %s", blockTypeOrUnknown(b))
			}
			out = append(out, anthropic.ContentBlockParamUnion{OfDocument: doc})
		case "search_result":
			sr := searchResultBlockParam(b)
			if sr == nil {
				return nil, fmt.Errorf("Unsupported user content block: %s", blockTypeOrUnknown(b))
			}
			out = append(out, anthropic.ContentBlockParamUnion{OfSearchResult: sr})
		default:
			// tool_reference and anything unrecognized: TS throws.
			return nil, fmt.Errorf("Unsupported user content block: %s", blockTypeOrUnknown(b))
		}
	}
	return out, nil
}

// anthropicAPIErrorMessage renders err.message exactly like the TS SDK: the
// Anthropic SDK's makeMessage keys off the whole response body (there is no
// "error" unwrap on this platform), so the result is "<status> <body JSON>"
// unless the body carries a top-level message. The Go SDK's Error() renders a
// request dump instead, so the message is rebuilt here.
func anthropicAPIErrorMessage(apiErr *anthropic.Error) string {
	raw := apiErr.RawJSON()
	var body any
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		body = nil
	}
	return stainlessMakeMessage(apiErr.StatusCode, body, raw)
}

func classifyAnthropicError(err error) error {
	// TS: already-classified errors pass through unchanged.
	switch err.(type) {
	case *LLMError, *AuthenticationError, *RateLimitError, *NetworkError, *ContextTooLongError:
		return err
	}
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		message := anthropicAPIErrorMessage(apiErr)
		// TS: 413 prompt_too_long, or a 400 whose message matches one of the
		// known context-length phrasings.
		if apiErr.StatusCode == 413 ||
			(apiErr.StatusCode == 400 && ContainsContextLengthError(message)) {
			return &ContextTooLongError{Message: fmt.Sprintf("Prompt too long: %s", message)}
		}
		// TS keys the remaining branches off the HTTP status, not the body's
		// error type.
		switch apiErr.StatusCode {
		case 401:
			return &AuthenticationError{Message: fmt.Sprintf("Invalid API key: %s", message)}
		case 429:
			retry := ""
			if apiErr.Response != nil {
				retry = apiErr.Response.Header.Get("Retry-After")
			}
			// TS wording: "Rate Limited" plus a parsed retry-after ("retry
			// after Ns.") or "please wait." when the header is absent or
			// carries no leading digits.
			msg := "Rate Limited"
			if retry != "" {
				if seconds, ok := jsParseInt(retry); ok {
					msg += fmt.Sprintf(", retry after %ds.", seconds)
				} else {
					msg += ", please wait."
				}
			} else {
				msg += ", please wait."
			}
			return &RateLimitError{Message: msg, RetryAfter: retry}
		default:
			return &LLMError{Message: fmt.Sprintf("Anthropic API error (%d): %s", apiErr.StatusCode, message)}
		}
	}
	// Transport-level failures: the TS SDK wraps them in APIError subclasses
	// with an undefined status, so the classifier renders the connection text.
	return classifyTransportError(err, "Anthropic")
}

// imageBlockParam builds an SDK image block from a raw image block, mirroring
// TS normalizeImageBlock: a url source passes through, and a base64 source
// requires a known image media type (the data string may be empty, exactly
// like the TS typeof check). Returns nil for anything else.
func imageBlockParam(b map[string]any) *anthropic.ImageBlockParam {
	source, _ := b["source"].(map[string]any)
	if source == nil {
		return nil
	}
	sourceType, _ := source["type"].(string)
	switch sourceType {
	case "url":
		url, ok := source["url"].(string)
		if !ok {
			return nil
		}
		return &anthropic.ImageBlockParam{
			Source: anthropic.ImageBlockParamSourceUnion{
				OfURL: &anthropic.URLImageSourceParam{URL: url},
			},
		}
	case "base64":
		mediaType, ok := source["media_type"].(string)
		if !ok {
			return nil
		}
		data, ok := source["data"].(string)
		if !ok {
			return nil
		}
		var mt anthropic.Base64ImageSourceMediaType
		switch mediaType {
		case "image/jpeg":
			mt = anthropic.Base64ImageSourceMediaTypeImageJPEG
		case "image/png":
			mt = anthropic.Base64ImageSourceMediaTypeImagePNG
		case "image/gif":
			mt = anthropic.Base64ImageSourceMediaTypeImageGIF
		case "image/webp":
			mt = anthropic.Base64ImageSourceMediaTypeImageWebP
		default:
			return nil
		}
		return &anthropic.ImageBlockParam{
			Source: anthropic.ImageBlockParamSourceUnion{
				OfBase64: &anthropic.Base64ImageSourceParam{Data: data, MediaType: mt},
			},
		}
	}
	return nil
}

// documentBlockParam mirrors TS normalizeDocumentBlock: url, base64 PDF,
// plain text and nested content sources (a plain string or a text/image block
// array) are supported; title and context pass through when they are a string
// or an explicit null.
func documentBlockParam(b map[string]any) *anthropic.DocumentBlockParam {
	source, _ := b["source"].(map[string]any)
	if source == nil {
		return nil
	}
	doc := &anthropic.DocumentBlockParam{}
	sourceType, _ := source["type"].(string)
	switch sourceType {
	case "url":
		url, ok := source["url"].(string)
		if !ok {
			return nil
		}
		doc.Source = anthropic.DocumentBlockParamSourceUnion{
			OfURL: &anthropic.URLPDFSourceParam{URL: url},
		}
	case "base64":
		mediaType, _ := source["media_type"].(string)
		data, ok := source["data"].(string)
		if mediaType != "application/pdf" || !ok {
			return nil
		}
		doc.Source = anthropic.DocumentBlockParamSourceUnion{
			OfBase64: &anthropic.Base64PDFSourceParam{Data: data},
		}
	case "text":
		mediaType, _ := source["media_type"].(string)
		data, ok := source["data"].(string)
		if mediaType != "text/plain" || !ok {
			return nil
		}
		doc.Source = anthropic.DocumentBlockParamSourceUnion{
			OfText: &anthropic.PlainTextSourceParam{Data: data},
		}
	case "content":
		// TS accepts both a plain string and a text/image block array here
		// (ContentBlockSource.content: string | Array<...>).
		switch raw := source["content"].(type) {
		case string:
			doc.Source = anthropic.DocumentBlockParamSourceUnion{
				OfContent: &anthropic.ContentBlockSourceParam{
					Content: anthropic.ContentBlockSourceContentUnionParam{
						OfString: param.NewOpt(raw),
					},
				},
			}
		case []any:
			// Non-nil even when empty so the union marshals [] (TS sends the
			// empty array through rather than null).
			content := make([]anthropic.ContentBlockSourceContentItemUnionParam, 0, len(raw))
			for _, rawItem := range raw {
				item, _ := rawItem.(map[string]any)
				itemType, _ := item["type"].(string)
				switch itemType {
				case "text":
					text, ok := item["text"].(string)
					if !ok {
						return nil
					}
					content = append(content, anthropic.ContentBlockSourceContentItemUnionParam{
						OfText: &anthropic.TextBlockParam{Text: text},
					})
				case "image":
					img := imageBlockParam(item)
					if img == nil {
						return nil
					}
					content = append(content, anthropic.ContentBlockSourceContentItemUnionParam{
						OfImage: img,
					})
				default:
					return nil
				}
			}
			doc.Source = anthropic.DocumentBlockParamSourceUnion{
				OfContent: &anthropic.ContentBlockSourceParam{
					Content: anthropic.ContentBlockSourceContentUnionParam{
						OfContentBlockSourceContent: content,
					},
				},
			}
		default:
			return nil
		}
	default:
		return nil
	}
	// TS: title and context pass through when they are a string or an explicit
	// null; any other type omits the field. The SDK structs only carry the
	// string variant, so an explicit null goes through the extras (the same
	// machinery the OpenAI port uses for function_call_output).
	extras := map[string]any{}
	if rawTitle, present := b["title"]; present {
		switch title := rawTitle.(type) {
		case string:
			doc.Title = param.NewOpt(title)
		case nil:
			extras["title"] = nil
		}
	}
	if rawContext, present := b["context"]; present {
		switch context := rawContext.(type) {
		case string:
			doc.Context = param.NewOpt(context)
		case nil:
			extras["context"] = nil
		}
	}
	if len(extras) > 0 {
		doc.SetExtraFields(extras)
	}
	return doc
}

// searchResultBlockParam mirrors the TS normalizeToolResultContentBlock
// search_result branch: source and title must be strings and every content
// entry must normalize as a text block.
func searchResultBlockParam(b map[string]any) *anthropic.SearchResultBlockParam {
	source, ok := b["source"].(string)
	if !ok {
		return nil
	}
	title, ok := b["title"].(string)
	if !ok {
		return nil
	}
	rawContent, ok := b["content"].([]any)
	if !ok {
		return nil
	}
	content := make([]anthropic.TextBlockParam, 0, len(rawContent))
	for _, rawItem := range rawContent {
		item, _ := rawItem.(map[string]any)
		itemType, _ := item["type"].(string)
		text, isText := item["text"].(string)
		if itemType != "text" || !isText {
			return nil
		}
		content = append(content, anthropic.TextBlockParam{Text: text})
	}
	return &anthropic.SearchResultBlockParam{
		Content: content,
		Source:  source,
		Title:   title,
	}
}
