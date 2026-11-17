package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/images"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/version"
)

var log = logger.CreateChildLogger("mcp")

const legacyProtocolVersion = "2025-11-25"

type MCPTool struct {
	Name        string
	Description string
	InputSchema map[string]any
	Meta        map[string]any
}

// expandEnv implements Claude-compatible environment expansion. Missing
// required variables fail the connection instead of silently becoming an
// empty command, URL, or credential.
var envRefRe = regexp.MustCompile(`\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}|\$([A-Za-z_]\w*)`)

func ExpandEnv(value string, environment map[string]string) (string, error) {
	var expandErr error
	expanded := envRefRe.ReplaceAllStringFunc(value, func(match string) string {
		groups := envRefRe.FindStringSubmatch(match)
		name := groups[1]
		if name == "" {
			name = groups[3]
		}
		if resolved, ok := environment[name]; ok {
			return resolved
		}
		if groups[2] != "" || strings.Contains(match, ":-") {
			return groups[2]
		}
		expandErr = fmt.Errorf("MCP config references unset environment variable %q", name)
		return match
	})
	if expandErr != nil {
		return "", expandErr
	}
	return expanded, nil
}

func processEnvironment() map[string]string {
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			environment[key] = value
		}
	}
	return environment
}

// ExpandMCPServerConfigEnvironment expands environment references in every
// location supported by project .mcp.json files without mutating the config.
func ExpandMCPServerConfigEnvironment(cfg config.MCPServerConfig, environment map[string]string) (config.MCPServerConfig, error) {
	var err error
	if cfg.Command, err = ExpandEnv(cfg.Command, environment); err != nil {
		return cfg, err
	}
	if cfg.Args != nil {
		args := make([]string, len(cfg.Args))
		for i, arg := range cfg.Args {
			if args[i], err = ExpandEnv(arg, environment); err != nil {
				return cfg, err
			}
		}
		cfg.Args = args
	}
	if cfg.URL, err = ExpandEnv(cfg.URL, environment); err != nil {
		return cfg, err
	}
	if cfg.Env != nil {
		env := make(map[string]string, len(cfg.Env))
		for key, value := range cfg.Env {
			if env[key], err = ExpandEnv(value, environment); err != nil {
				return cfg, err
			}
		}
		cfg.Env = env
	}
	if cfg.Headers != nil {
		headers := make(map[string]string, len(cfg.Headers))
		for key, value := range cfg.Headers {
			if headers[key], err = ExpandEnv(value, environment); err != nil {
				return cfg, err
			}
		}
		cfg.Headers = headers
	}
	return cfg, nil
}

func newHTTPClient(headers map[string]string) *http.Client {
	if len(headers) == 0 {
		return http.DefaultClient
	}
	return &http.Client{
		Transport: &headerRoundTripper{base: http.DefaultTransport, headers: headers},
	}
}

type headerRoundTripper struct {
	base    http.RoundTripper
	headers map[string]string
}

func (h *headerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	for key, value := range h.headers {
		clone.Header.Set(key, value)
	}
	return h.base.RoundTrip(clone)
}

type Client struct {
	Name        string
	config      config.MCPServerConfig
	AppsEnabled bool

	client     *mcp.Client
	session    *mcp.ClientSession
	transport  mcp.Transport
	unregister func()
	tools      map[string]MCPTool
	mu         sync.Mutex
}

func NewClient(cfg config.MCPServerConfig, appsEnabled bool) *Client {
	return &Client{Name: cfg.Name, config: cfg, AppsEnabled: appsEnabled, tools: map[string]MCPTool{}}
}

