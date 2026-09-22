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
	"net"
	"regexp"
	"strconv"
	"strings"
)

type LLMError struct {
	Message string
}

func (e *LLMError) Error() string { return e.Message }

type AuthenticationError struct {
	Message string
}

func (e *AuthenticationError) Error() string { return e.Message }

type RateLimitError struct {
	Message    string
	RetryAfter string
}

func (e *RateLimitError) Error() string { return e.Message }

type NetworkError struct {
	Message string
}

func (e *NetworkError) Error() string { return e.Message }

type ContextTooLongError struct {
	Message string
}

func (e *ContextTooLongError) Error() string { return e.Message }

// contextLengthPatterns detect provider "context too long" failures across
// protocols by message (TS: containsContextLengthError). Anthropic returns
// 400 invalid_request_error with "prompt is too long: N tokens > M maximum";
// OpenAI (and Anthropic-compatible gateways such as DeepSeek) use the
// context_length_exceeded code or "maximum context length is N tokens"
// wording.
var contextLengthPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)context_length_exceeded`),
	regexp.MustCompile(`(?i)maximum\s+context\s+length`),
	regexp.MustCompile(`(?i)prompts?\s+(?:is\s+)?too\s+long`),
}

// ContainsContextLengthError reports whether msg matches any of the known
// provider phrasings of a context-window overrun.
func ContainsContextLengthError(msg string) bool {
	for _, pattern := range contextLengthPatterns {
		if pattern.MatchString(msg) {
			return true
		}
	}
	return false
}

// stainlessMakeMessage mirrors APIError.makeMessage from the Stainless SDKs
// (verified against @anthropic-ai/sdk/core/error.js and openai/core/error.js),
// which produces the text the TS clients expose as err.message. errorValue is
// the payload each SDK keys the message off — the whole response body for
// Anthropic, the body's "error" object for OpenAI — and rawJSON is that
// payload exactly as received (the Go SDKs hand back that same slice).
//
// The JS truthiness chain is reproduced: an empty-string message falls through
// to the JSON dump, and the status prefix is only added when both parts exist.
func stainlessMakeMessage(status int, errorValue any, rawJSON string) string {
	msg := ""
	if obj, ok := errorValue.(map[string]any); ok {
		if v, present := obj["message"]; present && v != nil {
			if s, isStr := v.(string); isStr {
				msg = s
			} else if b, err := json.Marshal(v); err == nil {
				msg = string(b)
			}
		}
	}
	if msg == "" && errorValue != nil {
		msg = compactRawJSON(rawJSON)
	}
	switch {
	case status != 0 && msg != "":
		return fmt.Sprintf("%d %s", status, msg)
	case status != 0:
		return fmt.Sprintf("%d status code (no body)", status)
	case msg != "":
		return msg
	default:
		return rawJSON
	}
}

// classifyTransportError maps a transport-level failure onto the wording the
// TS SDKs produce. Their APIError subclasses (APIUserAbortError,
// APIConnectionTimeoutError, APIConnectionError) carry an undefined status, so
// the TS classifiers emit "<Proto> API error (undefined): <SDK text>" — the
// Go SDKs do not wrap transport errors in their APIError types, so the text is
// reconstructed here.
func classifyTransportError(err error, proto string) error {
	message := "Connection error."
	switch {
	case errors.Is(err, context.Canceled):
		message = "Request was aborted."
	case errors.Is(err, context.DeadlineExceeded):
		message = "Request timed out."
	default:
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			message = "Request timed out."
		}
	}
	return &LLMError{Message: fmt.Sprintf("%s API error (undefined): %s", proto, message)}
}

// compactRawJSON renders raw JSON the way JSON.stringify(JSON.parse(raw))
// does for object shapes: no insignificant whitespace, received key order
// preserved (which is also the order JSON.parse keeps for the non-integer-like
// keys error bodies use). The escape normalizations JSON.parse+stringify apply
// ("\u0041" → A, "\/" → "/") are not reproduced.
func compactRawJSON(raw string) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, []byte(raw)); err != nil {
		return raw
	}
	return buf.String()
}

// jsParseInt mirrors Number.parseInt(v, 10): whitespace is trimmed, an
// optional sign is accepted, and the leading run of decimal digits is parsed
// ("12abc" → 12). ok=false when no digits are present (JS NaN).
func jsParseInt(s string) (int, bool) {
	s = strings.TrimSpace(s)
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.Atoi(s[:i])
	if err != nil {
		return 0, false
	}
	return n, true
}
