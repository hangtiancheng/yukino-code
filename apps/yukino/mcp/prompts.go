package mcp

import "strings"

func FormatMcpInstructionsDelta(added []McpInstruction, removed []string) string {
	var parts []string
	if len(added) > 0 {
		blocks := make([]string, 0, len(added))
		for _, instruction := range added {
			blocks = append(blocks, "## "+instruction.ServerName+"\n"+instruction.Text)
		}
		parts = append(parts, MCPInstructionsMarker+"\n\nThe following MCP servers have connected and provide instructions for how to use their tools and resources:\n\n"+strings.Join(blocks, "\n\n"))
	}
	if len(removed) > 0 {
		parts = append(parts, "The following MCP servers have disconnected. Their instructions above no longer apply:\n"+strings.Join(removed, "\n"))
	}
	return strings.Join(parts, "\n\n")
}