func (c *Client) Connect(ctx context.Context) error {
	if c.config.Enabled != nil && !*c.config.Enabled {
		return fmt.Errorf("MCP server %q is disabled", c.config.Name)
	}
	cfg, err := ExpandMCPServerConfigEnvironment(c.config, processEnvironment())
	if err != nil {
		return err
	}

	impl := &mcp.Implementation{Name: "yukino", Version: version.Version}
	options := &mcp.ClientOptions{}
	if c.AppsEnabled {
		options.Capabilities = &mcp.ClientCapabilities{
			Extensions: map[string]any{MCPAppsExtension: map[string]any{"mimeTypes": []string{MCPAppMIMEType}}},
		}
	}
	c.client = mcp.NewClient(impl, options)

	switch {
	case cfg.Command != "":
		cmd := exec.Command(cfg.Command, cfg.Args...)
		env := os.Environ()
		for key, value := range cfg.Env {
			env = append(env, key+"="+value)
		}
		cmd.Env = env
		cmd.Stderr = io.Discard
		c.transport = &mcp.CommandTransport{Command: cmd}
	case cfg.URL != "":
		endpoint, err := url.Parse(cfg.URL)
		if err != nil {
			return err
		}
		httpClient := newHTTPClient(cfg.Headers)
		if cfg.Transport == "sse" {
			c.transport = &mcp.SSEClientTransport{Endpoint: endpoint.String(), HTTPClient: httpClient}
		} else {
			c.transport = &mcp.StreamableClientTransport{Endpoint: endpoint.String(), HTTPClient: httpClient}
		}
	default:
		return fmt.Errorf("MCP server '%s': needs either 'command' (stdio) or 'url' (http/sse)", c.Name)
	}

	session, err := c.client.Connect(ctx, c.transport, &mcp.ClientSessionOptions{ProtocolVersion: legacyProtocolVersion})
	if err != nil {
		return fmt.Errorf("connect MCP server %s: %w", c.Name, err)
	}
	c.session = session

	if commandTransport, ok := c.transport.(*mcp.CommandTransport); ok && commandTransport.Command.Process != nil {
		pid := commandTransport.Command.Process.Pid
		if pid > 0 {
			process := commandTransport.Command.Process
			c.unregister = tools.RegisterExitCleanup(func() {
				_ = process.Kill()
			})
		}
	}
	return nil
}

func (c *Client) Instructions() string {
	if c.session == nil {
		return ""
	}
	if result := c.session.InitializeResult(); result != nil {
		return result.Instructions
	}
	return ""
}

func (c *Client) ListTools(ctx context.Context) ([]MCPTool, error) {
	if c.session == nil {
		return nil, fmt.Errorf("%s", MCPNotConnectedError)
	}
	var tools []MCPTool
	seenCursors := map[string]bool{}
	cursor := ""
	for {
		params := &mcp.ListToolsParams{}
		if cursor != "" {
			params.Cursor = cursor
		}
		result, err := c.session.ListTools(ctx, params)
		if err != nil {
			return nil, err
		}
		for _, tool := range result.Tools {
			schema := map[string]any{}
			switch value := tool.InputSchema.(type) {
			case map[string]any:
				for key, item := range value {
					schema[key] = item
				}
			case nil:
			default:
				if data, err := json.Marshal(value); err == nil {
					_ = json.Unmarshal(data, &schema)
				}
			}
			if _, ok := schema["properties"]; !ok {
				schema["properties"] = map[string]any{}
			}
			meta := map[string]any{}
			for key, item := range tool.Meta {
				meta[key] = item
			}
			entry := MCPTool{Name: tool.Name, Description: tool.Description, InputSchema: schema}
			if len(meta) > 0 {
				entry.Meta = meta
			}
			tools = append(tools, entry)
		}
		cursor = result.NextCursor
		if cursor == "" {
			break
		}
		if seenCursors[cursor] {
			return nil, fmt.Errorf("MCP server '%s' repeated tools cursor '%s'", c.Name, cursor)
		}
		seenCursors[cursor] = true
	}

	c.mu.Lock()
	c.tools = make(map[string]MCPTool, len(tools))
	for _, tool := range tools {
		c.tools[tool.Name] = tool
	}
	c.mu.Unlock()

	visible := tools[:0]
	for _, tool := range tools {
		ui, _ := tool.Meta["ui"].(map[string]any)
		visibility, isArray := ui["visibility"].([]any)
		if !isArray {
			visible = append(visible, tool)
			continue
		}
		for _, value := range visibility {
			if value == "model" {
				visible = append(visible, tool)
				break
			}
		}
	}
	return visible, nil
}

