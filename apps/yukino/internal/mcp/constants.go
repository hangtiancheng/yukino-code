package mcp

// Heading of announcements that add servers; also the marker history is scanned
// for. Removal-only deltas do not carry it.
const MCPInstructionsMarker = "# MCP Server Instructions"

const (
	MCPToolPrefix        = "mcp__"
	MCPAppsExtension     = "io.modelcontextprotocol/ui"
	MCPAppMIMEType       = "text/html;profile=mcp-app"
	MCPAppURIPrefix      = "ui://"
	MCPNameSep           = "__"
	MCPNotConnectedError = "Not connected"
)

// Below this share of the context window, skip deferral and load everything
// eagerly.
const DefaultEagerThresholdPercent = 10

// Estimation ratio used when real token counts are unavailable. MCP schemas
// are JSON with high symbol density, so they have fewer characters per token
// than natural language.
const CharsPerToken = 2.5

// Beta header for official endpoints; defer_loading and tool_reference both
// require it.
const NativeToolUseBeta = "advanced-tool-use-2025-11-20"

var OfficialHosts = map[string]bool{"api.anthropic.com": true}

// MCP image content uses {type:"image", data, mimeType}; providers use
// {type:"image", source:{type:"base64", media_type, data}}. Unsupported mime
// types degrade to a text placeholder.
var MCPImageMediaTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}
