package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
)

func (m Model) mcpStatus() string {
	if m.mcpMgr == nil {
		return "No MCP servers configured."
	}
	connected := m.mcpMgr.ConnectedServers()
	lines := []string{"No MCP servers connected."}
	if len(connected) > 0 {
		lines = []string{fmt.Sprintf("MCP servers (%d):", len(connected))}
		for _, server := range connected {
			lines = append(lines, "  · "+server)
		}
		lines = append(lines, fmt.Sprintf("Tools: %d total", bootstrap.CountMcpTools(m.registry)))
	}
	if missing := m.mcpMgr.MissingServers(m.mcpConfigs); len(missing) > 0 {
		lines = append(lines, "Not connected: "+strings.Join(missing, ", "))
	}
	return strings.Join(lines, "\n")
}

func (m Model) runMCPCommand(args string) (tea.Model, tea.Cmd) {
	if m.mcpConnecting {
		m.pendingMCPCommands = append(m.pendingMCPCommands, args)
		m.commandBusy = true
		return m, nil
	}
	reload := strings.ToLower(strings.TrimSpace(args)) == "reload"
	if reload {
		cfg, err := config.LoadConfig("", config.LoadOptions{})
		if err != nil {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "MCP reload failed: " + err.Error()})
			return m.finishMCPCommand()
		}
		m.mcpConfigs = config.WithProjectMcpServers(cfg, m.getWorkDir()).MCPServers
		if len(m.mcpConfigs) > 0 {
			names := []string{}
			for _, server := range m.mcpConfigs {
				names = append(names, server.Name)
			}
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Reloading MCP server(s): " + strings.Join(names, ", ")})
		}
		bootstrap.RemoveMcpTools(m.registry)
		mcp.RetractMcpInstructions(m.conversation, m.mcpAnnounced)
	} else if m.mcpMgr == nil || len(m.mcpMgr.MissingServers(m.mcpConfigs)) == 0 {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: m.mcpStatus()})
		return m.finishMCPCommand()
	} else {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Connecting MCP server(s): " + strings.Join(m.mcpMgr.MissingServers(m.mcpConfigs), ", ")})
	}
	if m.mcpMgr == nil && len(m.mcpConfigs) > 0 {
		m.mcpMgr = mcp.NewManager(false)
	}
	mgr, configs, ctx := m.mcpMgr, m.mcpConfigs, m.lifeCtx
	m.mcpConnecting, m.commandBusy = true, true
	return m, func() tea.Msg {
		if len(configs) == 0 {
			if mgr != nil {
				mgr.DisconnectAll()
			}
			return mcpReadyMsg{command: true, reload: reload, empty: true}
		}
		var result mcp.ConnectResult
		if reload {
			result = mgr.ReconnectAll(ctx, configs)
		} else {
			result = mgr.ConnectAll(ctx, configs)
		}
		return mcpReadyMsg{result: result, mgr: mgr, command: true, reload: reload}
	}
}

func (m Model) applyMCPResult(msg mcpReadyMsg) (tea.Model, tea.Cmd) {
	m.mcpConnecting = false
	m.mcpMgr = msg.mgr
	if msg.empty {
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "MCP config reloaded: no MCP servers are configured."})
	} else {
		for _, connected := range msg.result.Tools {
			m.registry.Register(connected.Tool)
		}
		if len(msg.result.Errors) > 0 {
			messages := []string{}
			for _, failure := range msg.result.Errors {
				messages = append(messages, failure.ServerName+": "+failure.Error)
			}
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "MCP errors: " + strings.Join(messages, "; ")})
		}
		if len(msg.result.Tools) > 0 && m.selectedProvider != nil {
			if m.mcpModeDecided {
				mcp.ApplyMode(m.registry, m.registry.McpLoadingMode)
			} else {
				p := m.selectedProvider
				mcp.DecideAndApply(m.registry, p.BaseURL, p.Protocol, config.GetContextWindow(p), m.MCPLoading)
				m.mcpModeDecided = true
			}
		}
		if m.mcpMgr != nil {
			mcp.SyncMcpInstructions(m.conversation, m.mcpAnnounced, m.mcpMgr)
		}
		if msg.command {
			message := m.mcpStatus()
			if msg.reload {
				message = fmt.Sprintf("MCP reloaded: %d server(s) connected, %d tool(s)", len(m.mcpMgr.ConnectedServers()), bootstrap.CountMcpTools(m.registry))
			}
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: message})
		}
	}
	m.mcpServerInfo = m.mcpStatus()
	return m.finishMCPCommand()
}

func (m Model) finishMCPCommand() (tea.Model, tea.Cmd) {
	m.commandBusy = false
	if len(m.pendingMCPCommands) > 0 {
		args := m.pendingMCPCommands[0]
		m.pendingMCPCommands = m.pendingMCPCommands[1:]
		return m.runMCPCommand(args)
	}
	return m, m.commitStaticOutput()
}
