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

package utils

import (
	"errors"
	"strings"
	"testing"
)

func TestContentToText(t *testing.T) {
	tests := []struct {
		name    string
		content any
		want    string
	}{
		{"string passthrough", "hello", "hello"},
		{"empty string", "", ""},
		{"nil", nil, ""},
		{
			"text blocks joined with newline",
			[]map[string]any{
				{"type": "text", "text": "first"},
				{"type": "text", "text": "second"},
			},
			"first\nsecond",
		},
		{
			"text block without string text is skipped",
			[]map[string]any{{"type": "text", "text": 42}},
			"",
		},
		{
			"image base64 uses media_type",
			[]map[string]any{{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png"}}},
			"[Image: image/png]",
		},
		{
			"image base64 without media_type falls back to image",
			[]map[string]any{{"type": "image", "source": map[string]any{"type": "base64"}}},
			"[Image: image]",
		},
		{
			"image non-base64 source uses image",
			[]map[string]any{{"type": "image", "source": map[string]any{"type": "url"}}},
			"[Image: image]",
		},
		{
			"image without record source is skipped",
			[]map[string]any{{"type": "image", "source": "bogus"}},
			"",
		},
		{
			"tool reference",
			[]map[string]any{{"type": "tool_reference", "tool_name": "ReadFile"}},
			"[Tool reference: ReadFile]",
		},
		{
			"tool reference without name is skipped",
			[]map[string]any{{"type": "tool_reference"}},
			"",
		},
		{
			"search result with title source and nested content",
			[]map[string]any{{
				"type": "search_result", "title": "Docs", "source": "https://example.com",
				"content": []any{map[string]any{"type": "text", "text": "body"}},
			}},
			"Docs (https://example.com)\nbody",
		},
		{
			"search result defaults",
			[]map[string]any{{"type": "search_result"}},
			"search result",
		},
		{
			"document with and without title",
			[]map[string]any{
				{"type": "document", "title": "spec.pdf"},
				{"type": "document"},
			},
			"[Document: spec.pdf]\n[Document: document]",
		},
		{
			"unknown block types are skipped",
			[]map[string]any{
				{"type": "mystery"},
				{"type": "text", "text": "kept"},
			},
			"kept",
		},
		{
			"any slice drops non-record elements",
			[]any{"junk", map[string]any{"type": "text", "text": "kept"}, 7},
			"kept",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ContentToText(tt.content); got != tt.want {
				t.Errorf("ContentToText() = %q, want %q", got, tt.want)
			}
		})
	}
}

// typedBlock exercises the JSON round-trip path for concrete block slices.
type typedBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

func TestContentToTextTypedSlice(t *testing.T) {
	blocks := []typedBlock{
		{Type: "text", Text: "from struct"},
		{Type: "unknown"},
	}
	if got, want := ContentToText(blocks), "from struct"; got != want {
		t.Errorf("ContentToText(typed slice) = %q, want %q", got, want)
	}
}

func TestIsRecordAndIsObject(t *testing.T) {
	tests := []struct {
		value      any
		wantRecord bool
		wantObject bool
	}{
		{map[string]any{"a": 1}, true, true},
		{[]any{1}, false, true},
		{[]string{"x"}, false, true},
		{"s", false, false},
		{3, false, false},
		{nil, false, false},
	}
	for _, tt := range tests {
		if got := IsRecord(tt.value); got != tt.wantRecord {
			t.Errorf("IsRecord(%v) = %v, want %v", tt.value, got, tt.wantRecord)
		}
		if got := IsObject(tt.value); got != tt.wantObject {
			t.Errorf("IsObject(%v) = %v, want %v", tt.value, got, tt.wantObject)
		}
	}
}

func TestAsRecord(t *testing.T) {
	m := map[string]any{"k": "v"}
	if got := AsRecord(m); got["k"] != "v" {
		t.Errorf("AsRecord(map) lost keys: %v", got)
	}
	got := AsRecord([]any{"a", "b"})
	if got["0"] != "a" || got["1"] != "b" || len(got) != 2 {
		t.Errorf("AsRecord(slice) = %v, want index-keyed map", got)
	}
	if got := AsRecord("scalar"); len(got) != 0 {
		t.Errorf("AsRecord(scalar) = %v, want empty map", got)
	}
}

func TestAsStringAndErrorString(t *testing.T) {
	tests := []struct {
		value      any
		wantString string
		wantErrStr string
	}{
		{"plain", "plain", "plain"},
		{nil, "null", "null"},
		{42, "42", "42"},
		{true, "true", "true"},
		{errors.New("boom"), "Error: boom", "boom"},
	}
	for _, tt := range tests {
		if got := AsString(tt.value); got != tt.wantString {
			t.Errorf("AsString(%v) = %q, want %q", tt.value, got, tt.wantString)
		}
		if got := AsErrorString(tt.value); got != tt.wantErrStr {
			t.Errorf("AsErrorString(%v) = %q, want %q", tt.value, got, tt.wantErrStr)
		}
	}
}

func TestAsError(t *testing.T) {
	orig := errors.New("kept")
	if got := AsError(orig); got != orig {
		t.Errorf("AsError(error) should pass through, got %v", got)
	}
	if got := AsError("wrapped"); got.Error() != "wrapped" {
		t.Errorf("AsError(string) = %q, want %q", got.Error(), "wrapped")
	}
}

func TestSafeJSONParse(t *testing.T) {
	tests := []struct {
		raw    string
		wantOK bool
	}{
		{`{"a":1}`, true},
		{`[1,2]`, true},
		{`"str"`, true},
		{`null`, true},
		{`not json`, false},
		{`{"a":`, false},
	}
	for _, tt := range tests {
		v, ok := SafeJSONParse(tt.raw)
		if ok != tt.wantOK {
			t.Errorf("SafeJSONParse(%q) ok = %v, want %v", tt.raw, ok, tt.wantOK)
		}
		if !tt.wantOK && v != nil {
			t.Errorf("SafeJSONParse(%q) value = %v, want nil on failure", tt.raw, v)
		}
	}
	if v, ok := SafeJSONParse(`{"a":1}`); !ok || v.(map[string]any)["a"] != float64(1) {
		t.Errorf("SafeJSONParse object decode wrong: %v", v)
	}
}

func TestIntArg(t *testing.T) {
	args := map[string]any{
		"float":   3.9,
		"neg":     -2.5,
		"int":     7,
		"str":     "42",
		"prefix":  "12abc",
		"bad":     "abc",
		"boolish": true,
	}
	tests := []struct {
		key      string
		fallback int
		want     int
	}{
		{"float", 0, 3},     // Math.floor
		{"neg", 0, -3},      // floor, not truncation
		{"int", 0, 7},       //
		{"str", 0, 42},      //
		{"prefix", 0, 12},   // parseInt leading digits
		{"bad", 5, 5},       // NaN -> fallback
		{"boolish", 9, 9},   // non number/string -> fallback
		{"missing", 11, 11}, //
	}
	for _, tt := range tests {
		if got := IntArg(args, tt.key, tt.fallback); got != tt.want {
			t.Errorf("IntArg(%q, %d) = %d, want %d", tt.key, tt.fallback, got, tt.want)
		}
	}
}

func TestStrArg(t *testing.T) {
	args := map[string]any{"s": "v", "n": 3, "empty": ""}
	if got := StrArg(args, "s"); got != "v" {
		t.Errorf("StrArg hit = %q", got)
	}
	if got := StrArg(args, "n", "fb"); got != "fb" {
		t.Errorf("StrArg non-string with fallback = %q, want fb", got)
	}
	if got := StrArg(args, "missing"); got != "" {
		t.Errorf("StrArg missing = %q, want empty", got)
	}
	if got := StrArg(args, "missing", "fb"); got != "fb" {
		t.Errorf("StrArg missing with fallback = %q, want fb", got)
	}
	if got := StrArg(args, "empty", "fb"); got != "" {
		t.Errorf("StrArg empty string should not fall back, got %q", got)
	}
}

func TestStrList(t *testing.T) {
	if got := StrList([]any{"a", 1, "b"}); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("StrList([]any) = %v", got)
	}
	if got := StrList([]string{"x"}); len(got) != 1 || got[0] != "x" {
		t.Errorf("StrList([]string) = %v", got)
	}
	if got := StrList("nope"); len(got) != 0 {
		t.Errorf("StrList(non-list) = %v, want empty", got)
	}
}

