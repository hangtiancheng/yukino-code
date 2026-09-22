// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/yukino/images"
	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
	"github.com/hangtiancheng/yukino-code/yukino/version"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module:"mcp"})).
var log = logger.CreateChildLogger("mcp")

var nonAlphanumeric = regexp.MustCompile(`[^a-zA-Z0-9_]`)

type ServerConfig struct {
	Name      string            `yaml:"name"`
	Command   string            `yaml:"command"`
	Args      []string          `yaml:"args"`
	URL       string            `yaml:"url"`
	Transport string            `yaml:"transport"`
	Headers   map[string]string `yaml:"headers"`
	Env       map[string]string `yaml:"env"`
}

func (c *ServerConfig) IsStdio() bool {
	return c.Command != ""
}

// clone returns a deep copy of the config. The manager records the config a
// live connection was built from and later deep-compares it against freshly
// loaded configs during Reconcile — mirroring the TS structuredClone(cfg)
// recorded per connected server (manager.ts:100) — so caller mutation of the
// shared Args/Headers/Env must not leak into that comparison.
func (c ServerConfig) clone() ServerConfig {
	cp := c
	if c.Args != nil {
		cp.Args = append([]string(nil), c.Args...)
	}
	if c.Headers != nil {
		cp.Headers = make(map[string]string, len(c.Headers))
		for k, v := range c.Headers {
			cp.Headers[k] = v
		}
	}
	if c.Env != nil {
		cp.Env = make(map[string]string, len(c.Env))
		for k, v := range c.Env {
			cp.Env[k] = v
		}
	}
	return cp
}

// transportKind picks the HTTP transport variant. Empty/"http"/"streamable" →
// Streamable HTTP (2025-03-26 spec); "sse" → legacy SSE (2024-11-05 spec).
func (c *ServerConfig) transportKind() string {
	// TS compares `config.transport === "sse"` strictly, so "SSE" (and every
	// other spelling) selects the Streamable HTTP transport.
	if c.Transport == "sse" {
		return "sse"
	}
	return "http"
}

// envVarRef matches the three reference forms the TS expandEnv supports:
// ${VAR}, ${VAR:-default}, and bare $VAR.
var envVarRef = regexp.MustCompile(`\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}|\$([A-Za-z_]\w*)`)

// expandEnv mirrors the TS expandEnv (client.ts:63-85): Claude-compatible
// environment expansion. A reference to an unset variable without a default
// fails the connection instead of silently becoming an empty command, URL, or
// credential.
func expandEnv(value string) (string, error) {
	var unsetErr error
	expanded := envVarRef.ReplaceAllStringFunc(value, func(match string) string {
		if unsetErr != nil {
			return match
		}
		groups := envVarRef.FindStringSubmatch(match)
		braced, fallback, bare := groups[1], groups[2], groups[3]
		name := braced
		if name == "" {
			name = bare
		}
		if resolved, ok := os.LookupEnv(name); ok {
			return resolved
		}
		// ${VAR:-default}: the fallback applies even when empty. Variable
		// names cannot contain ":-", so its presence in the match means the
		// fallback group participated (TS checks fallback !== undefined).
		if braced != "" && strings.Contains(match, ":-") {
			return fallback
		}
		unsetErr = fmt.Errorf("MCP config references unset environment variable %q", name)
		return match
	})
	if unsetErr != nil {
		return "", unsetErr
	}
	return expanded, nil
}

// expandMcpServerConfigEnvironment mirrors the TS counterpart
// (client.ts:91-123): expands environment references in every location
// supported by project .mcp.json files (command/args/url/env/headers) without
// mutating the original config.
func expandMcpServerConfigEnvironment(config ServerConfig) (ServerConfig, error) {
	var err error
	expanded := ServerConfig{Name: config.Name, Transport: config.Transport}
	if expanded.Command, err = expandEnv(config.Command); err != nil {
		return ServerConfig{}, err
	}
	if config.Args != nil {
		expanded.Args = make([]string, len(config.Args))
		for i, arg := range config.Args {
			if expanded.Args[i], err = expandEnv(arg); err != nil {
				return ServerConfig{}, err
			}
		}
	}
	if expanded.URL, err = expandEnv(config.URL); err != nil {
		return ServerConfig{}, err
	}
	if config.Env != nil {
		expanded.Env = make(map[string]string, len(config.Env))
		for k, v := range config.Env {
			if expanded.Env[k], err = expandEnv(v); err != nil {
				return ServerConfig{}, err
			}
		}
	}
	if config.Headers != nil {
		expanded.Headers = make(map[string]string, len(config.Headers))
		for k, v := range config.Headers {
			if expanded.Headers[k], err = expandEnv(v); err != nil {
				return ServerConfig{}, err
			}
		}
	}
	return expanded, nil
}

