// Package operations holds the shared plumbing used by the backend tool
// modules: the unified result/error envelopes, the connection-URL resolver and
// the tool annotations that mark a tool as unrestricted.
//
// It is a port of apps/mcp/src/tools/operations/shared.ts.
package operations

import (
	"encoding/json"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func boolPtr(b bool) *bool { return &b }

// UnrestrictedAnnotations marks a tool that may read and write its backend with
// the full privileges of the configured account. It mirrors the TypeScript
// unrestrictedAnnotations object.
var UnrestrictedAnnotations = &mcp.ToolAnnotations{
	ReadOnlyHint:    false,
	DestructiveHint: boolPtr(true),
	IdempotentHint:  false,
	OpenWorldHint:   boolPtr(true),
}

// ConnectionURLDescription is the shared description for the connection_url
// override argument.
const ConnectionURLDescription = "Connection URL override; otherwise uses the configured environment variable."

// Result builds the unified success envelope: a JSON text block plus the same
// payload as structuredContent. It mirrors operationResult in the TypeScript
// build, round-tripping through JSON so the text and structured forms agree.
func Result(data any) *mcp.CallToolResult {
	text, err := json.Marshal(data)
	if err != nil {
		text = []byte(`{"error":"failed to serialize result: ` + err.Error() + `"}`)
	}
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: string(text)}},
		StructuredContent: json.RawMessage(text),
	}
}

// ResultErr builds the unified error envelope: a single text block prefixed
// with the tool name and IsError set. It mirrors operationError.
func ResultErr(name string, err error) *mcp.CallToolResult {
	msg := fmt.Sprintf("%s failed: %s", name, errMessage(err))
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
		IsError: true,
	}
}

// WithError returns res with IsError set, mirroring `{...result, isError:true}`.
func WithError(res *mcp.CallToolResult) *mcp.CallToolResult {
	res.IsError = true
	return res
}

// RequireConnection resolves a connection URL from a per-call override or the
// configured environment value, erroring when neither is set. It mirrors
// requireConnection.
func RequireConnection(override, configured, envName string) (string, error) {
	url := override
	if url == "" {
		url = configured
	}
	if url == "" {
		return "", fmt.Errorf("Connection is not configured. Set %s or supply connection_url.", envName)
	}
	return url, nil
}

func errMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// SQLInput is the shared argument schema for the SQL tools (postgres_tool and
// mysql_tool), mirroring sqlInputSchema in the TypeScript build.
type SQLInput struct {
	ConnectionURL string `json:"connection_url,omitempty" jsonschema:"Connection URL override; otherwise uses the configured environment variable."`
	SQL           string `json:"sql" jsonschema:"SQL to execute verbatim, including writes, DDL, administration and multiple statements."`
	Params        []any  `json:"params,omitempty" jsonschema:"Optional positional parameters ($1, $2 for PostgreSQL; ? for MySQL)."`
}
