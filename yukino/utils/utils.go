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

// Package utils provides the small shared helpers of the yukino port:
// content-block flattening, defensive type coercions and tool-argument
// extraction. It is a port of src/utils/index.ts from the TypeScript
// reference implementation.
package utils

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"unicode"
)

// RatFixed1 renders a non-negative rational with exactly one decimal digit,
// rounding an exact .X5 tie UP — ECMA-262 `toFixed(1)` picks the larger n on
// an exact tie, whereas Go's `%.1f` rounds half-to-even. The tenths value is
// computed in rational arithmetic so no float rounding intervenes (used by
// the size formatters in memory and images).
func RatFixed1(r *big.Rat) string {
	r = new(big.Rat).Mul(r, big.NewRat(10, 1))
	r.Add(r, big.NewRat(1, 2))
	tenths := new(big.Int).Quo(r.Num(), r.Denom()).Int64()
	return fmt.Sprintf("%d.%d", tenths/10, tenths%10)
}

// JSNumberString renders a float the way JS `String(number)` does (ECMA-262
// Number::toString): "NaN"/"Infinity"/"-Infinity", "0", fixed notation inside
// [1e-6, 1e21), exponential notation with a signed exponent otherwise.
func JSNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	abs := math.Abs(f)
	if abs < 1e-6 || abs >= 1e21 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		// Go emits "1e-07"/"1e+21"; JS emits "1e-7"/"1e+21".
		if mantissa, exp, ok := strings.Cut(s, "e"); ok {
			sign := "+"
			if exp[0] == '-' {
				sign = "-"
				exp = exp[1:]
			} else if exp[0] == '+' {
				exp = exp[1:]
			}
			if n, err := strconv.Atoi(exp); err == nil {
				return mantissa + "e" + sign + strconv.Itoa(n)
			}
		}
		return s
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// ContentToText converts message content — a plain string or a slice of
// content blocks — to a base64-free text fallback. Recognized block types
// mirror the TS original: text, image, tool_reference, search_result and
// document; anything else is skipped.
//
// The parameter is any (rather than a conversation type) to keep this
// package dependency-free. Accepted shapes: string, []map[string]any,
// []any holding records, or any other slice of JSON-tagged block structs
// (normalized via a JSON round-trip).
func ContentToText(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	blocks := blocksFromAny(content)
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if text, ok := blockText(block); ok {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

// blocksFromAny normalizes content to a slice of records. Non-record
// elements are dropped (TS filters them via isRecord); unrecognized shapes
// yield nil.
func blocksFromAny(content any) []map[string]any {
	switch v := content.(type) {
	case []map[string]any:
		return v
	case []any:
		blocks := make([]map[string]any, 0, len(v))
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				blocks = append(blocks, m)
			}
		}
		return blocks
	default:
		// Typed block slices (e.g. structs with json tags): normalize via
		// a JSON round-trip.
		raw, err := json.Marshal(content)
		if err != nil {
			return nil
		}
		var blocks []map[string]any
		if err := json.Unmarshal(raw, &blocks); err != nil {
			return nil
		}
		return blocks
	}
}

// blockText renders a single content block, reporting whether it produced
// any text at all.
func blockText(block map[string]any) (string, bool) {
	switch block["type"] {
	case "text":
		text, ok := block["text"].(string)
		return text, ok
	case "image":
		source, ok := block["source"].(map[string]any)
		if !ok {
			return "", false
		}
		mediaType := "image"
		if source["type"] == "base64" {
			if mt, ok := source["media_type"].(string); ok {
				mediaType = mt
			}
		}
		return "[Image: " + mediaType + "]", true
	case "tool_reference":
		name, ok := block["tool_name"].(string)
		if !ok {
			return "", false
		}
		return "[Tool reference: " + name + "]", true
	case "search_result":
		title := "search result"
		if t, ok := block["title"].(string); ok {
			title = t
		}
		source := ""
		if s, ok := block["source"].(string); ok {
			source = " (" + s + ")"
		}
		nested := ""
		switch c := block["content"].(type) {
		case []any:
			nested = ContentToText(c)
		case []map[string]any:
			nested = ContentToText(c)
		}
		if nested != "" {
			return title + source + "\n" + nested, true
		}
		return title + source, true
	case "document":
		title := "document"
		if t, ok := block["title"].(string); ok {
			title = t
		}
		return "[Document: " + title + "]", true
	}
	return "", false
}

// IsRecord reports whether value is a JSON object (map[string]any). Port of
// isRecord: typeof value === "object" && value !== null && !Array.isArray(value).
func IsRecord(value any) bool {
	_, ok := value.(map[string]any)
	return ok
}

// AsRecord coerces value to a map: records pass through, slices become
// index-keyed maps (mirrors Object.fromEntries(value.entries())), anything
// else yields an empty map.
func AsRecord(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	if list, ok := value.([]any); ok {
		m := make(map[string]any, len(list))
		for i, v := range list {
			m[strconv.Itoa(i)] = v
		}
		return m
	}
	return map[string]any{}
}

