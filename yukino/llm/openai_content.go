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
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/utils"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/packages/param"
	"github.com/openai/openai-go/responses"
)

// The helpers in this file mirror the content-mapping functions of the TS
// openai client (openai.ts): image/document blocks become data URLs and file
// parts, ComputerUse calls map onto the Responses computer_call protocol,
// and user messages carry structured text/image parts.

// imageDataUrl mirrors TS imageDataUrl: image blocks become a data URL
// (base64 source) or pass through their source URL. "" is the null case.
func imageDataUrl(block map[string]any) string {
	if t, _ := block["type"].(string); t != "image" {
		return ""
	}
	source, _ := block["source"].(map[string]any)
	if source == nil {
		return ""
	}
	switch sourceType, _ := source["type"].(string); sourceType {
	case "url":
		url, _ := source["url"].(string)
		return url
	case "base64":
		mediaType, _ := source["media_type"].(string)
		data, _ := source["data"].(string)
		if mediaType != "" && data != "" {
			return "data:" + mediaType + ";base64," + data
		}
	}
	return ""
}

// documentTitle mirrors the TS title fallback for document blocks.
func documentTitle(block map[string]any) string {
	if title, ok := block["title"].(string); ok && title != "" {
		return title
	}
	return "tool-result"
}

// documentForResponses mirrors TS documentForResponses: a document block
// becomes an input_file item for the Responses rich-output list. The list is
// built as plain maps because the Go SDK models function_call_output.output
// as a string; the rich list is injected via SetExtraFields (see
// buildOpenAIInput).
func documentForResponses(block map[string]any) map[string]any {
	if t, _ := block["type"].(string); t != "document" {
		return nil
	}
	source, _ := block["source"].(map[string]any)
	if source == nil {
		return nil
	}
	title := documentTitle(block)
	switch sourceType, _ := source["type"].(string); sourceType {
	case "url":
		if url, _ := source["url"].(string); url != "" {
			return map[string]any{"type": "input_file", "file_url": url}
		}
	case "base64":
		if data, _ := source["data"].(string); data != "" {
			return map[string]any{"type": "input_file", "file_data": data, "filename": title + ".pdf"}
		}
	case "text":
		if data, _ := source["data"].(string); data != "" {
			encoded := base64.StdEncoding.EncodeToString([]byte(data))
			return map[string]any{"type": "input_file", "file_data": encoded, "filename": title + ".txt"}
		}
	}
	return nil
}

// documentForChat mirrors TS documentForChat: a document block becomes a Chat
// Completions file part. The url source type is not supported on this path.
func documentForChat(block map[string]any) *openai.ChatCompletionContentPartFileParam {
	if t, _ := block["type"].(string); t != "document" {
		return nil
	}
	source, _ := block["source"].(map[string]any)
	if source == nil {
		return nil
	}
	title := documentTitle(block)
	switch sourceType, _ := source["type"].(string); sourceType {
	case "base64":
		if data, _ := source["data"].(string); data != "" {
			return &openai.ChatCompletionContentPartFileParam{
				File: openai.ChatCompletionContentPartFileFileParam{
					FileData: param.NewOpt(data),
					Filename: param.NewOpt(title + ".pdf"),
				},
			}
		}
	case "text":
		if data, _ := source["data"].(string); data != "" {
			encoded := base64.StdEncoding.EncodeToString([]byte(data))
			return &openai.ChatCompletionContentPartFileParam{
				File: openai.ChatCompletionContentPartFileFileParam{
					FileData: param.NewOpt(encoded),
					Filename: param.NewOpt(title + ".txt"),
				},
			}
		}
	}
	return nil
}

// toolOutputForResponses mirrors TS toolOutputForResponses. Without content
// blocks the plain text is returned; otherwise a rich item list is built
// (input_text + input_image/input_file) and returned as maps for the
// ExtraFields injection.
func toolOutputForResponses(tr conversation.ToolResultBlock) (string, []map[string]any) {
	if len(tr.ContentBlocks) == 0 {
		return tr.Content, nil
	}
	var rich []map[string]any
	if tr.Content != "" {
		rich = append(rich, map[string]any{"type": "input_text", "text": tr.Content})
	}
	for _, block := range tr.ContentBlocks {
		if url := imageDataUrl(block); url != "" {
			rich = append(rich, map[string]any{"type": "input_image", "image_url": url, "detail": "auto"})
			continue
		}
		if file := documentForResponses(block); file != nil {
			rich = append(rich, file)
		}
	}
	if len(rich) > 0 {
		return "", rich
	}
	return tr.Content, nil
}

// jsNumber mirrors JS Number() coercion for JSON values: numbers pass
// through, numeric strings parse, anything else is NaN which JSON.stringify
// renders as null.
func jsNumber(v any) any {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err == nil {
			return f
		}
	}
	return nil
}

