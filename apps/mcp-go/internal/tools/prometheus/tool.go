// Package prometheus exposes the prometheus_tool: an unrestricted HTTP
// passthrough to any Prometheus endpoint.
package prometheus

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const (
	defaultPath    = "/api/v1/alerts"
	defaultTimeout = 30_000
)

// Input is the prometheus_tool argument schema.
type Input struct {
	BaseURL   string            `json:"base_url,omitempty" jsonschema:"Prometheus server base URL override, including an optional reverse-proxy prefix."`
	Path      string            `json:"path,omitempty" jsonschema:"HTTP endpoint path or absolute URL. Defaults to /api/v1/alerts."`
	Method    string            `json:"method,omitempty" jsonschema:"HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS. Defaults to GET."`
	Params    map[string]any    `json:"params,omitempty" jsonschema:"Query parameters, e.g. {query: 'up', time: 1700000000} or {'match[]': ['up', 'process_cpu_seconds_total']}."`
	Body      any               `json:"body,omitempty" jsonschema:"JSON body, or a string sent verbatim for form-encoded requests. Set content-type through headers when using raw text."`
	Headers   map[string]string `json:"headers,omitempty" jsonschema:"Additional HTTP headers; override configured authentication if needed."`
	TimeoutMS int               `json:"timeout_ms,omitempty" jsonschema:"HTTP request timeout in milliseconds. Defaults to 30000."`
}

const description = "Call any Prometheus HTTP endpoint and method. Defaults to /api/v1/alerts; use /api/v1/query or query_range for PromQL, /api/v1/targets, rules, labels, label/{name}/values, series or metadata for inspection, and admin/tsdb endpoints or /-/reload for administration. params encodes query parameters (arrays repeat the key, e.g. match[]); body accepts raw form text or JSON. Returns full JSON responses including labels/annotations, or text for non-JSON endpoints. No endpoint/method restrictions. Uses PROMETHEUS_BASE_URL (PROMETHEUS_URL fallback) or base_url; supports bearer/basic authentication and custom headers."

// Module returns the prometheus tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "prometheus",
		Register: func(server *mcp.Server) {
			mcp.AddTool(server, &mcp.Tool{
				Name:        tools.Prometheus,
				Title:       "Prometheus",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	cfg := config.Load().Prometheus
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
	outcome, err := operations.RunHTTPPassthrough(ctx, cfg.BaseURL, "PROMETHEUS_BASE_URL",
		operations.HTTPPassthroughAuth{Token: cfg.Token, Username: cfg.Username, Password: cfg.Password},
		operations.HTTPPassthroughRequest{
			BaseURL:   in.BaseURL,
			Path:      path,
			Method:    method,
			Params:    in.Params,
			Body:      in.Body,
			Headers:   in.Headers,
			TimeoutMS: timeout,
		},
		func(payload any) bool {
			m, ok := payload.(map[string]any)
			if !ok {
				return false
			}
			s, _ := m["status"].(string)
			return s == "error"
		})
	if err != nil {
		return operations.ResultErr(tools.Prometheus, err), nil, nil
	}
	res := operations.Result(map[string]any{"status_code": outcome.StatusCode, "data": outcome.Data})
	if outcome.IsError {
		operations.WithError(res)
	}
	return res, nil, nil
}
