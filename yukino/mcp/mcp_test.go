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
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/yukino/images"
)

func TestContext7MCP(t *testing.T) {
	cfg := ServerConfig{
		Name:    "context7",
		Command: "npx",
		Args:    []string{"-y", "@upstash/context7-mcp"},
	}

	client := NewClient(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	t.Log("Connecting to context7 MCP server...")
	if err := client.Connect(ctx); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	defer client.Close()
	t.Log("Connected successfully")

	t.Log("Listing tools...")
	tools, err := client.ListTools(ctx)
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}
	t.Logf("Got %d tools:", len(tools))
	for _, tool := range tools {
		t.Logf("  - %s: %s", tool.Name, tool.Description)
	}

	if len(tools) == 0 {
		t.Fatal("No tools returned")
	}

	// Print the input schema of the first tool
	t.Logf("Input schema: %+v", tools[0].InputSchema)

	// Call resolve-library-id with "gin"
	t.Log("Calling resolve-library-id with 'gin'...")
	result, err := client.CallTool(ctx, "resolve-library-id", map[string]any{
		"query":       "gin-gonic/gin",
		"libraryName": "gin",
	})
	if err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}
	t.Logf("isError: %v", result.IsError)
	t.Logf("Result: %s", truncate(result.Output, 500))

	// Test tool name sanitization and schema
	wrapper := &MCPToolWrapper{
		serverName: "context7",
		toolDef:    tools[0],
		client:     client,
	}
	t.Logf("Sanitized tool name: %s", wrapper.Name())

	schema := wrapper.Schema()
	t.Logf("Schema name: %s", schema["name"])
	t.Logf("Schema has description: %v", schema["description"] != nil && schema["description"] != "")
	inputSchema, ok := schema["input_schema"].(map[string]any)
	if !ok {
		t.Fatalf("input_schema is not map[string]any, got %T", schema["input_schema"])
	}
	t.Logf("input_schema type field: %v", inputSchema["type"])
	t.Logf("input_schema has properties: %v", inputSchema["properties"] != nil)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("... (%d bytes total)", len(s))
}

