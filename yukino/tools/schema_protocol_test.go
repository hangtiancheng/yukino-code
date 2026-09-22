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
	"testing"
)

type shapeTool struct{ n string }

func (t *shapeTool) Name() string           { return t.n }
func (t *shapeTool) Description() string    { return t.n + " does things" }
func (t *shapeTool) Category() ToolCategory { return CategoryRead }
func (t *shapeTool) Schema() map[string]any {
	return map[string]any{
		"name":         t.n,
		"description":  t.n + " does things",
		"input_schema": map[string]any{"type": "object"},
	}
}
func (t *shapeTool) Execute(context.Context, map[string]any) ToolResult {
	return ToolResult{Output: "ok"}
}

// GetAllSchemas must emit the per-protocol shapes that the LLM clients expect
// (mirrors TS registry.getAllSchemas, registry.ts:129-153). Flattening both
// OpenAI protocols made every openai-compat turn fail in toOpenAICompatTools
// with "tool schema serialized for another protocol"; this pins the shapes so
// the regression cannot return.
func TestGetAllSchemasProtocolShapes(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&shapeTool{n: "Shape"})

	t.Run("anthropic keeps the input_schema base shape", func(t *testing.T) {
		schemas := reg.GetAllSchemas("anthropic")
		if len(schemas) != 1 {
			t.Fatalf("want 1 schema, got %d", len(schemas))
		}
		s := schemas[0]
		if _, ok := s["input_schema"].(map[string]any); !ok {
			t.Errorf("anthropic schema must carry input_schema, got %v", s)
		}
		if _, hasFn := s["function"]; hasFn {
			t.Errorf("anthropic schema must not nest under function, got %v", s)
		}
	})

	t.Run("openai (Responses) is a flat function tool with strict", func(t *testing.T) {
		schemas := reg.GetAllSchemas("openai")
		if len(schemas) != 1 {
			t.Fatalf("want 1 schema, got %d", len(schemas))
		}
		s := schemas[0]
		if got, _ := s["type"].(string); got != "function" {
			t.Errorf(`openai schema type = %q, want "function"`, got)
		}
		if _, ok := s["parameters"].(map[string]any); !ok {
			t.Errorf("openai schema must carry top-level parameters, got %v", s)
		}
		if _, hasStrict := s["strict"]; !hasStrict {
			t.Errorf("openai schema must carry strict (TS sends strict:false), got %v", s)
		}
		if _, hasFn := s["function"]; hasFn {
			t.Errorf("openai schema must not nest under function, got %v", s)
		}
	})

	t.Run("openai-compat nests the definition under function", func(t *testing.T) {
		schemas := reg.GetAllSchemas("openai-compat")
		if len(schemas) != 1 {
			t.Fatalf("want 1 schema, got %d", len(schemas))
		}
		s := schemas[0]
		if got, _ := s["type"].(string); got != "function" {
			t.Errorf(`openai-compat schema type = %q, want "function"`, got)
		}
		fn, ok := s["function"].(map[string]any)
		if !ok {
			t.Fatalf("openai-compat schema must nest under function (Chat Completions shape), got %v", s)
		}
		if got, _ := fn["name"].(string); got != "Shape" {
			t.Errorf("function.name = %q, want %q", got, "Shape")
		}
		if _, ok := fn["parameters"].(map[string]any); !ok {
			t.Errorf("function must carry parameters, got %v", fn)
		}
		if _, hasStrict := fn["strict"]; !hasStrict {
			t.Errorf("function must carry strict (TS sends strict:false), got %v", fn)
		}
		if _, hasTopParams := s["parameters"]; hasTopParams {
			t.Errorf("openai-compat schema must not carry top-level parameters, got %v", s)
		}
	})
}
