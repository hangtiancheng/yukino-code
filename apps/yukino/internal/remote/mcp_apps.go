package remote

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

const (
	MCPAppExpired           = "This app is no longer connected to its MCP server. Generate it again."
	MCPAppToolUnavailable   = "This tool is not available to the app."
	MCPAppPermissionDenied  = "Permission denied."
	MCPAppAgentDisconnected = "Agent is not connected."
)

type mcpAppHandle struct {
	SessionID  string
	Cwd        string
	MCPManager *mcp.Manager
	Checker    *permissions.Checker
	Hooks      *hooks.Engine
	ToolFilter func(string) bool
}

type mcpAppEntry struct {
	payload   mcp.McpAppToolResult
	client    *mcp.Client
	sessionID string
}

type remoteMcpApps struct {
	mu       sync.Mutex
	apps     map[string]mcpAppEntry
	requests map[uint64]context.CancelFunc
	nextID   uint64
}

func newRemoteMcpApps() *remoteMcpApps {
	return &remoteMcpApps{apps: map[string]mcpAppEntry{}, requests: map[uint64]context.CancelFunc{}}
}

func (r *remoteMcpApps) Register(payload mcp.McpAppToolResult, handle mcpAppHandle) {
	if payload.McpApp == nil || handle.MCPManager == nil {
		return
	}
	client := handle.MCPManager.GetClient(payload.McpApp.ServerName)
	if client == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.apps[payload.ToolID] = mcpAppEntry{payload: payload, client: client, sessionID: handle.SessionID}
}

func (r *remoteMcpApps) Entries() []mcp.McpAppToolResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	entries := make([]mcp.McpAppToolResult, 0, len(r.apps))
	for _, entry := range r.apps {
		entries = append(entries, entry.payload)
	}
	return entries
}

func (r *remoteMcpApps) Clear() {
	r.mu.Lock()
	r.apps = map[string]mcpAppEntry{}
	controllers := make([]context.CancelFunc, 0, len(r.requests))
	for _, cancel := range r.requests {
		controllers = append(controllers, cancel)
	}
	r.requests = map[uint64]context.CancelFunc{}
	r.mu.Unlock()
	for _, cancel := range controllers {
		cancel()
	}
}

func (r *remoteMcpApps) Request(ctx context.Context, request mcp.McpAppRequest, handle mcpAppHandle, onPermission tools.PermissionHandler) (any, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	r.mu.Lock()
	r.nextID++
	requestID := r.nextID
	r.requests[requestID] = cancel
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.requests, requestID)
		r.mu.Unlock()
	}()

	validate := func() (mcpAppEntry, error) {
		if err := ctx.Err(); err != nil {
			return mcpAppEntry{}, err
		}
		r.mu.Lock()
		entry, ok := r.apps[request.AppID]
		r.mu.Unlock()
		if !ok || entry.sessionID != handle.SessionID || entry.payload.McpApp == nil ||
			handle.MCPManager == nil || handle.MCPManager.GetClient(entry.payload.McpApp.ServerName) != entry.client {
			return mcpAppEntry{}, errors.New(MCPAppExpired)
		}
		return entry, nil
	}

	entry, err := validate()
	if err != nil {
		return nil, err
	}
	if request.Method == "read_resource" {
		uri, _ := request.Params["uri"].(string)
		return entry.client.ReadResource(ctx, uri)
	}
	name, _ := request.Params["name"].(string)
	args, _ := request.Params["arguments"].(map[string]any)
	if args == nil {
		args = map[string]any{}
	}
	tool, ok := entry.client.GetTool(name)
	if !ok {
		return nil, errors.New(MCPAppToolUnavailable)
	}
	if ui, ok := tool.Meta["ui"].(map[string]any); ok {
		if visibility, isArray := ui["visibility"].([]any); isArray {
			visible := false
			for _, value := range visibility {
				if value == "app" {
					visible = true
					break
				}
			}
			if !visible {
				return nil, errors.New(MCPAppToolUnavailable)
			}
		}
	}
	toolName := mcp.BuildMCPToolName(entry.payload.McpApp.ServerName, name)
	if handle.ToolFilter != nil && !handle.ToolFilter(toolName) {
		return nil, errors.New(MCPAppToolUnavailable)
	}
	if handle.Hooks != nil {
		rejected, reason := handle.Hooks.FirePreToolHooks(toolName, args, hooks.HookRuntimeOptions{Cwd: handle.Cwd, Abort: ctx})
		if rejected {
			return nil, fmt.Errorf("Rejected by hook: %s", reason)
		}
	}
	if handle.Checker == nil {
		return nil, errors.New(MCPAppPermissionDenied)
	}
	decision := handle.Checker.CheckNamed(toolName, tools.CategoryCommand, args)
	if decision.Effect == permissions.Deny {
		return nil, fmt.Errorf("Permission denied: %s", decision.Reason)
	}
	if decision.Effect == permissions.Ask {
		patterns := handle.Checker.RememberPatterns(toolName, args)
		desc := formatMcpPermissionDesc(args, decision)
		response := onPermission(ctx, tools.PermissionRequest{ToolName: toolName, Desc: desc, Args: args, RememberPatterns: patterns, ToolCallID: request.RequestID})
		if _, validateErr := validate(); validateErr != nil {
			return nil, validateErr
		}
		if response == int(permissionsResponseDeny) {
			return nil, errors.New(MCPAppPermissionDenied)
		}
		if response == int(permissionsResponseAllowAlways) {
			_ = handle.Checker.AllowAlways(toolName, args, patterns)
		}
	}
	if _, err := validate(); err != nil {
		return nil, err
	}
	return entry.client.CallToolResult(ctx, name, args)
}

type permissionsResponse int

const (
	permissionsResponseAllow permissionsResponse = iota
	permissionsResponseDeny
	permissionsResponseAllowAlways
)

func formatMcpPermissionDesc(args map[string]any, decision permissions.Decision) string {
	var parts []string
	if decision.Reason != "" {
		parts = append(parts, decision.Reason)
	}
	if command, ok := args["command"].(string); ok && command != "" {
		parts = append(parts, "Command: "+command)
	} else if path, ok := args["file_path"].(string); ok && path != "" {
		parts = append(parts, "File: "+path)
	}
	return strings.Join(parts, "\n")
}