// headerRoundTripper injects fixed headers onto every outgoing request.
// Header values are already environment-expanded at connect time.
type headerRoundTripper struct {
	base    http.RoundTripper
	headers map[string]string
}

func (h *headerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	for k, v := range h.headers {
		clone.Header.Set(k, v)
	}
	return h.base.RoundTrip(clone)
}

func newHTTPClient(headers map[string]string) *http.Client {
	if len(headers) == 0 {
		return http.DefaultClient
	}
	return &http.Client{
		Transport: &headerRoundTripper{
			base:    http.DefaultTransport,
			headers: headers,
		},
	}
}

type Client struct {
	config    ServerConfig
	session   *mcp.ClientSession
	sdkClient *mcp.Client
}

func NewClient(config ServerConfig) *Client {
	// Deep copy so the stored config stays the pristine snapshot Reconcile
	// compares against (TS records structuredClone(cfg), manager.ts:100).
	return &Client{config: config.clone()}
}

func (c *Client) Connect(ctx context.Context) error {
	config, err := expandMcpServerConfigEnvironment(c.config)
	if err != nil {
		return err
	}

	impl := &mcp.Implementation{Name: "yukino", Version: version.Get()}
	c.sdkClient = mcp.NewClient(impl, nil)

	var transport mcp.Transport
	switch {
	case config.IsStdio():
		cmd := exec.Command(config.Command, config.Args...)
		cmd.Env = os.Environ()
		for k, v := range config.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		// Detach stderr from the parent tty. Otherwise child processes (npx/node)
		// detect stderr as a TTY and emit OSC color queries; the terminal sends
		// the response to the controlling process's stdin, polluting the TUI input.
		cmd.Stderr = io.Discard
		transport = &mcp.CommandTransport{Command: cmd}
	case config.URL != "":
		httpClient := newHTTPClient(config.Headers)
		if config.transportKind() == "sse" {
			transport = &mcp.SSEClientTransport{Endpoint: config.URL, HTTPClient: httpClient}
		} else {
			transport = &mcp.StreamableClientTransport{Endpoint: config.URL, HTTPClient: httpClient}
		}
	default:
		return fmt.Errorf("MCP server '%s': needs either 'command' (stdio) or 'url' (http/sse)", c.config.Name)
	}

	session, err := c.sdkClient.Connect(ctx, transport, nil)
	if err != nil {
		return err
	}
	c.session = session
	return nil
}

func (c *Client) ListTools(ctx context.Context) ([]*mcp.Tool, error) {
	result, err := c.session.ListTools(ctx, nil)
	if err != nil {
		return nil, err
	}
	// Mirror the TS listTools normalization (client.ts:284-294): force
	// `properties ?? {}` so schema consumers can always rely on the key.
	for _, tool := range result.Tools {
		if schema, ok := tool.InputSchema.(map[string]any); ok && schema["properties"] == nil {
			schema["properties"] = map[string]any{}
		}
	}
	return result.Tools, nil
}

// mcpContentToToolOutput mirrors the TS mcpContentToToolOutput
// (client.ts:145-207). MCP image content uses {type:"image", data, mimeType};
// providers use {type:"image", source:{type:"base64", media_type, data}}.
// Supported images are resized and surfaced as base64 content blocks with an
// "[Image: …]" marker in the text fallback; unsupported mime types degrade to
// a note; other non-text content is JSON-serialized. Content blocks are only
// returned when at least one image survived — TS omits the field otherwise.
func mcpContentToToolOutput(content []mcp.Content) (string, []map[string]any) {
	var textParts []string
	var contentBlocks []map[string]any
	hasImage := false

	for _, c := range content {
		switch v := c.(type) {
		case *mcp.ImageContent:
			mediaType, mimeErr := images.AsImageMediaType(v.MIMEType)
			if mimeErr == nil {
				resized, resizeErr := images.MaybeResizeAndDownsampleImage(v.Data, mediaType)
				if resizeErr == nil {
					contentBlocks = append(contentBlocks, map[string]any{
						"type": "image",
						"source": map[string]any{
							"type":       "base64",
							"media_type": string(resized.MediaType),
							"data":       resized.Data,
						},
					})
					textParts = append(textParts, fmt.Sprintf("[Image: %s]", resized.MediaType))
					hasImage = true
					continue
				}
				log.Error("mcp operation failed", "err", resizeErr)
				note := "[note: an image returned by the tool was too large and was dropped]"
				textParts = append(textParts, note)
				contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": note})
				continue
			}
			mimeType := v.MIMEType
			if mimeType == "" {
				mimeType = "unknown"
			}
			note := fmt.Sprintf("[Unsupported image: %s]", mimeType)
			textParts = append(textParts, note)
			contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": note})
		case *mcp.TextContent:
			textParts = append(textParts, v.Text)
			contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": v.Text})
		default:
			// Audio, resource links, embedded resources, and anything else the
			// SDK adds later: serialize the wire form, same as the TS fallback.
			serialized, jsonErr := json.Marshal(c)
			text := fmt.Sprintf("%v", c)
			if jsonErr == nil {
				text = string(serialized)
			}
			textParts = append(textParts, text)
			contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": text})
		}
	}

	output := strings.Join(textParts, "\n")
	if hasImage {
		return output, contentBlocks
	}
	return output, nil
}

