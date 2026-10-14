// Package milvus exposes the milvus_tool: an unrestricted passthrough to any
// Milvus RESTful API v2 endpoint.
package milvus

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/operations"
)

const (
	defaultPath    = "/v2/vectordb/collections/list"
	defaultTimeout = 30_000
)

// Input is the milvus_tool argument schema.
type Input struct {
	BaseURL   string            `json:"base_url,omitempty" jsonschema:"Milvus base URL override, e.g. http://localhost:19530."`
	Path      string            `json:"path,omitempty" jsonschema:"REST endpoint path or absolute URL. Defaults to /v2/vectordb/collections/list."`
	Method    string            `json:"method,omitempty" jsonschema:"HTTP method: GET, POST, PUT or DELETE. Milvus v2 uses POST for most operations. Defaults to POST."`
	Body      map[string]any    `json:"body,omitempty" jsonschema:"JSON request document, e.g. {collectionName:'demo', data:[...]}."`
	Database  string            `json:"database,omitempty" jsonschema:"Database name injected as dbName in the body (milvus.database fallback)."`
	Token     string            `json:"token,omitempty" jsonschema:"Bearer token override, formatted as username:password or an API key."`
	Headers   map[string]string `json:"headers,omitempty" jsonschema:"Additional HTTP headers."`
	TimeoutMS int               `json:"timeout_ms,omitempty" jsonschema:"HTTP request timeout in milliseconds. Defaults to 30000."`
}

const description = "Call any Milvus RESTful API v2 endpoint with full privileges: collections (list/create/describe/drop/has/load/release/rename/alter), entities (insert/upsert/delete/get/query/search/hybrid_search), indexes, partitions, databases, aliases, users/roles/grants, import and jobs. There is no endpoint allowlist. path defaults to /v2/vectordb/collections/list and method to POST; body is the JSON request document. Set database to inject dbName into the body, or include dbName yourself. Authentication uses a Bearer token from milvus.token or milvus.username:milvus.password (override with token). Responses return {status_code, data}; a non-zero Milvus code or non-2xx status sets isError. Uses milvus.url or base_url. The REST API shares the gRPC port (default 19530); health/metrics live on 9091 and can be reached with an absolute base_url."

// Module returns the milvus tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "milvus",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.MilvusTool,
				Title:       "Milvus",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	cfg := config.Load().Milvus
	base := strings.TrimRight(firstNonEmpty(in.BaseURL, cfg.URL), "/")
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
		return operations.ResultErr(tools.MilvusTool,
			errors.New("Connection is not configured. Set milvus.url or supply base_url.")), nil, nil
	}
	urlStr := operations.JoinURL(base, path)

	payload := map[string]any{}
	for k, v := range in.Body {
		payload[k] = v
	}
	dbName := firstNonEmpty(in.Database, cfg.Database)
	if dbName != "" {
		if _, exists := payload["dbName"]; !exists {
			payload["dbName"] = dbName
		}
	}

	headers := map[string]string{"Content-Type": "application/json", "Accept": "application/json"}
	bearer := firstNonEmpty(in.Token, cfg.Token)
	if bearer != "" {
		headers["Authorization"] = "Bearer " + bearer
	}
	headers = operations.MergeHeaders(headers, in.Headers)

	var bodyBytes []byte
	if method != "GET" {
		b, err := json.Marshal(payload)
		if err != nil {
			return operations.ResultErr(tools.MilvusTool, err), nil, nil
		}
		bodyBytes = b
	}

	res, err := operations.Do(ctx, method, urlStr, headers, bodyBytes, timeout)
	if err != nil {
		return operations.ResultErr(tools.MilvusTool, err), nil, nil
	}
	data := operations.ParseJSONOrText(res.Body)
	milvusError := false
	if m, ok := data.(map[string]any); ok {
		if code, ok := m["code"].(float64); ok && code != 0 {
			milvusError = true
		}
	}
	out := operations.Result(map[string]any{"status_code": res.StatusCode, "data": data})
	if res.StatusCode < 200 || res.StatusCode >= 300 || milvusError {
		operations.WithError(out)
	}
	return out, nil, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
