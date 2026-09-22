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

package logger

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
)

// dynamicHandler is the slog.Handler behind every exported handle. It
// resolves the current root destination on each record: before InitLogger
// (and after CloseLogger) Enabled reports false and Handle drops records,
// so early log calls are safe no-ops — the TS silent-fallback semantics.
//
// It also applies the Go-only redaction of sensitive keys and the error
// serialization (cause chain) that TS performs via pino's err serializer.
type dynamicHandler struct {
	attrs  []slog.Attr // static bindings, already transformed and group-wrapped
	groups []string    // open WithGroup stack, applied to per-record attrs
}

func newDynamicHandler(attrs []slog.Attr, groups []string) *dynamicHandler {
	return &dynamicHandler{attrs: attrs, groups: groups}
}

func (h *dynamicHandler) Enabled(ctx context.Context, level slog.Level) bool {
	mu.Lock()
	st := state
	mu.Unlock()
	if st == nil {
		return false
	}
	return st.handler.Enabled(ctx, level)
}

func (h *dynamicHandler) Handle(ctx context.Context, r slog.Record) error {
	mu.Lock()
	st := state
	mu.Unlock()
	if st == nil {
		return nil // silent fallback
	}
	out := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	out.AddAttrs(st.base...)
	out.AddAttrs(h.attrs...)
	callAttrs := make([]slog.Attr, 0, r.NumAttrs())
	r.Attrs(func(a slog.Attr) bool {
		callAttrs = append(callAttrs, transformAttr(a))
		return true
	})
	out.AddAttrs(wrapInGroups(callAttrs, h.groups)...)
	return st.handler.Handle(ctx, out)
}

func (h *dynamicHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	transformed := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		transformed = append(transformed, transformAttr(a))
	}
	wrapped := wrapInGroups(transformed, h.groups)
	clone := newDynamicHandler(nil, h.groups)
	clone.attrs = make([]slog.Attr, 0, len(h.attrs)+len(wrapped))
	clone.attrs = append(clone.attrs, h.attrs...)
	clone.attrs = append(clone.attrs, wrapped...)
	return clone
}

func (h *dynamicHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	clone := newDynamicHandler(h.attrs, nil)
	clone.groups = make([]string, 0, len(h.groups)+1)
	clone.groups = append(clone.groups, h.groups...)
	clone.groups = append(clone.groups, name)
	return clone
}

// wrapInGroups nests attrs under the open WithGroup stack, innermost first.
func wrapInGroups(attrs []slog.Attr, groups []string) []slog.Attr {
	for i := len(groups) - 1; i >= 0; i-- {
		args := make([]any, len(attrs))
		for j, a := range attrs {
			args[j] = a
		}
		attrs = []slog.Attr{slog.Group(groups[i], args...)}
	}
	return attrs
}

// redactedPlaceholder replaces values whose key is sensitive.
const redactedPlaceholder = "[REDACTED]"

// sensitiveKeys lists normalized key names whose values never reach the log
// file. Go-only addition: the TS pino logger has no redaction list.
var sensitiveKeys = map[string]bool{
	"password":      true,
	"passwd":        true,
	"secret":        true,
	"clientsecret":  true,
	"token":         true,
	"accesstoken":   true,
	"refreshtoken":  true,
	"apitoken":      true,
	"apikey":        true,
	"accesskey":     true,
	"secretkey":     true,
	"privatekey":    true,
	"authorization": true,
	"auth":          true,
	"cookie":        true,
	"credentials":   true,
	"sessiontoken":  true,
}

// isSensitiveKey normalizes a key (lower-cased, '-'/'_' stripped) and
// checks it against sensitiveKeys.
func isSensitiveKey(key string) bool {
	var b strings.Builder
	for _, r := range strings.ToLower(key) {
		if r != '_' && r != '-' {
			b.WriteRune(r)
		}
	}
	return sensitiveKeys[b.String()]
}

// transformAttr redacts sensitive keys, serializes error values and recurses
// into nested groups and maps.
func transformAttr(a slog.Attr) slog.Attr {
	if isSensitiveKey(a.Key) {
		return slog.String(a.Key, redactedPlaceholder)
	}
	v := a.Value.Resolve()
	switch v.Kind() {
	case slog.KindGroup:
		group := v.Group()
		out := make([]slog.Attr, len(group))
		for i, ga := range group {
			out[i] = transformAttr(ga)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(out...)}
	case slog.KindAny:
		switch raw := v.Any().(type) {
		case error:
			return slog.Any(a.Key, serializeError(raw))
		case map[string]any:
			return slog.Any(a.Key, redactMap(raw))
		}
	}
	return a
}

// redactMap applies key redaction and error serialization inside map values.
func redactMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		switch {
		case isSensitiveKey(k):
			out[k] = redactedPlaceholder
		default:
			switch nested := v.(type) {
			case map[string]any:
				out[k] = redactMap(nested)
			case error:
				out[k] = serializeError(nested)
			default:
				out[k] = v
			}
		}
	}
	return out
}

// causeMaxDepth mirrors the TS CAUSE_MAX_DEPTH guard against circular
// cause chains.
const causeMaxDepth = 5

// serializedError mirrors the TS SerializedError shape. Go errors carry no
// stack trace and no enumerable extra fields, so those TS members are
// omitted.
type serializedError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Cause   any    `json:"cause,omitempty"`
}

// serializeError recursively serializes an error including its Unwrap
// chain, bounded by causeMaxDepth. Port of the TS errSerializer for the
// Error-instance branch.
func serializeError(err error) serializedError {
	out := serializedError{
		Type:    reflect.TypeOf(err).String(),
		Message: err.Error(),
	}
	if cause := errors.Unwrap(err); cause != nil {
		out.Cause = serializeErrorDepth(cause, 1)
	}
	return out
}

func serializeErrorDepth(err error, depth int) serializedError {
	out := serializedError{
		Type:    reflect.TypeOf(err).String(),
		Message: err.Error(),
	}
	if depth < causeMaxDepth {
		if cause := errors.Unwrap(err); cause != nil {
			out.Cause = serializeErrorDepth(cause, depth+1)
		}
	}
	return out
}