// CallTool calls a tool and preserves both its text fallback and
// provider-native rich content (mirrors the TS callTool, client.ts:298-319).
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (tools.ToolResult, error) {
	// TS throws Error("Not connected") for a client without a session; the Go
	// field would otherwise be dereferenced (nil panic) for a never-connected
	// client.
	if c.session == nil {
		return tools.ToolResult{IsError: true}, errors.New("Not connected")
	}
	result, err := c.session.CallTool(ctx, &mcp.CallToolParams{
		Name:      name,
		Arguments: args,
	})
	if err != nil {
		return tools.ToolResult{IsError: true}, err
	}
	if result.Content != nil {
		output, blocks := mcpContentToToolOutput(result.Content)
		return tools.ToolResult{Output: output, ContentBlocks: blocks, IsError: result.IsError}, nil
	}
	// TS falls back to JSON.stringify(result) when content is absent.
	serialized, jsonErr := json.Marshal(result)
	if jsonErr != nil {
		serialized = []byte(fmt.Sprintf("%v", result))
	}
	return tools.ToolResult{Output: string(serialized), IsError: result.IsError}, nil
}

func (c *Client) Close() {
	if c.session != nil {
		if err := c.session.Close(); err != nil {
			// TS logs a failed disconnect (client.ts:325).
			log.Error("mcp operation failed", "err", err)
		}
	}
}

// Manager handles multiple MCP servers

type Manager struct {
	// mu serializes every public operation (TS: runExclusive over the MCP
	// client manager). Sessions build tool sets while other sessions trigger
	// connect passes, so map access must not be left to the caller.
	mu      sync.Mutex
	configs map[string]ServerConfig
	// configOrder preserves the desired-set insertion order. TS iterates the
	// configs array it is handed (connectAllNow) and its insertion-ordered
	// maps; Go maps iterate randomly, so connect passes, MissingServers and
	// Reconcile classification all follow this recorded order instead.
	configOrder []string
	clients     map[string]*Client
	// toolDefs caches each server's tool list so extra wrapper sets can be
	// built without another round trip.
	toolDefs map[string][]*mcp.Tool
	// servers records what each live connection reported at initialize, so the
	// full picture survives across incremental connect passes.
	servers map[string]ServerInfo
}

func NewManager() *Manager {
	return &Manager{
		configs:  make(map[string]ServerConfig),
		clients:  make(map[string]*Client),
		toolDefs: make(map[string][]*mcp.Tool),
		servers:  make(map[string]ServerInfo),
	}
}

func (m *Manager) LoadConfigs(configs []ServerConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, cfg := range configs {
		if _, exists := m.configs[cfg.Name]; !exists {
			m.configOrder = append(m.configOrder, cfg.Name)
		}
		m.configs[cfg.Name] = cfg
	}
}

type ServerInfo struct {
	Name         string
	Instructions string
}

// ConnectError mirrors one TS connectResults entry: the server name plus the
// raw error string. The error text is recorded verbatim — the connect failure
// for a misconfigured server already carries the "MCP server '<name>': "
// prefix, so adding another one here would double it.
type ConnectError struct {
	ServerName string
	Error      string
}

type ConnectResult struct {
	Mgr     *Manager
	Tools   []tools.Tool
	Servers []ServerInfo
	Errors  []ConnectError
}

// ConnectAll brings up every configured server that has no live connection yet
// and reports what this pass added. Servers already connected are left
// untouched, so calling it again retries only the ones that failed — a server
// that was down earlier can join later without disturbing the working ones.
func (m *Manager) ConnectAll(ctx context.Context) ConnectResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.connectAllLocked(ctx)
}