// jsTruthyValue mirrors JS truthiness for the ComputerUse argument mapping
// (TS gates optional fields with `keys?.length` / `check.code ? ...`).
func jsTruthyValue(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	default:
		return true
	}
}

// computerCallArguments mirrors TS computerCallArguments: the completed
// computer_call item becomes the ComputerUse tool arguments. The Go SDK
// predates the batched actions field, so the item is re-parsed from its raw
// JSON (TS: item.actions ?? (item.action ? [item.action] : [])).
func computerCallArguments(rawJSON string) map[string]any {
	var item map[string]any
	if rawJSON != "" {
		json.Unmarshal([]byte(rawJSON), &item)
	}
	if item == nil {
		item = map[string]any{}
	}
	var actions []any
	if list, ok := item["actions"].([]any); ok {
		actions = list
	} else if action, ok := item["action"].(map[string]any); ok {
		actions = []any{action}
	}
	mapped := make([]any, 0, len(actions))
	for _, raw := range actions {
		mapped = append(mapped, computerActionArguments(raw))
	}
	checks := []any{}
	if rawChecks, ok := item["pending_safety_checks"].([]any); ok {
		for _, raw := range rawChecks {
			check, _ := raw.(map[string]any)
			if check == nil {
				continue
			}
			out := map[string]any{}
			if id, ok := check["id"]; ok {
				out["id"] = id
			}
			if jsTruthyValue(check["code"]) {
				out["code"] = check["code"]
			}
			if jsTruthyValue(check["message"]) {
				out["message"] = check["message"]
			}
			checks = append(checks, out)
		}
	}
	args := map[string]any{
		"actions":             mapped,
		"pendingSafetyChecks": checks,
	}
	if status, ok := item["status"]; ok {
		args["status"] = status
	}
	return args
}

// computerActionArguments mirrors TS computerActionArguments: scroll actions
// rename scroll_x/scroll_y onto scrollX/scrollY; click/double_click/drag/move
// pass through without the keys field (re-added when non-empty); everything
// else passes through unchanged. Keys absent from the wire payload stay
// absent, matching JSON.stringify's omission of undefined values.
func computerActionArguments(raw any) map[string]any {
	action, _ := raw.(map[string]any)
	if action == nil {
		return map[string]any{}
	}
	actionType, _ := action["type"].(string)
	switch actionType {
	case "scroll":
		out := map[string]any{"type": "scroll"}
		if v, ok := action["x"]; ok {
			out["x"] = v
		}
		if v, ok := action["y"]; ok {
			out["y"] = v
		}
		if v, ok := action["scroll_x"]; ok {
			out["scrollX"] = v
		}
		if v, ok := action["scroll_y"]; ok {
			out["scrollY"] = v
		}
		if keys, ok := action["keys"].([]any); ok && len(keys) > 0 {
			out["keys"] = keys
		}
		return out
	case "click", "double_click", "drag", "move":
		out := make(map[string]any, len(action))
		for k, v := range action {
			if k == "keys" {
				continue
			}
			out[k] = v
		}
		if keys, ok := action["keys"].([]any); ok && len(keys) > 0 {
			out["keys"] = keys
		}
		return out
	default:
		out := make(map[string]any, len(action))
		for k, v := range action {
			out[k] = v
		}
		return out
	}
}

// computerActionsForResponses mirrors TS computerActionsForResponses: the
// OpenAI-style actions[] batch becomes the Responses ComputerActionList.
// Scroll actions normalize scrollX/scrollY onto scroll_x/scroll_y; every
// other action passes through as-is.
func computerActionsForResponses(args map[string]any) []any {
	rawActions, ok := args["actions"].([]any)
	if !ok {
		return nil
	}
	actions := make([]any, 0, len(rawActions))
	for _, raw := range rawActions {
		rec, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		actionType, ok := rec["type"].(string)
		if !ok {
			continue
		}
		if actionType == "scroll" {
			action := map[string]any{
				"type":     "scroll",
				"x":        jsNumber(rec["x"]),
				"y":        jsNumber(rec["y"]),
				"scroll_x": jsNumber(rec["scrollX"]),
				"scroll_y": jsNumber(rec["scrollY"]),
			}
			if keys, ok := rec["keys"].([]any); ok {
				mapped := make([]string, 0, len(keys))
				for _, key := range keys {
					mapped = append(mapped, utils.AsString(key))
				}
				action["keys"] = mapped
			}
			actions = append(actions, action)
			continue
		}
		actions = append(actions, rec)
	}
	return actions
}

