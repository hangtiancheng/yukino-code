// Package grafana exposes the grafana_tool: an unrestricted HTTP passthrough
// to any Grafana API endpoint.
package grafana

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const (
	defaultPath    = "/api/health"
	defaultTimeout = 30_000
)

// Input is the grafana_tool argument schema.
type Input struct {
	BaseURL   string            `json:"base_url,omitempty" jsonschema:"Grafana base URL override, including an optional reverse-proxy prefix."`
	Path      string            `json:"path,omitempty" jsonschema:"Grafana HTTP API path or absolute URL, e.g. /api/search or /api/dashboards/uid/abc123. Defaults to /api/health."`
	Method    string            `json:"method,omitempty" jsonschema:"HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS. Defaults to GET."`
	Params    map[string]any    `json:"params,omitempty" jsonschema:"Query parameters, e.g. {query: 'my-dashboard'} for /api/search or {from: 'now-6h', to: 'now'}."`
	Body      json.RawMessage   `json:"body,omitempty" jsonschema:"JSON body for POST/PUT APIs (dashboard models, /api/ds/query requests, annotations), or a string sent verbatim. Set content-type through headers when using raw text."`
	Headers   map[string]string `json:"headers,omitempty" jsonschema:"Additional HTTP headers; override configured authentication if needed."`
	TimeoutMS int               `json:"timeout_ms,omitempty" jsonschema:"HTTP request timeout in milliseconds. Defaults to 30000."`
}

const description = "Call any Grafana HTTP API endpoint and method. Defaults to /api/health. Use /api/search to list dashboards and folders, /api/dashboards/uid/{uid} to fetch a dashboard (GET) or save one (POST with a dashboard model), /api/folders, /api/datasources and /api/datasources/{id} for provisioning, /api/ds/query to run proxied datasource queries, /api/annotations, /api/ruler/grafana/api/v1/rules and /api/v1/provisioning/* for alerting, and /api/admin, /api/org, /api/users, /api/serviceaccounts for administration. params encodes query parameters (arrays repeat the key); body accepts JSON (dashboard models, ds/query payloads) or a raw string sent verbatim. Returns full JSON responses, or text for non-JSON endpoints. No endpoint/method restrictions; Grafana RBAC and the credential's role still govern what succeeds. Uses grafana.base_url or base_url; supports bearer authentication (service-account token or API key) or basic authentication, plus custom headers such as X-Grafana-Org-Id."

// Module returns the grafana tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "grafana",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.Grafana,
				Title:       "Grafana",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	cfg := config.Load().Grafana
	path := in.Path
	if path == "" {
		path = defaultPath
	}
	method := in.Method
	if method == "" {
		method = "GET"
	}
	timeout := in.TimeoutMS
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	outcome, err := operations.RunHTTPPassthrough(ctx, cfg.BaseURL, "grafana.base_url",
		operations.HTTPPassthroughAuth{Token: cfg.Token, Username: cfg.Username, Password: cfg.Password},
		operations.HTTPPassthroughRequest{
			BaseURL:   in.BaseURL,
			Path:      path,
			Method:    method,
			Params:    in.Params,
			Body:      in.Body,
			Headers:   in.Headers,
			TimeoutMS: timeout,
		}, nil)
	if err != nil {
		return operations.ResultErr(tools.Grafana, err), nil, nil
	}
	res := operations.Result(map[string]any{"status_code": outcome.StatusCode, "data": outcome.Data})
	if outcome.IsError {
		operations.WithError(res)
	}
	return res, nil, nil
}