// connectAllLocked is the ConnectAll body; callers must hold m.mu.
func (m *Manager) connectAllLocked(ctx context.Context) ConnectResult {
	// Connect in the recorded config order, like the TS connectAllNow loop
	// over its configs array.
	var errs []ConnectError
	var registered []tools.Tool
	var servers []ServerInfo
	for _, name := range m.configOrder {
		cfg := m.configs[name]
		if _, live := m.clients[name]; live {
			continue
		}
		client := NewClient(cfg)
		if err := client.Connect(ctx); err != nil {
			log.Error("mcp operation failed", "err", err)
			errs = append(errs, ConnectError{ServerName: name, Error: err.Error()})
			continue
		}

		info := ServerInfo{Name: name}
		if initResult := client.session.InitializeResult(); initResult != nil {
			info.Instructions = initResult.Instructions
		}

		toolDefs, err := client.ListTools(ctx)
		if err != nil {
			// TS has one catch around connect+listTools and records the raw
			// error verbatim (no extra prefix).
			log.Error("mcp operation failed", "err", err)
			errs = append(errs, ConnectError{ServerName: name, Error: err.Error()})
			// A server that cannot be listed is of no use, and keeping the
			// connection would make it look connected on the next pass.
			client.Close()
			continue
		}

		m.clients[name] = client
		m.toolDefs[name] = toolDefs
		m.servers[name] = info
		servers = append(servers, info)

		for _, td := range toolDefs {
			registered = append(registered, &MCPToolWrapper{
				serverName: name,
				toolDef:    td,
				client:     client,
			})
		}
	}
	return ConnectResult{Mgr: m, Tools: registered, Servers: servers, Errors: errs}
}

// ReconcileResult mirrors the TS ReconcileResult (manager.ts:41-46): the
// connect-pass outcome plus the per-server classification a `/mcp reload`
// needs to report what changed.
type ReconcileResult struct {
	ConnectResult
	Added     []string
	Removed   []string
	Restarted []string
	Unchanged []string
}

// Reconcile applies a freshly loaded config set without disturbing unchanged
// connections (TS manager.ts:130-167, the `/mcp reload` path). A same-named
// server whose config changed is restarted with the new settings; servers
// absent from configs are disconnected and removed; every other live
// connection is left untouched. Servers that connect in this pass are
// reported in Added, restarted ones in Restarted (both also appear in the
// embedded ConnectResult's Servers when the reconnect succeeded).
//
// Unlike LoadConfigs (which merges), Reconcile replaces the desired set
// wholesale, so dropped servers are not reconnected by later ConnectAll
// passes. Internally synchronized (TS: runExclusive).
func (m *Manager) Reconcile(ctx context.Context, configs []ServerConfig) ReconcileResult {
	m.mu.Lock()
	defer m.mu.Unlock()

	desired := make(map[string]ServerConfig, len(configs))
	order := make([]string, 0, len(configs))
	for _, cfg := range configs {
		// TS `new Map(configs.map(...))`: first-occurrence order, last value wins.
		if _, seen := desired[cfg.Name]; !seen {
			order = append(order, cfg.Name)
		}
		desired[cfg.Name] = cfg
	}

	var removed, restarted, unchanged []string

	// Map iteration order is randomized; classify in sorted name order so the
	// result is deterministic (TS iterates its insertion-ordered client map).
	names := make([]string, 0, len(m.clients))
	for name := range m.clients {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		next, wanted := desired[name]
		// reflect.DeepEqual mirrors the TS isDeepStrictEqual over the config
		// recorded when the live connection was built (manager.ts:141).
		if wanted && reflect.DeepEqual(m.clients[name].config, next) {
			unchanged = append(unchanged, name)
			continue
		}

		m.clients[name].Close()
		delete(m.clients, name)
		delete(m.toolDefs, name)
		delete(m.servers, name)
		if wanted {
			restarted = append(restarted, name)
		} else {
			removed = append(removed, name)
		}
	}

	m.configs = desired
	m.configOrder = order
	connected := m.connectAllLocked(ctx)

	// A restarted server shows up in the connect pass too; only servers that
	// were not previously connected count as added (TS manager.ts:158-161).
	restartedSet := make(map[string]bool, len(restarted))
	for _, name := range restarted {
		restartedSet[name] = true
	}
	var added []string
	for _, info := range connected.Servers {
		if !restartedSet[info.Name] {
			added = append(added, info.Name)
		}
	}

	return ReconcileResult{
		ConnectResult: connected,
		Added:         added,
		Removed:       removed,
		Restarted:     restarted,
		Unchanged:     unchanged,
	}
}

