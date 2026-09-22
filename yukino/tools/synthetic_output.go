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
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// SyntheticOutputTool lets the Agent deliver its final result as structured
// data. In non-interactive and coordinator modes, callers expect directly
// parseable JSON rather than prose embedded in natural language.
type SyntheticOutputTool struct {
	// JSONSchema is optional. When set, the output is validated against the
	// structure agreed upon with the caller.
	JSONSchema map[string]any
}

func (t *SyntheticOutputTool) Name() string           { return "SyntheticOutput" }
func (t *SyntheticOutputTool) Category() ToolCategory { return CategoryRead }

func (t *SyntheticOutputTool) Description() string {
	return "Return structured output in JSON format. Use this tool to return your final response " +
		"as structured data in non-interactive or coordinator mode sessions."
}

func (t *SyntheticOutputTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"output": map[string]any{
					"description": "The structured result: an object, an array, or a plain string",
				},
			},
			"required": []string{"output"},
		},
	}
}

func (t *SyntheticOutputTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	output, ok := args["output"]
	if !ok {
		return ToolResult{Output: "Error: output is required", IsError: true}
	}

	if err := t.validateSchema(output); err != "" {
		return ToolResult{
			Output:  fmt.Sprintf("Output does not match required schema: %s", err),
			IsError: true,
		}
	}

	// Strings are returned as-is without a secondary JSON wrapping.
	if s, isString := output.(string); isString {
		return ToolResult{Output: s}
	}

	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	// JSON.stringify does not escape <, > or &; the default Go encoder does.
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(output); err != nil {
		return ToolResult{
			Output:  fmt.Sprintf("Error: output is not serializable: %s", err),
			IsError: true,
		}
	}
	return ToolResult{Output: strings.TrimSuffix(buf.String(), "\n")}
}

// jsTypeOf mirrors the JS typeof operator for JSON-decoded values: null
// reports "object", arrays report "object" (callers special-case them like
// the TS isArray checks), numbers cover every Go numeric decoding.
func jsTypeOf(v any) string {
	switch v.(type) {
	case nil:
		return "object"
	case bool:
		return "boolean"
	case string:
		return "string"
	case float64, float32, int, int64, json.Number:
		return "number"
	}
	return "object"
}

// validateSchema covers only top-level type and required fields; an empty
// string return means validation passed. Full JSON Schema validation is
// unnecessary here — this guards against obviously malformed delivery
// structures from the model.
func (t *SyntheticOutputTool) validateSchema(data any) string {
	if t.JSONSchema == nil {
		return ""
	}

	if expected, ok := t.JSONSchema["type"].(string); ok {
		_, isArray := data.([]any)
		switch expected {
		case "object":
			if _, isMap := data.(map[string]any); !isMap {
				if isArray {
					return "Expected object, got array"
				}
				return "Expected object, got " + jsTypeOf(data)
			}
		case "array":
			if !isArray {
				return "Expected array, got " + jsTypeOf(data)
			}
		case "string":
			if _, isString := data.(string); !isString {
				if isArray {
					return "Expected string, got array"
				}
				return "Expected string, got " + jsTypeOf(data)
			}
		}
	}

	// TS: Array.isArray(required) — accept both decoded ([]any) and natively
	// built ([]string) schemas; non-string entries are dropped, empty-string
	// keys are kept like TS `typeof k === "string"`.
	var requiredKeys []string
	switch required := t.JSONSchema["required"].(type) {
	case []any:
		for _, key := range required {
			if name, ok := key.(string); ok {
				requiredKeys = append(requiredKeys, name)
			}
		}
	case []string:
		requiredKeys = append(requiredKeys, required...)
	}
	if obj, isObj := data.(map[string]any); len(requiredKeys) > 0 && isObj {
		var missing []string
		for _, name := range requiredKeys {
			if _, present := obj[name]; !present {
				missing = append(missing, name)
			}
		}
		if len(missing) > 0 {
			return "Missing required fields: " + strings.Join(missing, ", ")
		}
	}

	return ""
}