func (c *Client) GetTool(name string) (MCPTool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	tool, ok := c.tools[name]
	return tool, ok
}

func (c *Client) ReadResource(ctx context.Context, uri string) (*mcp.ReadResourceResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c.session == nil {
		return nil, fmt.Errorf("%s", MCPNotConnectedError)
	}
	return c.session.ReadResource(ctx, &mcp.ReadResourceParams{URI: uri})
}

func (c *Client) CallToolResult(ctx context.Context, name string, args map[string]any) (*mcp.CallToolResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c.session == nil {
		return nil, fmt.Errorf("%s", MCPNotConnectedError)
	}
	return c.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
}

// CallTool calls a tool and preserves both its text fallback and
// provider-native rich content.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (tools.ToolResult, error) {
	result, err := c.CallToolResult(ctx, name, args)
	if err != nil {
		return tools.ToolResult{}, err
	}
	output, contentBlocks := mcpContentToToolOutput(ctx, result.Content)
	toolResult := tools.ToolResult{Output: output, ContentBlocks: contentBlocks, IsError: result.IsError}
	if c.AppsEnabled {
		if tool, ok := c.GetTool(name); ok {
			if ui, ok := tool.Meta["ui"].(map[string]any); ok {
				if resourceURI, ok := ui["resourceUri"].(string); ok && strings.HasPrefix(resourceURI, MCPAppURIPrefix) {
					toolResult.McpApp = &tools.McpAppResult{
						ServerName:  c.Name,
						ToolName:    name,
						ResourceURI: resourceURI,
						Arguments:   args,
						Result:      result,
					}
				}
			}
		}
	}
	return toolResult, nil
}

func mcpContentToToolOutput(ctx context.Context, content []mcp.Content) (string, []map[string]any) {
	var textParts []string
	var contentBlocks []map[string]any
	hasImage := false

	for _, raw := range content {
		if image, ok := raw.(*mcp.ImageContent); ok {
			if MCPImageMediaTypes[image.MIMEType] {
				mediaType, mediaErr := images.AsImageMediaType(image.MIMEType)
				if mediaErr == nil {
					resized, resizeErr := images.MaybeResizeAndDownsampleImage(ctx, image.Data, mediaType)
					if resizeErr == nil {
						contentBlocks = append(contentBlocks, map[string]any{
							"type": "image",
							"source": map[string]any{
								"type":       "base64",
								"media_type": string(resized.MediaType),
								"data":       resized.Data,
							},
						})
						textParts = append(textParts, "[Image: "+string(resized.MediaType)+"]")
						hasImage = true
						continue
					}
					log.Warn(map[string]any{"err": resizeErr}, "mcp image dropped (too large to fit the API limit)")
				}
				note := "[note: an image returned by the tool was too large and was dropped]"
				textParts = append(textParts, note)
				contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": note})
				continue
			}
			mimeType := image.MIMEType
			if mimeType == "" {
				mimeType = "unknown"
			}
			note := "[Unsupported image: " + mimeType + "]"
			textParts = append(textParts, note)
			contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": note})
			continue
		}

		text := ""
		if textContent, ok := raw.(*mcp.TextContent); ok {
			text = textContent.Text
		} else if data, err := json.Marshal(raw); err == nil && data != nil {
			text = string(data)
		} else {
			text = fmt.Sprintf("%v", raw)
		}
		textParts = append(textParts, text)
		contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": text})
	}

	output := strings.Join(textParts, "\n")
	if !hasImage {
		return output, nil
	}
	return output, contentBlocks
}

func (c *Client) Disconnect() {
	if c.unregister != nil {
		c.unregister()
		c.unregister = nil
	}
	session := c.session
	transport := c.transport
	c.session = nil
	c.transport = nil
	if session == nil {
		return
	}
	if err := session.Close(); err != nil {
		log.Error(map[string]any{"err": err}, "mcp operation failed")
		if closer, ok := transport.(interface{ Close() error }); ok {
			if closeErr := closer.Close(); closeErr != nil {
				log.Error(map[string]any{"err": closeErr}, "mcp transport close failed")
			}
		}
	}
}