// ConnectedServers returns every server with a live connection, across all
// connect passes, in name order (TS returns its insertion-ordered map keys;
// Go maps are unordered, so the result is sorted for determinism — consumers
// either treat it as a set or re-sort it themselves).
func (m *Manager) ConnectedServers() []ServerInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := make([]ServerInfo, 0, len(m.servers))
	for _, info := range m.servers {
		list = append(list, info)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

// MissingServers names the configured servers that are still not connected,
// in config order (TS missingServers filters the configs array it is given).
func (m *Manager) MissingServers() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var missing []string
	for _, name := range m.configOrder {
		if _, live := m.clients[name]; !live {
			missing = append(missing, name)
		}
	}
	return missing
}

// NewToolSet builds another wrapper for every tool on every connected server,
// reusing the existing connections, in config order (registration order feeds
// the tools[] array, which must stay byte-stable for prompt caching).
// Wrappers carry state that a tool registry mutates — the defer flag ApplyMode
// sets — so anything sharing these servers needs its own set rather than the
// one ConnectAll returned.
func (m *Manager) NewToolSet() []tools.Tool {
	m.mu.Lock()
	defer m.mu.Unlock()
	var set []tools.Tool
	for _, name := range m.configOrder {
		defs, ok := m.toolDefs[name]
		if !ok {
			continue
		}
		client, ok := m.clients[name]
		if !ok {
			continue
		}
		for _, td := range defs {
			set = append(set, &MCPToolWrapper{
				serverName: name,
				toolDef:    td,
				client:     client,
			})
		}
	}
	return set
}

func (m *Manager) RegisterAllTools(ctx context.Context, registry *tools.Registry) []ConnectError {
	result := m.ConnectAll(ctx)
	for _, t := range result.Tools {
		registry.Register(t)
	}
	return result.Errors
}

func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, client := range m.clients {
		client.Close()
	}
	m.clients = make(map[string]*Client)
	m.toolDefs = make(map[string][]*mcp.Tool)
	m.servers = make(map[string]ServerInfo)
}

// MCPToolWrapper adapts an MCP tool to the Tool interface

type MCPToolWrapper struct {
	serverName string
	toolDef    *mcp.Tool
	client     *Client
	// noDefer is set by eager mode: when total schema size is small, MCP tools
	// go directly into tools[] without going through ToolSearch
	noDefer bool
}

func (w *MCPToolWrapper) Name() string {
	return MCPToolNamePrefix(w.serverName) + SanitizeName(w.toolDef.Name)
}

func SanitizeName(name string) string {
	return nonAlphanumeric.ReplaceAllString(name, "_")
}

// MCPToolNamePrefix returns the common prefix for all tool names under a given
// server. All code that filters tools by server should use this; hand-building
// the string would miss sanitization — hyphens in server names are replaced
// with underscores.
func MCPToolNamePrefix(serverName string) string {
	return "mcp__" + SanitizeName(serverName) + "__"
}

func (w *MCPToolWrapper) Description() string          { return w.toolDef.Description }
func (w *MCPToolWrapper) Category() tools.ToolCategory { return tools.CategoryCommand }
func (w *MCPToolWrapper) ShouldDefer() bool            { return !w.noDefer }
func (w *MCPToolWrapper) SetDeferLoading(on bool)      { w.noDefer = !on }
func (w *MCPToolWrapper) MCPServerName() string        { return w.serverName }

// MCPInputSchema returns the raw JSON schema. McpCall's argument coercion
// walks it layer by layer.
func (w *MCPToolWrapper) MCPInputSchema() map[string]any {
	if w.toolDef.InputSchema == nil {
		return map[string]any{}
	}
	if m, ok := w.toolDef.InputSchema.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func (w *MCPToolWrapper) Schema() map[string]any {
	inputSchema := w.toolDef.InputSchema
	if inputSchema == nil {
		inputSchema = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	return map[string]any{
		"name":         w.Name(),
		"description":  w.Description(),
		"input_schema": inputSchema,
	}
}

func (w *MCPToolWrapper) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	result, err := w.client.CallTool(ctx, w.toolDef.Name, args)
	if err != nil {
		// TS logs the failure before returning the MCP tool error
		// (tool-wrapper.ts:123).
		log.Error("mcp operation failed", "err", err)
		return tools.ToolResult{Output: fmt.Sprintf("MCP tool error: %s", err), IsError: true}
	}
	return result
}
