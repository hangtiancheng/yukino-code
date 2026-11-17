package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var (
	intShape = regexp.MustCompile(`^[+-]?\d+$`)
	numShape = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)
)

const MCPToolPrefix = "mcp__"

const MCPNameSep = "__"

const McpCallToolName = "McpCall"

func coerceScalar(value any, want string) any {
	switch want {
	case "string":
		switch v := value.(type) {
		case float64:
			if math.IsInf(v, 0) || math.IsNaN(v) {
				return value
			}
			if v == float64(int64(v)) {
				return strconv.FormatInt(int64(v), 10)
			}
			return strconv.FormatFloat(v, 'f', -1, 64)
		case int:
			return strconv.Itoa(v)
		case int64:
			return strconv.FormatInt(v, 10)
		case json.Number:
			return v.String()
		}
	case "integer":
		if s, ok := value.(string); ok {
			text := strings.TrimSpace(s)
			if !intShape.MatchString(text) {
				return value
			}
			if n, err := strconv.ParseInt(text, 10, 64); err == nil {
				return n
			}
		}
	case "number":
		if s, ok := value.(string); ok {
			text := strings.TrimSpace(s)
			if !numShape.MatchString(text) {
				return value
			}
			if f, err := strconv.ParseFloat(text, 64); err == nil && !math.IsInf(f, 0) && !math.IsNaN(f) {
				return f
			}
		}
	case "boolean":
		if s, ok := value.(string); ok {
			switch strings.ToLower(strings.TrimSpace(s)) {
			case "true":
				return true
			case "false":
				return false
			}
		}
	}
	return value
}

func CoerceBySchema(value any, schema any) any {
	schemaMap, ok := schema.(map[string]any)
	if !ok {
		return value
	}
	want, _ := schemaMap["type"].(string)

	if want == "object" {
		obj, ok := value.(map[string]any)
		if !ok {
			return value
		}
		props, _ := schemaMap["properties"].(map[string]any)
		out := make(map[string]any, len(obj))
		for k, v := range obj {
			if sub, found := props[k]; found {
				out[k] = CoerceBySchema(v, sub)
			} else {
				out[k] = v
			}
		}
		return out
	}

	if want == "array" {
		itemSchema := schemaMap["items"]
		if obj, isObj := value.(map[string]any); isObj && len(obj) == 1 {
			for _, inner := range obj {
				if arr, isArr := inner.([]any); isArr {
					value = arr
				}
			}
		} else if s, isStr := value.(string); isStr {
			parts := strings.Split(s, ",")
			arr := make([]any, 0, len(parts))
			for _, p := range parts {
				if t := strings.TrimSpace(p); t != "" {
					arr = append(arr, t)
				}
			}
			value = arr
		}
		if arr, isArr := value.([]any); isArr {
			out := make([]any, len(arr))
			for i, item := range arr {
				out[i] = CoerceBySchema(item, itemSchema)
			}
			return out
		}
		return value
	}

	if want != "" {
		return coerceScalar(value, want)
	}
	return value
}

func McpCallPermissionContent(server, tool string) string {
	if strings.HasPrefix(tool, MCPToolPrefix) {
		return strings.TrimPrefix(tool, MCPToolPrefix)
	}
	return sanitizeSegment(server) + MCPNameSep + sanitizeSegment(tool)
}

type McpCallTool struct {
	Registry *Registry
}

func (t *McpCallTool) Name() string { return McpCallToolName }

func (t *McpCallTool) Description() string {
	return "Invoke a tool on a connected MCP server. Call ToolSearch first to load " +
		"the tool's schema, then pass its arguments here exactly as that schema " +
		"requires, using the same JSON types."
}

func (t *McpCallTool) Category() ToolCategory { return CategoryCommand }

func (t *McpCallTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"server": map[string]any{
					"type":        "string",
					"description": "MCP server name, e.g. 'linear'.",
				},
				"tool": map[string]any{
					"type": "string",
					"description": "Full tool name as returned by ToolSearch, " +
						"e.g. 'mcp__linear__create_issue'.",
				},
				"arguments": map[string]any{
					"type": "object",
					"description": "The target tool's arguments. Must match that " +
						"tool's input_schema exactly, including JSON types: bare " +
						"numbers for integer fields, bare true/false for boolean " +
						"fields, quoted strings for string fields, and plain JSON " +
						"arrays for array fields.",
				},
			},
			"required": []string{"server", "tool", "arguments"},
		},
	}
}

func (t *McpCallTool) ResolveTarget(args map[string]any) MCPTool {
	server, _ := args["server"].(string)
	name, _ := args["tool"].(string)
	if server == "" || name == "" {
		return nil
	}
	full := name
	if !strings.HasPrefix(name, MCPToolPrefix) {
		full = MCPToolPrefix + sanitizeSegment(server) + MCPNameSep + sanitizeSegment(name)
	}
	target, ok := t.Registry.Get(full).(MCPTool)
	if !ok || target.MCPServerName() != server {
		return nil
	}
	return target
}

func sanitizeSegment(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

func (t *McpCallTool) availableNames() []string {
	var names []string
	for _, candidate := range t.Registry.ListTools() {
		if strings.HasPrefix(candidate.Name(), MCPToolPrefix) {
			names = append(names, candidate.Name())
		}
	}
	sort.Strings(names)
	return names
}

func (t *McpCallTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	server, _ := args["server"].(string)
	tool, _ := args["tool"].(string)
	if tool == "" {
		return ToolResult{Output: "McpCall requires a 'tool' name", IsError: true}
	}

	target := t.ResolveTarget(args)
	if target == nil {
		names := t.availableNames()
		hint := "(none connected)"
		if len(names) > 0 {
			hint = strings.Join(names, ", ")
		}
		return ToolResult{
			Output: fmt.Sprintf(
				"Unknown MCP tool '%s' on server '%s'. Available tools: %s",
				tool, server, hint),
			IsError: true,
		}
	}

	inner, ok := args["arguments"].(map[string]any)
	if !ok || inner == nil {
		return ToolResult{Output: "McpCall requires an 'arguments' object matching the target schema", IsError: true}
	}
	{
		if schema := target.MCPInputSchema(); len(schema) > 0 {
			if fixed, ok := CoerceBySchema(inner, schema).(map[string]any); ok {
				inner = fixed
			}
		}
	}
	if ctx.Err() != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	return target.Execute(ctx, inner)
}

func (t *McpCallTool) PrepareArguments(args map[string]any) map[string]any {
	target := t.ResolveTarget(args)
	inner, ok := args["arguments"].(map[string]any)
	if target == nil || !ok || inner == nil {
		return args
	}
	out := make(map[string]any, len(args))
	for key, value := range args {
		out[key] = value
	}
	out["arguments"] = CoerceBySchema(inner, target.MCPInputSchema())
	return out
}
