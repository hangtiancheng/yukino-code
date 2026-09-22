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
	"sort"
	"strings"
)

type ToolSearchTool struct {
	Registry *Registry
	Protocol string
}

func (t *ToolSearchTool) Name() string { return ToolSearchToolName }

func (t *ToolSearchTool) Description() string {
	return "Search for and load deferred tools by name or keyword."
}

func (t *ToolSearchTool) Category() ToolCategory { return CategoryRead }

func (t *ToolSearchTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{
					"type":        "string",
					"description": `Search query. Use "select:name1,name2" to load specific tools by name, or keywords to search.`,
				},
				"max_results": map[string]any{
					"type":        "integer",
					"description": "Max results to return",
					"default":     5,
				},
			},
			"required": []string{"query"},
		},
	}
}

func (t *ToolSearchTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	query, _ := args["query"].(string)
	if query == "" {
		return ToolResult{Output: "Error: query is required", IsError: true}
	}

	// Clamp to [1, 50], like the TS Math.max(1, Math.min(maxResults, 50)).
	maxResults := intArg(args, "max_results", 5)
	if maxResults < 1 {
		maxResults = 1
	}
	if maxResults > 50 {
		maxResults = 50
	}

	var schemas []map[string]any

	if after, ok := strings.CutPrefix(query, "select:"); ok {
		names := strings.Split(after, ",")
		trimmed := make([]string, 0, len(names))
		for _, name := range names {
			if name = strings.TrimSpace(name); name != "" {
				trimmed = append(trimmed, name)
			}
		}
		schemas = t.Registry.FindDeferredByNames(trimmed, t.Protocol)
	} else {
		schemas = t.Registry.SearchDeferred(query, maxResults, t.Protocol)
	}

	if len(schemas) == 0 {
		return ToolResult{Output: "No deferred tools matched the query."}
	}

	// TS ToolSearch always works with tool.schema() — the base
	// {name, description, input_schema} shape — whatever the client protocol
	// (tool-search.ts:113-115); the Go registry returns protocol-transformed
	// schemas, so normalize back before splitting and printing.
	base := make([]map[string]any, len(schemas))
	for i, s := range schemas {
		base[i] = baseSchemaForOutput(s)
	}

	// Split by MCP prefix: local deferred tools become visible in the next
	// round's tools[]; MCP tools stay deferred and are referenced instead.
	var mcpTools []map[string]any
	var localTools []map[string]any
	var allNames []string
	for _, s := range base {
		name, ok := s["name"].(string)
		if !ok {
			continue
		}
		allNames = append(allNames, name)
		if strings.HasPrefix(name, MCPToolPrefix) {
			mcpTools = append(mcpTools, s)
		} else {
			localTools = append(localTools, s)
		}
	}
	for _, s := range localTools {
		if name, ok := s["name"].(string); ok {
			t.Registry.MarkDiscovered(name)
		}
	}

	native := t.Registry.McpLoadingMode == McpLoadingNative
	// Native: only local schemas travel in text; the MCP schemas are expanded
	// server-side from the tool_reference blocks. Otherwise every schema is
	// shown so the model can route through McpCall.
	schemaSource := base
	if native {
		schemaSource = localTools
	}
	schemaParts := make([]string, 0, len(schemaSource))
	for _, s := range schemaSource {
		encoded, err := encodeSchemaJSON(s)
		if err != nil {
			continue
		}
		schemaParts = append(schemaParts, encoded)
	}

	routing := ""
	if len(mcpTools) > 0 {
		if t.Registry.McpLoadingMode == McpLoadingDispatch {
			routing = "\n\nInvoke MCP tools through McpCall with the server name, full tool name, and an arguments object matching the target input_schema, including JSON types."
		} else {
			routing = "\n\nThese MCP tools can be called directly by their full names."
		}
	}

	parts := append([]string{fmt.Sprintf("Loaded %d tool(s): %s.", len(base), strings.Join(allNames, ", "))}, schemaParts...)
	output := strings.Join(parts, "\n\n") + routing

	if native && len(mcpTools) > 0 {
		// The text block carries the local schemas; the tool_reference blocks
		// tell the official endpoint to expand the MCP schemas into context.
		blocks := make([]map[string]any, 0, len(mcpTools)+1)
		blocks = append(blocks, map[string]any{"type": "text", "text": output})
		for _, s := range mcpTools {
			name, _ := s["name"].(string)
			blocks = append(blocks, map[string]any{"type": "tool_reference", "tool_name": name})
		}
		return ToolResult{Output: output, ContentBlocks: blocks}
	}

	return ToolResult{Output: output}
}

