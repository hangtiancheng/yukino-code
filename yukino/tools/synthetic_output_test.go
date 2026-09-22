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

package tools

import (
	"context"
	"strings"
	"testing"
)

// TS validateSchema reports JS typeof names, with the isArray special cases
// (synthetic-output.ts:108-126): null is "object", arrays print as "array"
// for the object/string expectations.
func TestSyntheticOutputValidateSchemaWording(t *testing.T) {
	cases := []struct {
		schema map[string]any
		data   any
		want   string
	}{
		{map[string]any{"type": "object"}, "s", "Output does not match required schema: Expected object, got string"},
		{map[string]any{"type": "object"}, []any{1}, "Output does not match required schema: Expected object, got array"},
		{map[string]any{"type": "object"}, nil, "Output does not match required schema: Expected object, got object"},
		{map[string]any{"type": "object"}, float64(2), "Output does not match required schema: Expected object, got number"},
		{map[string]any{"type": "object"}, true, "Output does not match required schema: Expected object, got boolean"},
		{map[string]any{"type": "array"}, map[string]any{}, "Output does not match required schema: Expected array, got object"},
		{map[string]any{"type": "array"}, nil, "Output does not match required schema: Expected array, got object"},
		{map[string]any{"type": "string"}, []any{}, "Output does not match required schema: Expected string, got array"},
		{map[string]any{"type": "string"}, float64(1), "Output does not match required schema: Expected string, got number"},
	}
	tool := &SyntheticOutputTool{}
	for _, c := range cases {
		tool.JSONSchema = c.schema
		res := tool.Execute(context.Background(), map[string]any{"output": c.data})
		if !res.IsError || res.Output != c.want {
			t.Errorf("schema %v data %#v: got %q (isError=%v), want %q", c.schema, c.data, res.Output, res.IsError, c.want)
		}
	}
}

// TS: required.filter(k => typeof k === "string" && !(k in data)) — works on
// any array shape and keeps empty-string keys.
func TestSyntheticOutputRequiredFields(t *testing.T) {
	tool := &SyntheticOutputTool{JSONSchema: map[string]any{
		"type":     "object",
		"required": []string{"b", "a"},
	}}
	res := tool.Execute(context.Background(), map[string]any{"output": map[string]any{"a": 1}})
	if !res.IsError || res.Output != "Output does not match required schema: Missing required fields: b" {
		t.Errorf("[]string required: got %q", res.Output)
	}

	tool.JSONSchema = map[string]any{"required": []any{"x", 3, "y"}}
	res = tool.Execute(context.Background(), map[string]any{"output": map[string]any{"y": 1}})
	if !res.IsError || res.Output != "Output does not match required schema: Missing required fields: x" {
		t.Errorf("[]any required with non-string entry: got %q", res.Output)
	}
}

// JSON.stringify does not HTML-escape; json.Marshal's default does.
func TestSyntheticOutputNoHTMLEscaping(t *testing.T) {
	tool := &SyntheticOutputTool{}
	res := tool.Execute(context.Background(), map[string]any{
		"output": map[string]any{"html": "<b>a & b</b>"},
	})
	if res.IsError {
		t.Fatalf("unexpected error: %s", res.Output)
	}
	if !strings.Contains(res.Output, `"<b>a & b</b>"`) {
		t.Errorf("output must not HTML-escape, got:\n%s", res.Output)
	}
	if strings.Contains(res.Output, `\u003c`) {
		t.Errorf("output contains escaped HTML:\n%s", res.Output)
	}
}

func TestSyntheticOutputBasics(t *testing.T) {
	tool := &SyntheticOutputTool{}
	res := tool.Execute(context.Background(), map[string]any{})
	if !res.IsError || res.Output != "Error: output is required" {
		t.Errorf("missing output: %#v", res)
	}
	res = tool.Execute(context.Background(), map[string]any{"output": "plain"})
	if res.IsError || res.Output != "plain" {
		t.Errorf("strings pass through unwrapped: %#v", res)
	}
	res = tool.Execute(context.Background(), map[string]any{"output": map[string]any{"a": float64(1)}})
	if res.IsError || res.Output != "{\n  \"a\": 1\n}" {
		t.Errorf("two-space indent expected, got %q", res.Output)
	}
}
