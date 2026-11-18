package mcp

// MCP Apps payloads exchanged with browser hosts. The reference validates
// these with zod; the Go wire format keeps the same field names and nesting.

type McpApp struct {
	ServerName  string         `json:"serverName"`
	ToolName    string         `json:"toolName"`
	ResourceURI string         `json:"resourceUri"`
	Arguments   map[string]any `json:"arguments"`
	Result      any            `json:"result"`
}

type McpAppToolResult struct {
	ToolID   string  `json:"toolId"`
	ToolName string  `json:"toolName"`
	Output   string  `json:"output"`
	IsError  bool    `json:"isError"`
	Elapsed  float64 `json:"elapsed"`
	McpApp   *McpApp `json:"mcpApp"`
}

type McpAppRequest struct {
	RequestID string         `json:"requestId"`
	AppID     string         `json:"appId"`
	Method    string         `json:"method"`
	Params    map[string]any `json:"params"`
}

// ValidMcpAppRequest enforces the discriminated union: read_resource takes
// {uri}, call_tool takes {name, arguments?}.
func ValidMcpAppRequest(request McpAppRequest) bool {
	if request.RequestID == "" || request.AppID == "" {
		return false
	}
	switch request.Method {
	case "read_resource":
		_, ok := request.Params["uri"].(string)
		return ok
	case "call_tool":
		name, ok := request.Params["name"].(string)
		if !ok {
			return false
		}
		if name == "" {
			return true
		}
		if arguments, exists := request.Params["arguments"]; exists && arguments != nil {
			_, ok := arguments.(map[string]any)
			return ok
		}
		return true
	default:
		return false
	}
}
