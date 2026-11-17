package remote

import (
	"context"
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
)

func (s *Server) buildMcpStatus() string {
	if s.mcpMgr == nil {
		return "No MCP servers configured."
	}
	connected := s.mcpMgr.ConnectedServers()
	if len(connected) == 0 {
		return "No MCP servers connected."
	}
	lines := []string{fmt.Sprintf("MCP servers (%d):", len(connected))}
	for _, server := range connected {
		lines = append(lines, "  · "+server)
	}
	lines = append(lines, fmt.Sprintf("Tools: %d total", bootstrap.CountMcpTools(s.registry)))
	return strings.Join(lines, "\n")
}

func (s *Server) reloadMcpServers(ctx context.Context) {
	system := func(message string) { s.send(wsMessage{Type: "system", Data: map[string]string{"message": message}}) }
	cfg, err := config.LoadConfig("", config.LoadOptions{})
	if err != nil {
		system("MCP reload failed: " + err.Error())
		return
	}
	servers := config.WithProjectMcpServers(cfg, mustGetwd()).MCPServers
	s.mcpConfigs = servers
	if len(servers) == 0 {
		if s.mcpMgr != nil {
			s.mcpMgr.DisconnectAll()
			mcp.RetractMcpInstructions(s.conv, s.mcpAnnounced)
		}
		bootstrap.RemoveMcpTools(s.registry)
		s.mcpMgr = nil
		system("MCP config reloaded: no MCP servers are configured.")
		return
	}
	if s.mcpMgr == nil {
		s.mcpMgr = mcp.NewManager(true)
	}
	names := make([]string, 0, len(servers))
	for _, server := range servers {
		names = append(names, server.Name)
	}
	system("Reloading MCP server(s): " + strings.Join(names, ", "))
	bootstrap.RemoveMcpTools(s.registry)
	mcp.RetractMcpInstructions(s.conv, s.mcpAnnounced)
	result := s.mcpMgr.ReconnectAll(ctx, servers)
	for _, connected := range result.Tools {
		s.registry.Register(connected.Tool)
	}
	if len(result.Errors) > 0 {
		errors := make([]string, 0, len(result.Errors))
		for _, failure := range result.Errors {
			errors = append(errors, failure.ServerName+": "+failure.Error)
		}
		system("MCP errors: " + strings.Join(errors, "; "))
	}
	if len(result.Tools) > 0 {
		p := s.activeProvider()
		mcp.DecideAndApply(s.registry, p.BaseURL, p.Protocol, s.ag.ContextWindow, s.MCPLoading)
	}
	system(fmt.Sprintf("MCP reloaded: %d server(s) connected, %d tool(s)", len(s.mcpMgr.ConnectedServers()), bootstrap.CountMcpTools(s.registry)))
}
