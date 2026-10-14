// Package clickhouse exposes the clickhouse_tool: arbitrary ClickHouse SQL
// over the HTTP interface.
package clickhouse

import (
	"context"
	"encoding/base64"
	"net/url"
	"regexp"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const defaultTimeout = 30_000

var jsonFormatRE = regexp.MustCompile(`(?i)^JSON`)

// Input is the clickhouse_tool argument schema.
type Input struct {
	ConnectionURL string            `json:"connection_url,omitempty" jsonschema:"Connection URL override; otherwise uses the JSON configuration."`
	SQL           string            `json:"sql" jsonschema:"SQL statement to execute verbatim."`
	Params        map[string]any    `json:"params,omitempty" jsonschema:"Parameterized-query values, sent as param_<name> for {name:Type} placeholders."`
	Settings      map[string]any    `json:"settings,omitempty" jsonschema:"ClickHouse settings passed as query parameters, e.g. {max_execution_time: 10, readonly: 1}."`
	Database      string            `json:"database,omitempty" jsonschema:"Database override (clickhouse.database fallback)."`
	Format        string            `json:"format,omitempty" jsonschema:"default_format for results when the SQL has no FORMAT clause. Defaults to JSON."`
	Data          *string           `json:"data,omitempty" jsonschema:"Raw data body for INSERT ... FORMAT <fmt>; the SQL moves to the query parameter."`
	DataBase64    *string           `json:"data_base64,omitempty" jsonschema:"Base64-encoded data body for binary INSERT formats."`
	User          string            `json:"user,omitempty" jsonschema:"User override."`
	Password      *string           `json:"password,omitempty" jsonschema:"Password override, including an empty password."`
	APIKey        string            `json:"api_key,omitempty" jsonschema:"Send X-ClickHouse-Key instead of basic auth."`
	Headers       map[string]string `json:"headers,omitempty" jsonschema:"Additional HTTP headers."`
	Stacktrace    bool              `json:"stacktrace,omitempty" jsonschema:"Request a server stack trace on errors."`
	TimeoutMS     int               `json:"timeout_ms,omitempty" jsonschema:"HTTP request timeout in milliseconds. Defaults to 30000."`
}

const description = "Execute arbitrary ClickHouse SQL over the HTTP interface with the account's full privileges: queries, inserts, DDL, mutations, system and administrative statements. There is no SQL allowlist or read-only mode. SELECT results are returned parsed when the output format is JSON-family (default_format defaults to JSON; override with format, e.g. JSONEachRow, CSV, TSV, Pretty). For INSERT ... FORMAT <fmt>, pass the SQL in sql and the rows in data (or data_base64); the query is sent as a parameter and the data as the body. Parameterized queries use params, mapped to ClickHouse param_<name> settings for {name:Type} placeholders. Extra engine settings (max_execution_time, readonly, etc.) go in settings. Uses clickhouse.url or connection_url; credentials from clickhouse.username/clickhouse.password, database from clickhouse.database."

// Module returns the clickhouse tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "clickhouse",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.Clickhouse,
				Title:       "ClickHouse",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	cfg := config.Load().Clickhouse
	base, err := operations.RequireConnection(in.ConnectionURL, cfg.URL, "clickhouse.url")
	if err != nil {
		return operations.ResultErr(tools.Clickhouse, err), nil, nil
	}
	base = strings.TrimRight(base, "/")

	user := firstNonEmpty(in.User, cfg.Username)
	password := cfg.Password
	if in.Password != nil {
		password = *in.Password
	}
	database := firstNonEmpty(in.Database, cfg.Database)
	format := in.Format
	if format == "" {
		format = "JSON"
	}
	timeout := in.TimeoutMS
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	parsed, err := url.Parse(base)
	if err != nil {
		return operations.ResultErr(tools.Clickhouse, err), nil, nil
	}
	query := parsed.Query()
	if database != "" {
		query.Set("database", database)
	}
	for _, k := range operations.SortedKeys(in.Params) {
		query.Set("param_"+k, operations.JSONValueToString(in.Params[k]))
	}
	for _, k := range operations.SortedKeys(in.Settings) {
		query.Set(k, operations.JSONValueToString(in.Settings[k]))
	}
	query.Set("default_format", format)
	if in.Stacktrace {
		query.Set("stacktrace", "1")
	}

	headers := map[string]string{}
	// Send credentials through exactly one channel: ClickHouse rejects requests
	// carrying them in both the query string and the Authorization header.
	if in.APIKey != "" {
		headers["X-ClickHouse-Key"] = in.APIKey
		if user != "" {
			headers["X-ClickHouse-User"] = user
		}
	} else if user != "" || password != "" {
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
	}
	headers = operations.MergeHeaders(headers, in.Headers)

	var body []byte
	if in.Data != nil || in.DataBase64 != nil {
		// INSERT-style: query in the URL, data in the body.
		query.Set("query", in.SQL)
		if in.DataBase64 != nil {
			body = operations.DecodeBase64(*in.DataBase64)
		} else {
			body = []byte(*in.Data)
			headers["Content-Type"] = "text/plain; charset=utf-8"
		}
	} else {
		body = []byte(in.SQL)
		headers["Content-Type"] = "text/plain; charset=utf-8"
	}
	parsed.RawQuery = query.Encode()

	res, err := operations.Do(ctx, "POST", parsed.String(), headers, body, timeout)
	if err != nil {
		return operations.ResultErr(tools.Clickhouse, err), nil, nil
	}

	text := operations.DecodeUTF8(res.Body)
	var data any = text
	if jsonFormatRE.MatchString(format) && strings.TrimSpace(text) != "" {
		data = operations.ParseJSONOrText(res.Body)
	}
	out := operations.Result(map[string]any{"status_code": res.StatusCode, "format": format, "data": data})
	if res.StatusCode < 200 || res.StatusCode >= 300 {
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