func TestBoolArg(t *testing.T) {
	args := map[string]any{
		"t": true, "f": false,
		"str":   "false", // truthy in JS
		"empty": "", "zero": 0.0, "num": 2.0,
	}
	tests := []struct {
		key      string
		fallback []bool
		want     bool
	}{
		{"t", nil, true},
		{"f", nil, false},
		{"f", []bool{true}, false}, // explicit bool beats fallback
		{"str", nil, true},         // Boolean("false") === true
		{"empty", nil, false},
		{"zero", nil, false},
		{"num", nil, true},
		{"missing", nil, false},
		{"missing", []bool{true}, true},
		{"str", []bool{false}, false}, // non-bool value -> fallback
	}
	for _, tt := range tests {
		if got := BoolArg(args, tt.key, tt.fallback...); got != tt.want {
			t.Errorf("BoolArg(%q, %v) = %v, want %v", tt.key, tt.fallback, got, tt.want)
		}
	}
}

func TestFormatToolArgs(t *testing.T) {
	long := strings.Repeat("x", 100)
	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"command wins", map[string]any{"command": "ls -la", "file_path": "/x"}, "ls -la"},
		{"file_path next", map[string]any{"file_path": "/x/y"}, "/x/y"},
		{"pattern next", map[string]any{"pattern": "foo.*"}, "foo.*"},
		{"description last", map[string]any{"description": "does things"}, "does things"},
		{"empty args", map[string]any{}, ""},
		{"empty command falls through", map[string]any{"command": "", "file_path": "/x"}, "/x"},
		{"truncates at 80 with ellipsis", map[string]any{"command": long}, strings.Repeat("x", 80) + "…"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FormatToolArgs(tt.args); got != tt.want {
				t.Errorf("FormatToolArgs() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("short", 80); got != "short" {
		t.Errorf("truncate short = %q", got)
	}
	if got := truncate(strings.Repeat("a", 81), 80); got != strings.Repeat("a", 80)+"…" {
		t.Errorf("truncate long = %q", got)
	}
	// rune-based cut: 3 CJK runes, cut at 2
	if got := truncate("日本語", 2); got != "日本…" {
		t.Errorf("truncate runes = %q, want 日本…", got)
	}
}
