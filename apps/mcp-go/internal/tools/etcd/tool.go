// Package etcd exposes the etcd_tool: an unrestricted passthrough to any etcd
// v3 JSON-gateway endpoint with automatic base64 key/value handling.
package etcd

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const (
	defaultPath    = "/v3/kv/range"
	defaultTimeout = 30_000
)

// Input is the etcd_tool argument schema.
type Input struct {
	BaseURL   string            `json:"base_url,omitempty" jsonschema:"etcd HTTP(S) base URL override, e.g. http://localhost:2379."`
	Path      string            `json:"path,omitempty" jsonschema:"Gateway endpoint path or absolute URL, e.g. /v3/kv/put. Defaults to /v3/kv/range."`
	Method    string            `json:"method,omitempty" jsonschema:"HTTP method: GET, POST, PUT or DELETE. The v3 gateway uses POST for nearly all calls. Defaults to POST."`
	Body      map[string]any    `json:"body,omitempty" jsonschema:"JSON request document. key/range_end/value strings are base64-encoded automatically unless raw_base64 is set."`
	Headers   map[string]string `json:"headers,omitempty" jsonschema:"Additional HTTP headers, e.g. {authorization: '<token>'}."`
	RawBase64 bool              `json:"raw_base64,omitempty" jsonschema:"Disable automatic base64 encoding/decoding of key/range_end/value fields."`
	TimeoutMS int               `json:"timeout_ms,omitempty" jsonschema:"HTTP request timeout in milliseconds. Defaults to 30000."`
}

const description = "Call any etcd v3 JSON-gateway endpoint with full privileges: kv range/put/deleterange/txn/compaction, lease grant/revoke/keepalive/timetolive/leases, auth authenticate/enable/role/user, cluster member add/list/remove/update, and maintenance status/defragment/alarm/hash. There is no endpoint allowlist. Keys, range ends and values are passed as plain UTF-8 strings and base64-encoded for the wire automatically; response keys/values are decoded back to strings (binary values stay base64). Set raw_base64=true to send and receive verbatim base64 instead. path defaults to /v3/kv/range; body is the JSON request document (e.g. {key:'a', range_end:'b'} or {key:'a', value:'v', lease:'0'}). Streaming endpoints (/v3/watch, /v3/maintenance/snapshot) are not supported. Uses ETCD_URL (ETCD_ENDPOINTS fallback) or base_url; pass an auth token via headers.authorization after /v3/auth/authenticate."

// Module returns the etcd tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "etcd",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.EtcdTool,
				Title:       "etcd",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	base := strings.TrimRight(coalesce(in.BaseURL, config.Load().Etcd.URL), "/")
	path := in.Path
	if path == "" {
		path = defaultPath
	}
	method := in.Method
	if method == "" {
		method = "POST"
	}
	timeout := in.TimeoutMS
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if base == "" && !operations.IsAbsoluteHTTP(path) {
		return operations.ResultErr(tools.EtcdTool,
			errors.New("Connection is not configured. Set ETCD_URL (or ETCD_ENDPOINTS) or supply base_url.")), nil, nil
	}

	urlStr := operations.JoinURL(base, path)
	payload := any(in.Body)
	if in.Body == nil {
		payload = map[string]any{}
	}
	if !in.RawBase64 {
		payload = encodeRequestBytes(payload)
	}

	headers := operations.MergeHeaders(map[string]string{"Content-Type": "application/json"}, in.Headers)

	var bodyBytes []byte
	if method != "GET" {
		b, err := json.Marshal(payload)
		if err != nil {
			return operations.ResultErr(tools.EtcdTool, err), nil, nil
		}
		bodyBytes = b
	}

	res, err := operations.Do(ctx, method, urlStr, headers, bodyBytes, timeout)
	if err != nil {
		return operations.ResultErr(tools.EtcdTool, err), nil, nil
	}
	data := operations.ParseJSONOrText(res.Body)
	if !in.RawBase64 {
		data = decodeResponseBytes(data)
	}
	out := operations.Result(map[string]any{"status_code": res.StatusCode, "data": data})
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		operations.WithError(out)
	}
	return out, nil, nil
}

func coalesce(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
