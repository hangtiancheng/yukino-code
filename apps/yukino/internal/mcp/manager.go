package mcp

import (
	"context"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

type ConnectedTool struct {
	ServerName string
	Tool       *MCPToolWrapper
}

type ConnectError struct {
	ServerName string
	Error      string
}

type ConnectResult struct {
	Tools        []ConnectedTool
	Servers      []string
	Errors       []ConnectError
	Instructions []McpInstruction
}

type Manager struct {
	appsEnabled bool
	mu          sync.Mutex
	clients     map[string]*Client
	order       []string
}

func NewManager(appsEnabled bool) *Manager {
	return &Manager{appsEnabled: appsEnabled, clients: map[string]*Client{}}
}

// ConnectAll brings up every configured server that has no live connection yet
// and reports what this pass added. Servers already connected are left
// untouched, so calling it again retries only the ones that failed.
func (m *Manager) ConnectAll(ctx context.Context, configs []config.MCPServerConfig) ConnectResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.connectAllNow(ctx, configs)
}

// ReconnectAll drops every live connection, then brings up the given config
// from scratch.
func (m *Manager) ReconnectAll(ctx context.Context, configs []config.MCPServerConfig) ConnectResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.disconnectAllNow()
	return m.connectAllNow(ctx, configs)
}

type connectionResult struct {
	ok     bool
	cfg    config.MCPServerConfig
	client *Client
	tools  []MCPTool
	err    error
}

func (m *Manager) connectAllNow(ctx context.Context, configs []config.MCPServerConfig) ConnectResult {
	result := ConnectResult{}

	seen := map[string]bool{}
	values := map[string]config.MCPServerConfig{}
	for _, cfg := range configs {
		values[cfg.Name] = cfg
	}
	var deduped []config.MCPServerConfig
	for _, cfg := range configs {
		if seen[cfg.Name] {
			continue
		}
		seen[cfg.Name] = true
		deduped = append(deduped, values[cfg.Name])
	}

	var pending []config.MCPServerConfig
	for _, cfg := range deduped {
		if cfg.Enabled != nil && !*cfg.Enabled {
			continue
		}
		if _, connected := m.clients[cfg.Name]; connected {
			continue
		}
		pending = append(pending, cfg)
	}

	connections := make([]connectionResult, len(pending))
	var wg sync.WaitGroup
	for i, cfg := range pending {
		wg.Add(1)
		go func(i int, cfg config.MCPServerConfig) {
			defer wg.Done()
			client := NewClient(cfg, m.appsEnabled)
			if err := client.Connect(ctx); err != nil {
				log.Error(map[string]any{"err": err}, "mcp operation failed")
				client.Disconnect()
				connections[i] = connectionResult{cfg: cfg, err: err}
				return
			}
			tools, err := client.ListTools(ctx)
			if err != nil {
				log.Error(map[string]any{"err": err}, "mcp operation failed")
				client.Disconnect()
				connections[i] = connectionResult{cfg: cfg, err: err}
				return
			}
			connections[i] = connectionResult{ok: true, cfg: cfg, client: client, tools: tools}
		}(i, cfg)
	}
	wg.Wait()

	for _, connection := range connections {
		if !connection.ok {
			result.Errors = append(result.Errors, ConnectError{ServerName: connection.cfg.Name, Error: utils.AsErrorString(connection.err)})
			continue
		}
		m.clients[connection.cfg.Name] = connection.client
		m.order = append(m.order, connection.cfg.Name)
		result.Servers = append(result.Servers, connection.cfg.Name)
		for _, tool := range connection.tools {
			result.Tools = append(result.Tools, ConnectedTool{ServerName: connection.cfg.Name, Tool: NewMCPToolWrapper(connection.client, connection.cfg.Name, tool)})
		}
		if instructions := connection.client.Instructions(); instructions != "" {
			result.Instructions = append(result.Instructions, McpInstruction{ServerName: connection.cfg.Name, Text: instructions})
		}
	}
	return result
}

func (m *Manager) disconnectAllNow() {
	for _, name := range m.order {
		if client := m.clients[name]; client != nil {
			client.Disconnect()
		}
	}
	m.clients = map[string]*Client{}
	m.order = nil
}

func (m *Manager) GetClient(name string) *Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.clients[name]
}

// ConnectedServers lists every server with a live connection, across all
// connect passes, in connect order.
func (m *Manager) ConnectedServers() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.order...)
}

// ConnectedInstructions returns instructions advertised by every currently
// connected server.
func (m *Manager) ConnectedInstructions() []McpInstruction {
	m.mu.Lock()
	defer m.mu.Unlock()
	var instructions []McpInstruction
	for _, name := range m.order {
		if client := m.clients[name]; client != nil {
			if text := client.Instructions(); text != "" {
				instructions = append(instructions, McpInstruction{ServerName: name, Text: text})
			}
		}
	}
	return instructions
}

// MissingServers lists the configured servers that are still not connected.
func (m *Manager) MissingServers(configs []config.MCPServerConfig) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var missing []string
	for _, cfg := range configs {
		if cfg.Enabled != nil && !*cfg.Enabled {
			continue
		}
		if _, connected := m.clients[cfg.Name]; !connected {
			missing = append(missing, cfg.Name)
		}
	}
	return missing
}

func (m *Manager) DisconnectAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.disconnectAllNow()
}
