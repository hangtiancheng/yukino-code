package tools

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ToolModule is a registrable group of MCP tools, mirroring the TypeScript
// ToolModule interface. Init and Shutdown are optional lifecycle hooks.
type ToolModule struct {
	// Name is a stable identifier for the module (used in logs).
	Name string
	// Register adds the module's tools (and any resources) to the server.
	Register func(server *mcp.Server)
	// Init, when non-nil, is invoked once after the server starts.
	Init func(ctx context.Context) error
	// Shutdown, when non-nil, is invoked during graceful shutdown.
	Shutdown func(ctx context.Context) error
}