func TestExpandEnv(t *testing.T) {
	t.Setenv("YUKINO_MCP_TEST_VAR", "value")
	t.Setenv("YUKINO_MCP_TEST_EMPTY", "")

	cases := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{"braced set", "${YUKINO_MCP_TEST_VAR}", "value", false},
		{"braced unset", "${YUKINO_MCP_TEST_UNSET}", "", true},
		{"braced unset with default", "${YUKINO_MCP_TEST_UNSET:-fallback}", "fallback", false},
		{"braced unset with empty default", "${YUKINO_MCP_TEST_UNSET:-}", "", false},
		{"braced set ignores default", "${YUKINO_MCP_TEST_VAR:-fallback}", "value", false},
		{"braced set empty value", "${YUKINO_MCP_TEST_EMPTY}", "", false},
		{"braced set empty value ignores default", "${YUKINO_MCP_TEST_EMPTY:-fallback}", "", false},
		{"bare set", "$YUKINO_MCP_TEST_VAR", "value", false},
		{"bare unset", "$YUKINO_MCP_TEST_UNSET", "", true},
		{"embedded refs", "prefix-${YUKINO_MCP_TEST_VAR}/$YUKINO_MCP_TEST_VAR", "prefix-value/value", false},
		{"no refs", "plain string", "plain string", false},
		{"dollar without name", "$", "$", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := expandEnv(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expandEnv(%q) = %q, expected unset-variable error", tc.input, got)
				}
				if !strings.Contains(err.Error(), `unset environment variable "YUKINO_MCP_TEST_UNSET"`) {
					t.Errorf("unexpected error text: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("expandEnv(%q) unexpected error: %v", tc.input, err)
			}
			if got != tc.want {
				t.Errorf("expandEnv(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestExpandMcpServerConfigEnvironment(t *testing.T) {
	t.Setenv("YUKINO_MCP_TEST_CMD", "/usr/bin/env")
	t.Setenv("YUKINO_MCP_TEST_TOKEN", "secret")

	cfg := ServerConfig{
		Name:      "test",
		Command:   "${YUKINO_MCP_TEST_CMD}",
		Args:      []string{"--token", "$YUKINO_MCP_TEST_TOKEN"},
		URL:       "https://example.com/${YUKINO_MCP_TEST_TOKEN}/mcp",
		Transport: "sse",
		Headers:   map[string]string{"Authorization": "Bearer ${YUKINO_MCP_TEST_TOKEN}"},
		Env: map[string]string{
			"TOKEN":    "${YUKINO_MCP_TEST_TOKEN}",
			"FALLBACK": "${YUKINO_MCP_TEST_UNSET_XYZ:-def}",
		},
	}
	got, err := expandMcpServerConfigEnvironment(cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Name != "test" || got.Transport != "sse" {
		t.Errorf("name/transport should pass through, got %q/%q", got.Name, got.Transport)
	}
	if got.Command != "/usr/bin/env" {
		t.Errorf("command = %q", got.Command)
	}
	if len(got.Args) != 2 || got.Args[0] != "--token" || got.Args[1] != "secret" {
		t.Errorf("args = %v", got.Args)
	}
	if got.URL != "https://example.com/secret/mcp" {
		t.Errorf("url = %q", got.URL)
	}
	if got.Headers["Authorization"] != "Bearer secret" {
		t.Errorf("headers = %v", got.Headers)
	}
	if got.Env["TOKEN"] != "secret" || got.Env["FALLBACK"] != "def" {
		t.Errorf("env = %v", got.Env)
	}
	// The original config must not be mutated.
	if cfg.Command != "${YUKINO_MCP_TEST_CMD}" ||
		cfg.Args[1] != "$YUKINO_MCP_TEST_TOKEN" ||
		cfg.Headers["Authorization"] != "Bearer ${YUKINO_MCP_TEST_TOKEN}" ||
		cfg.Env["TOKEN"] != "${YUKINO_MCP_TEST_TOKEN}" {
		t.Error("original config was mutated")
	}

	// Every supported field fails the connection on an unset variable.
	const unset = "${YUKINO_MCP_TEST_DEFINITELY_UNSET}"
	for _, tc := range []struct {
		name string
		cfg  ServerConfig
	}{
		{"command", ServerConfig{Command: unset}},
		{"args", ServerConfig{Args: []string{unset}}},
		{"url", ServerConfig{URL: unset}},
		{"env", ServerConfig{Env: map[string]string{"K": unset}}},
		{"headers", ServerConfig{Headers: map[string]string{"K": unset}}},
	} {
		if _, err := expandMcpServerConfigEnvironment(tc.cfg); err == nil {
			t.Errorf("%s: expected error for unset variable", tc.name)
		}
	}
}

func TestMcpContentToToolOutput(t *testing.T) {
	t.Run("text only", func(t *testing.T) {
		output, blocks := mcpContentToToolOutput([]mcp.Content{
			&mcp.TextContent{Text: "hello"},
			&mcp.TextContent{Text: "world"},
		})
		if output != "hello\nworld" {
			t.Errorf("output = %q", output)
		}
		if blocks != nil {
			t.Errorf("text-only result should carry no content blocks, got %v", blocks)
		}
	})

	t.Run("supported image", func(t *testing.T) {
		output, blocks := mcpContentToToolOutput([]mcp.Content{
			&mcp.TextContent{Text: "before"},
			&mcp.ImageContent{Data: []byte("fake-png"), MIMEType: "image/png"},
		})
		if output != "before\n[Image: image/png]" {
			t.Errorf("output = %q", output)
		}
		if len(blocks) != 2 {
			t.Fatalf("blocks = %d, want 2", len(blocks))
		}
		if blocks[0]["type"] != "text" || blocks[0]["text"] != "before" {
			t.Errorf("block 0 = %v", blocks[0])
		}
		img := blocks[1]
		if img["type"] != "image" {
			t.Fatalf("block 1 = %v", img)
		}
		src, ok := img["source"].(map[string]any)
		if !ok {
			t.Fatalf("source = %v", img["source"])
		}
		if src["type"] != "base64" || src["media_type"] != "image/png" {
			t.Errorf("source = %v", src)
		}
		if src["data"] != base64.StdEncoding.EncodeToString([]byte("fake-png")) {
			t.Errorf("data = %v", src["data"])
		}
	})

	t.Run("unsupported image mime", func(t *testing.T) {
		output, blocks := mcpContentToToolOutput([]mcp.Content{
			&mcp.ImageContent{Data: []byte("x"), MIMEType: "image/tiff"},
		})
		if output != "[Unsupported image: image/tiff]" {
			t.Errorf("output = %q", output)
		}
		if blocks != nil {
			t.Errorf("no surviving image → no content blocks, got %v", blocks)
		}
	})

	t.Run("empty image mime", func(t *testing.T) {
		output, _ := mcpContentToToolOutput([]mcp.Content{
			&mcp.ImageContent{Data: []byte("x")},
		})
		if output != "[Unsupported image: unknown]" {
			t.Errorf("output = %q", output)
		}
	})

	t.Run("oversized image dropped", func(t *testing.T) {
		huge := make([]byte, images.MaxImageBytesPassthrough+1)
		output, blocks := mcpContentToToolOutput([]mcp.Content{
			&mcp.ImageContent{Data: huge, MIMEType: "image/png"},
		})
		if output != "[note: an image returned by the tool was too large and was dropped]" {
			t.Errorf("output = %q", output)
		}
		if blocks != nil {
			t.Errorf("dropped image → no content blocks, got %v", blocks)
		}
	})

	t.Run("non-text content serialized", func(t *testing.T) {
		output, blocks := mcpContentToToolOutput([]mcp.Content{
			&mcp.AudioContent{Data: []byte("a"), MIMEType: "audio/wav"},
		})
		if !strings.Contains(output, `"type":"audio"`) || !strings.Contains(output, `"mimeType":"audio/wav"`) {
			t.Errorf("output = %q", output)
		}
		if blocks != nil {
			t.Errorf("no image → no content blocks, got %v", blocks)
		}
	})

	t.Run("empty content", func(t *testing.T) {
		output, blocks := mcpContentToToolOutput([]mcp.Content{})
		if output != "" {
			t.Errorf("output = %q, want empty (TS has no fallback text)", output)
		}
		if blocks != nil {
			t.Errorf("blocks = %v", blocks)
		}
	})
}

func TestConnectAllDeterministicOrder(t *testing.T) {
	m := NewManager()
	m.LoadConfigs([]ServerConfig{
		{Name: "zeta", Command: "yukino-mcp-test-missing-command"},
		{Name: "alpha", Command: "yukino-mcp-test-missing-command"},
		{Name: "mid", Command: "yukino-mcp-test-missing-command"},
	})
	res := m.ConnectAll(context.Background())
	if len(res.Errors) != 3 {
		t.Fatalf("expected 3 errors, got %d: %v", len(res.Errors), res.Errors)
	}
	// TS connectAllNow iterates its configs array, so errors surface in
	// config order, not alphabetical order.
	for i, name := range []string{"zeta", "alpha", "mid"} {
		if res.Errors[i].ServerName != name {
			t.Errorf("error %d should name %q, got: %+v", i, name, res.Errors[i])
		}
		// The message is the raw transport/config error, exactly like TS's
		// asErrorString(err) — the server identity is the struct field, not a
		// prefix added by the manager.
		if res.Errors[i].Error == "" {
			t.Errorf("error %d should carry a message", i)
		}
	}
}

// startTestMCPServer spins up an in-process streamable-HTTP MCP server so
// Reconcile can be exercised over real connections without external commands.
func startTestMCPServer(t *testing.T, name string) *httptest.Server {
	t.Helper()
	srv := mcp.NewServer(&mcp.Implementation{Name: name, Version: "0.0.1"}, nil)
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, nil)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return ts
}

func equalNames(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestReconcileClassifiesServers(t *testing.T) {
	srvA := startTestMCPServer(t, "alpha")
	srvB := startTestMCPServer(t, "beta")
	srvC := startTestMCPServer(t, "gamma")

	cfgA := ServerConfig{Name: "alpha", URL: srvA.URL}
	cfgB := ServerConfig{Name: "beta", URL: srvB.URL}

	m := NewManager()
	// Close the MCP clients before the httptest servers are torn down: the SSE
	// connections they hold otherwise make httptest.Server.Close block until
	// the package deadline.
	t.Cleanup(m.Shutdown)
	m.LoadConfigs([]ServerConfig{cfgA, cfgB})
	if res := m.ConnectAll(context.Background()); len(res.Errors) != 0 || len(res.Servers) != 2 {
		t.Fatalf("initial connect: servers=%d errors=%v", len(res.Servers), res.Errors)
	}
	clientA := m.clients["alpha"]

	// Identical configs: everything unchanged, live connections untouched.
	same := m.Reconcile(context.Background(), []ServerConfig{cfgA, cfgB})
	if len(same.Errors) != 0 {
		t.Fatalf("unchanged reconcile errored: %v", same.Errors)
	}
	if !equalNames(same.Unchanged, []string{"alpha", "beta"}) {
		t.Errorf("unchanged = %v, want [alpha beta]", same.Unchanged)
	}
	if len(same.Added) != 0 || len(same.Removed) != 0 || len(same.Restarted) != 0 {
		t.Errorf("expected no added/removed/restarted, got %v/%v/%v", same.Added, same.Removed, same.Restarted)
	}
	if m.clients["alpha"] != clientA {
		t.Error("unchanged server was reconnected")
	}

	// alpha gains a header (restart), beta disappears (remove), gamma is new
	// (add). The restarted alpha must not be reported as added.
	cfgA2 := ServerConfig{Name: "alpha", URL: srvA.URL, Headers: map[string]string{"X-Reconcile": "1"}}
	cfgC := ServerConfig{Name: "gamma", URL: srvC.URL}
	r := m.Reconcile(context.Background(), []ServerConfig{cfgA2, cfgC})
	if len(r.Errors) != 0 {
		t.Fatalf("reconcile errored: %v", r.Errors)
	}
	if !equalNames(r.Restarted, []string{"alpha"}) {
		t.Errorf("restarted = %v, want [alpha]", r.Restarted)
	}
	if !equalNames(r.Removed, []string{"beta"}) {
		t.Errorf("removed = %v, want [beta]", r.Removed)
	}
	if !equalNames(r.Added, []string{"gamma"}) {
		t.Errorf("added = %v, want [gamma]", r.Added)
	}
	if len(r.Unchanged) != 0 {
		t.Errorf("unchanged = %v, want empty", r.Unchanged)
	}
	if m.clients["alpha"] == clientA {
		t.Error("changed server kept its old connection")
	}
	if _, ok := m.clients["beta"]; ok {
		t.Error("removed server is still connected")
	}
	if got := m.ConnectedServers(); len(got) != 2 {
		t.Errorf("connected = %v, want alpha+gamma", got)
	}
	if missing := m.MissingServers(); len(missing) != 0 {
		t.Errorf("missing = %v, want none", missing)
	}

	// The desired set was replaced wholesale: a follow-up ConnectAll must not
	// bring beta back.
	if res := m.ConnectAll(context.Background()); len(res.Servers) != 0 {
		t.Errorf("ConnectAll after reconcile reconnected %v", res.Servers)
	}
}

func TestReconcileReportsFailedRestart(t *testing.T) {
	srv := startTestMCPServer(t, "alpha")
	m := NewManager()
	m.LoadConfigs([]ServerConfig{{Name: "alpha", URL: srv.URL}})
	if res := m.ConnectAll(context.Background()); len(res.Errors) != 0 {
		t.Fatalf("initial connect: %v", res.Errors)
	}

	// Point alpha at a dead endpoint: the restart is attempted, fails, and is
	// reported both in Restarted (classification) and Errors (connect pass).
	dead := ServerConfig{Name: "alpha", URL: "http://127.0.0.1:1/mcp"}
	r := m.Reconcile(context.Background(), []ServerConfig{dead})
	if !equalNames(r.Restarted, []string{"alpha"}) {
		t.Errorf("restarted = %v, want [alpha]", r.Restarted)
	}
	if len(r.Errors) != 1 {
		t.Errorf("errors = %v, want the failed reconnect", r.Errors)
	}
	if len(r.Added) != 0 {
		t.Errorf("added = %v, want empty", r.Added)
	}
	if _, ok := m.clients["alpha"]; ok {
		t.Error("failed server should not stay connected")
	}
	if missing := m.MissingServers(); !equalNames(missing, []string{"alpha"}) {
		t.Errorf("missing = %v, want [alpha] so the next pass retries it", missing)
	}
}