// baseSchemaForOutput undoes the registry's protocol transform so the printed
// schema always has the base {name, description, input_schema} shape that TS
// tool.schema() returns. Shape-detected, so it is a no-op once the registry
// hands back base schemas.
func baseSchemaForOutput(s map[string]any) map[string]any {
	if _, ok := s["input_schema"]; ok {
		return s
	}
	if fn, ok := s["function"].(map[string]any); ok { // openai-compat shape
		return map[string]any{"name": fn["name"], "description": fn["description"], "input_schema": fn["parameters"]}
	}
	if params, ok := s["parameters"]; ok { // openai Responses shape
		return map[string]any{"name": s["name"], "description": s["description"], "input_schema": params}
	}
	return s
}

// schemaKeyOrder lists schema keys in the order TS tool literals write them.
// JSON.stringify preserves that insertion order; Go map encoding sorts
// alphabetically, which would print "description" before "name". Keys outside
// this list are appended in sorted order for determinism.
var schemaKeyOrder = []string{
	"name", "description", "input_schema",
	"type", "properties", "required", "items", "default",
	"enum", "minItems", "maxItems", "minimum", "maximum",
	"additionalProperties",
}

// encodeSchemaJSON renders a schema like JSON.stringify(schema, null, 2):
// two-space indent, no HTML escaping, TS-literal key order.
func encodeSchemaJSON(v any) (string, error) {
	var buf bytes.Buffer
	if err := writeSchemaJSON(&buf, v, 0, false); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func writeSchemaJSON(buf *bytes.Buffer, v any, indent int, propsMap bool) error {
	switch val := v.(type) {
	case map[string]any:
		keys := schemaKeysFor(val, propsMap)
		if len(keys) == 0 {
			buf.WriteString("{}")
			return nil
		}
		buf.WriteString("{\n")
		for i, k := range keys {
			writeSchemaIndent(buf, indent+1)
			keyJSON, err := json.Marshal(k)
			if err != nil {
				return err
			}
			buf.Write(keyJSON)
			buf.WriteString(": ")
			// The value of "properties" is a map keyed by property names, not
			// a schema object: sort its keys; the property schemas below it
			// get the priority order again.
			if err := writeSchemaJSON(buf, val[k], indent+1, k == "properties"); err != nil {
				return err
			}
			if i < len(keys)-1 {
				buf.WriteString(",")
			}
			buf.WriteString("\n")
		}
		writeSchemaIndent(buf, indent)
		buf.WriteString("}")
		return nil
	case []any:
		if len(val) == 0 {
			buf.WriteString("[]")
			return nil
		}
		buf.WriteString("[\n")
		for i, item := range val {
			writeSchemaIndent(buf, indent+1)
			if err := writeSchemaJSON(buf, item, indent+1, false); err != nil {
				return err
			}
			if i < len(val)-1 {
				buf.WriteString(",")
			}
			buf.WriteString("\n")
		}
		writeSchemaIndent(buf, indent)
		buf.WriteString("]")
		return nil
	case []string:
		if len(val) == 0 {
			buf.WriteString("[]")
			return nil
		}
		buf.WriteString("[\n")
		for i, item := range val {
			writeSchemaIndent(buf, indent+1)
			if err := writeJSONScalar(buf, item); err != nil {
				return err
			}
			if i < len(val)-1 {
				buf.WriteString(",")
			}
			buf.WriteString("\n")
		}
		writeSchemaIndent(buf, indent)
		buf.WriteString("]")
		return nil
	default:
		return writeJSONScalar(buf, v)
	}
}

func schemaKeysFor(m map[string]any, propsMap bool) []string {
	if propsMap {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return keys
	}
	seen := make(map[string]bool, len(m))
	keys := make([]string, 0, len(m))
	for _, k := range schemaKeyOrder {
		if _, ok := m[k]; ok {
			keys = append(keys, k)
			seen[k] = true
		}
	}
	rest := make([]string, 0, len(m)-len(keys))
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(keys, rest...)
}

func writeJSONScalar(buf *bytes.Buffer, v any) error {
	enc := json.NewEncoder(buf)
	// JSON.stringify does not escape <, > or &; the default Go encoder does.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	// Encode appends a newline; JSON.stringify does not.
	buf.Truncate(buf.Len() - 1)
	return nil
}

func writeSchemaIndent(buf *bytes.Buffer, indent int) {
	buf.WriteString(strings.Repeat("  ", indent))
}
