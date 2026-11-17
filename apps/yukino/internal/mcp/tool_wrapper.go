package mcp

import (
	"context"
	"regexp"

	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

var nonAlphanumeric = regexp.MustCompile(`[^a-zA-Z0-9_]`)

func SanitizeSegment(s string) string {
	return nonAlphanumeric.ReplaceAllString(s, "_")
}

// MCPToolNamePrefix is the common prefix for all tool names under a given
// server. Use this anywhere you filter tools by server; assembling the string
// by hand would skip sanitization.
func MCPToolNamePrefix(serverName string) string {
	return MCPToolPrefix + SanitizeSegment(serverName) + MCPNameSep
}

func BuildMCPToolName(serverName, toolName string) string {
	return MCPToolNamePrefix(serverName) + SanitizeSegment(toolName)
}

type MCPToolWrapper struct {
	serverName   string
	originalName string
	description  string
	inputSchema  map[string]any
	client       *Client
	noDefer      bool
}

func NewMCPToolWrapper(client *Client, serverName string, tool MCPTool) *MCPToolWrapper {
	return &MCPToolWrapper{
		serverName:   serverName,
		originalName: tool.Name,
		description:  tool.Description,
		inputSchema:  tool.InputSchema,
		client:       client,
	}
}

func (w *MCPToolWrapper) Name() string {
	return BuildMCPToolName(w.serverName, w.originalName)
}

func (w *MCPToolWrapper) Description() string          { return w.description }
func (w *MCPToolWrapper) Category() tools.ToolCategory { return tools.CategoryCommand }
func (w *MCPToolWrapper) ShouldDefer() bool            { return !w.noDefer }
func (w *MCPToolWrapper) SetDeferLoading(on bool)      { w.noDefer = !on }
func (w *MCPToolWrapper) MCPServerName() string        { return w.serverName }

// MCPInputSchema returns the original JSON schema. McpCall's argument coercion
// walks it layer by layer.
func (w *MCPToolWrapper) MCPInputSchema() map[string]any {
	if w.inputSchema == nil {
		return map[string]any{}
	}
	return w.inputSchema
}

func (w *MCPToolWrapper) Schema() map[string]any {
	return map[string]any{
		"name":         w.Name(),
		"description":  w.description,
		"input_schema": w.inputSchema,
	}
}

func (w *MCPToolWrapper) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	result, err := w.client.CallTool(ctx, w.originalName, args)
	if err != nil {
		log.Error(map[string]any{"err": err}, "mcp operation failed")
		return tools.ToolResult{Output: "MCP tool error: " + utils.AsErrorString(err), IsError: true}
	}
	return result
}

var _ tools.MCPTool = (*MCPToolWrapper)(nil)