// AsString returns value as a string: strings pass through, nil becomes
// "null" (TS String(null); Go's nil cannot distinguish JSON null from
// undefined), errors stringify like JS Error instances ("Error: <message>"),
// and everything else is formatted with %v (the Go analogue of String(value)).
func AsString(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	if value == nil {
		return "null"
	}
	if err, ok := value.(error); ok {
		return "Error: " + err.Error()
	}
	return fmt.Sprint(value)
}

// AsErrorString extracts a message: errors yield err.Error(), everything
// else falls back to AsString.
func AsErrorString(value any) string {
	if err, ok := value.(error); ok {
		return err.Error()
	}
	return AsString(value)
}

// IsObject reports whether value is object-like (a non-nil map, slice or
// array). Go has no single "object" notion, so this widens the TS check
// (typeof value === "object" && value !== null) to both container kinds.
func IsObject(value any) bool {
	if value == nil {
		return false
	}
	switch reflect.ValueOf(value).Kind() {
	case reflect.Map, reflect.Slice, reflect.Array:
		return true
	}
	return false
}

// SafeJSONParse parses raw as JSON and never fails: invalid input returns
// (nil, false). Port of safeJSONParse = toTry(JSON.parse).
func SafeJSONParse(raw string) (any, bool) {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return nil, false
	}
	return v, true
}

// AsError normalizes value to an error: errors pass through, anything else
// is wrapped with its AsString representation.
func AsError(value any) error {
	if err, ok := value.(error); ok {
		return err
	}
	return errors.New(AsString(value))
}

// IntArg extracts an integer argument: numbers are floored, strings are
// parsed by their leading decimal digits (JS parseInt semantics), anything
// else falls back.
func IntArg(args map[string]any, key string, fallback int) int {
	switch v := args[key].(type) {
	case float64:
		return int(math.Floor(v))
	case float32:
		return int(math.Floor(float64(v)))
	case int:
		return v
	case int64:
		return int(v)
	case string:
		if n, ok := parseIntPrefix(v); ok {
			return n
		}
	}
	return fallback
}

// parseIntPrefix mirrors Number.parseInt(v, 10): optional sign followed by
// the longest run of decimal digits, so "12abc" parses as 12. Leading
// whitespace is trimmed per the JS WhiteSpace/LineTerminator grammar, which
// unicode.IsSpace covers (ASCII whitespace plus NBSP and the Unicode space
// separators).
func parseIntPrefix(s string) (int, bool) {
	s = strings.TrimLeftFunc(s, func(r rune) bool { return unicode.IsSpace(r) })
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

// StrList filters the string elements out of a raw list value; non-lists
// yield an empty slice.
func StrList(raw any) []string {
	switch v := raw.(type) {
	case []string:
		out := make([]string, len(v))
		copy(out, v)
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return []string{}
}

// StrArg extracts a string argument; missing or non-string values fall back
// to the optional fallback (default "").
func StrArg(args map[string]any, key string, fallback ...string) string {
	if s, ok := args[key].(string); ok {
		return s
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return ""
}

// BoolArg extracts a boolean argument. When the stored value is not a bool
// and no fallback is given, JS truthiness applies (Boolean(v)).
func BoolArg(args map[string]any, key string, fallback ...bool) bool {
	if b, ok := args[key].(bool); ok {
		return b
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return isTruthy(args[key])
}

// isTruthy applies JavaScript truthiness: nil, false, 0, "" and NaN are
// falsy; everything else (including "false" and empty containers) is truthy.
func isTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0 && !math.IsNaN(v)
	case float32:
		return v != 0 && !math.IsNaN(float64(v))
	case int:
		return v != 0
	case int64:
		return v != 0
	}
	return true
}

// FormatToolArgs renders a one-line summary of tool arguments for spinners
// and status displays, preferring the most descriptive known key.
func FormatToolArgs(args map[string]any) string {
	for _, key := range []string{"command", "file_path", "pattern", "description"} {
		if isTruthy(args[key]) {
			return truncate(StrArg(args, key), 80)
		}
	}
	return ""
}

// truncate shortens value to max UTF-16 code units, appending an ellipsis
// when cut. JS strings are UTF-16, so a JS `.length`/`slice` counts one unit
// per BMP character and two per astral character; rune counting differs for
// emoji and rare CJK. The cut never splits a character.
func truncate(value string, max int) string {
	if UTF16Len(value) <= max {
		return value
	}
	return TruncateUTF16(value, max) + "…"
}

// UTF16Len returns the number of UTF-16 code units in s, matching JavaScript
// String.length: characters outside the BMP count as two units (a surrogate
// pair). Byte lengths overcount CJK content ~3x, which is why every
// TS-derived length check should use this instead.
func UTF16Len(s string) int {
	units := 0
	for _, r := range s {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

// TruncateUTF16 returns the longest prefix of s whose UTF-16 length does not
// exceed max. The cut never splits a character: if the next rune would cross
// the limit it is dropped entirely. TS's slice(0, max) can split a surrogate
// pair; this port deliberately keeps the output valid UTF-8 (see cr.md §11.7).
func TruncateUTF16(s string, max int) string {
	if max <= 0 {
		return ""
	}
	units := 0
	for i, r := range s {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width > max {
			return s[:i]
		}
		units += width
	}
	return s
}