// safetyChecksForResponses mirrors TS safetyChecksForResponses: the
// pendingSafetyChecks argument becomes {id, code?, message?} records; entries
// without a string id are dropped.
func safetyChecksForResponses(args map[string]any) []map[string]any {
	rawChecks, ok := args["pendingSafetyChecks"].([]any)
	if !ok {
		return nil
	}
	var checks []map[string]any
	for _, raw := range rawChecks {
		rec, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, ok := rec["id"].(string)
		if !ok {
			continue
		}
		check := map[string]any{"id": id}
		if code, ok := rec["code"].(string); ok {
			check["code"] = code
		}
		if message, ok := rec["message"].(string); ok {
			check["message"] = message
		}
		checks = append(checks, check)
	}
	return checks
}

// computerScreenshotUrl mirrors TS computerScreenshotUrl: the first image
// block of a ComputerUse tool result becomes the screenshot URL.
func computerScreenshotUrl(tr conversation.ToolResultBlock) string {
	for _, block := range tr.ContentBlocks {
		if url := imageDataUrl(block); url != "" {
			return url
		}
	}
	return ""
}

// assistantText mirrors the TS `typeof content === "string" ? content :
// contentToText(content)` helper used by the openai builders.
func assistantText(m conversation.Message) string {
	if len(m.ContentBlocks) > 0 {
		return utils.ContentToText(m.ContentBlocks)
	}
	return m.Content
}

// userContentsFor mirrors TS userContentsFor: user message content for the
// Responses API. Plain text stays a string; structured content becomes
// input_text/input_image parts (other block types are dropped).
func userContentsFor(m conversation.Message) responses.EasyInputMessageContentUnionParam {
	if len(m.ContentBlocks) == 0 {
		return responses.EasyInputMessageContentUnionParam{OfString: param.NewOpt(m.Content)}
	}
	// Non-nil so an all-unrecognized block list still serializes as [] —
	// TS builds an empty parts array in that case.
	parts := make(responses.ResponseInputMessageContentListParam, 0, len(m.ContentBlocks))
	for _, block := range m.ContentBlocks {
		if t, _ := block["type"].(string); t == "text" {
			text, _ := block["text"].(string)
			parts = append(parts, responses.ResponseInputContentUnionParam{
				OfInputText: &responses.ResponseInputTextParam{Text: text},
			})
			continue
		}
		if url := imageDataUrl(block); url != "" {
			parts = append(parts, responses.ResponseInputContentUnionParam{
				OfInputImage: &responses.ResponseInputImageParam{
					ImageURL: param.NewOpt(url),
					Detail:   responses.ResponseInputImageDetailAuto,
				},
			})
		}
	}
	return responses.EasyInputMessageContentUnionParam{OfInputItemContentList: parts}
}

// userPartsFor mirrors TS userPartsFor: user message content for Chat
// Completions. Plain text yields nil (callers send the string form);
// structured content becomes text/image_url parts.
func userPartsFor(m conversation.Message) []openai.ChatCompletionContentPartUnionParam {
	if len(m.ContentBlocks) == 0 {
		return nil
	}
	var parts []openai.ChatCompletionContentPartUnionParam
	for _, block := range m.ContentBlocks {
		if t, _ := block["type"].(string); t == "text" {
			text, _ := block["text"].(string)
			parts = append(parts, openai.ChatCompletionContentPartUnionParam{
				OfText: &openai.ChatCompletionContentPartTextParam{Text: text},
			})
			continue
		}
		if url := imageDataUrl(block); url != "" {
			parts = append(parts, openai.ChatCompletionContentPartUnionParam{
				OfImageURL: &openai.ChatCompletionContentPartImageParam{
					ImageURL: openai.ChatCompletionContentPartImageImageURLParam{URL: url},
				},
			})
		}
	}
	return parts
}

// collectRichParts mirrors TS collectRichParts: rich content blocks of a tool
// result become a follow-up user message's parts, prefixed by a marker text
// so the model can attribute them to the tool call.
func collectRichParts(tr conversation.ToolResultBlock) []openai.ChatCompletionContentPartUnionParam {
	if len(tr.ContentBlocks) == 0 {
		return nil
	}
	var rich []openai.ChatCompletionContentPartUnionParam
	for _, block := range tr.ContentBlocks {
		if url := imageDataUrl(block); url != "" {
			rich = append(rich, openai.ChatCompletionContentPartUnionParam{
				OfImageURL: &openai.ChatCompletionContentPartImageParam{
					ImageURL: openai.ChatCompletionContentPartImageImageURLParam{URL: url},
				},
			})
			continue
		}
		if file := documentForChat(block); file != nil {
			rich = append(rich, openai.ChatCompletionContentPartUnionParam{OfFile: file})
		}
	}
	if len(rich) == 0 {
		return nil
	}
	return append([]openai.ChatCompletionContentPartUnionParam{{
		OfText: &openai.ChatCompletionContentPartTextParam{
			Text: "[Rich content returned by tool call " + tr.ToolUseID + "]",
		},
	}}, rich...)
}
