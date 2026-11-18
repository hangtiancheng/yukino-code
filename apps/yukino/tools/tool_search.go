package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type ToolSearchTool struct {
	Registry *Registry
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
	var found []Tool
	if strings.HasPrefix(query, "select:") {
		var names []string
		for _, name := range strings.Split(strings.TrimPrefix(query, "select:"), ",") {
			if name = strings.TrimSpace(name); name != "" {
				names = append(names, name)
			}
		}
		found = t.Registry.FindDeferredByNames(names)
	} else {
		found = t.Registry.SearchDeferred(query, max(1, min(50, intArg(args, "max_results", 5))))
	}
	if len(found) == 0 {
		return ToolResult{Output: "No deferred tools matched the query."}
	}
	var mcp, local []Tool
	var names []string
	for _, tool := range found {
		names = append(names, tool.Name())
		if strings.HasPrefix(tool.Name(), MCPToolPrefix) {
			mcp = append(mcp, tool)
		} else {
			local = append(local, tool)
			t.Registry.MarkDiscovered(tool.Name())
		}
	}
	native := t.Registry.McpLoadingMode == McpLoadingNative
	selected := found
	if native {
		selected = local
	}
	parts := []string{fmt.Sprintf("Loaded %d tool(s): %s.", len(found), strings.Join(names, ", "))}
	for _, tool := range selected {
		data, _ := json.MarshalIndent(tool.Schema(), "", "  ")
		parts = append(parts, string(data))
	}
	output := strings.Join(parts, "\n\n")
	if len(mcp) > 0 {
		if t.Registry.McpLoadingMode == McpLoadingDispatch {
			output += "\n\nInvoke MCP tools through McpCall with the server name, full tool name, and an arguments object matching the target input_schema, including JSON types."
		} else {
			output += "\n\nThese MCP tools can be called directly by their full names."
		}
	}
	result := ToolResult{Output: output}
	if native && len(mcp) > 0 {
		result.ContentBlocks = []map[string]any{{"type": "text", "text": output}}
		for _, tool := range mcp {
			result.ContentBlocks = append(result.ContentBlocks, map[string]any{"type": "tool_reference", "tool_name": tool.Name()})
		}
	}
	return result
}
