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

package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeMCPJSON(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadProjectMcpServersAbsentFile(t *testing.T) {
	if got := LoadProjectMcpServers(t.TempDir()); got != nil {
		t.Fatalf("absent file must yield nil, got %v", got)
	}
}

func TestLoadProjectMcpServersMapsTransports(t *testing.T) {
	dir := t.TempDir()
	writeMCPJSON(t, dir, `{
		"mcpServers": {
			"db": {"command": "npx", "args": ["-y", "db-mcp"], "env": {"API_KEY": "${DB_KEY}"}},
			"web": {"url": "https://example.com/mcp"},
			"legacy": {"type": "sse", "url": "https://example.com/sse", "headers": {"A": "b"}}
		}
	}`)

	got := LoadProjectMcpServers(dir)
	// TS keeps JSON insertion order (Object.entries); the port must too —
	// the server list feeds connect order and prompt text.
	want := []MCPServerConfig{
		{Name: "db", Command: "npx", Args: []string{"-y", "db-mcp"}, Env: map[string]string{"API_KEY": "${DB_KEY}"}},
		{Name: "web", URL: "https://example.com/mcp", Transport: "http"},
		{Name: "legacy", URL: "https://example.com/sse", Transport: "sse", Headers: map[string]string{"A": "b"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapping wrong:\n got %+v\nwant %+v", got, want)
	}
}

// TestLoadProjectMcpServersPresenceSemantics pins the TS `!== undefined`
// boundaries: an empty-string command still counts as present (so it selects
// the stdio branch and then fails its non-empty check), and a present command
// rejects an otherwise valid url entry.
func TestLoadProjectMcpServersPresenceSemantics(t *testing.T) {
	dir := t.TempDir()
	writeMCPJSON(t, dir, `{
		"mcpServers": {
			"emptyCommand": {"command": ""},
			"emptyCommandWithUrl": {"url": "https://example.com/mcp", "command": ""},
			"typedHttpWithEmptyCommand": {"type": "http", "url": "https://example.com/mcp", "command": ""},
			"emptyUrl": {"url": ""},
			"bogusType": {"type": "websocket", "url": "https://example.com/mcp"},
			"ok": {"url": "https://example.com/ok"}
		}
	}`)

	got := LoadProjectMcpServers(dir)
	if len(got) != 1 || got[0].Name != "ok" || got[0].Transport != "http" {
		t.Fatalf("only the ok entry should survive, got %+v", got)
	}
}

func TestLoadProjectMcpServersSkipsUnmappable(t *testing.T) {
	dir := t.TempDir()
	writeMCPJSON(t, dir, `{
		"mcpServers": {
			"empty": {},
			"noUrl": {"type": "http"},
			"noCommand": {"type": "stdio", "args": ["x"]},
			"ambiguous": {"command": "stdio", "url": "https://example.com/mcp"},
			"ok": {"command": "true"}
		}
	}`)

	got := LoadProjectMcpServers(dir)
	if len(got) != 1 || got[0].Name != "ok" || got[0].Command != "true" {
		t.Fatalf("only the ok entry should survive, got %+v", got)
	}
}

func TestLoadProjectMcpServersMalformed(t *testing.T) {
	dir := t.TempDir()
	writeMCPJSON(t, dir, "{not json")
	if got := LoadProjectMcpServers(dir); got != nil {
		t.Fatalf("malformed JSON must yield nil, got %v", got)
	}
	// Wrong field type on the only entry → nothing loadable.
	writeMCPJSON(t, dir, `{"mcpServers": {"bad": {"command": 42}}}`)
	if got := LoadProjectMcpServers(dir); len(got) != 0 {
		t.Fatalf("schema violation must yield no servers, got %v", got)
	}
}

func TestLoadProjectMcpServersKeepsValidSiblings(t *testing.T) {
	dir := t.TempDir()
	writeMCPJSON(t, dir, `{"mcpServers": {"bad": {"command": 42}, "good": {"command": "good-server"}}}`)
	got := LoadProjectMcpServers(dir)
	if len(got) != 1 || got[0].Name != "good" {
		t.Fatalf("one bad entry must not hide its siblings, got %+v", got)
	}
}

func TestWithProjectMcpServersUserWinsOnCollision(t *testing.T) {
	dir := t.TempDir()
	writeMCPJSON(t, dir, `{
		"mcpServers": {
			"shared": {"command": "project-binary"},
			"extra": {"command": "extra-binary"}
		}
	}`)

	base := &AppConfig{MCPServers: []MCPServerConfig{{Name: "shared", Command: "user-binary"}}}
	merged := WithProjectMcpServers(base, dir)

	want := []MCPServerConfig{
		{Name: "shared", Command: "user-binary"},
		{Name: "extra", Command: "extra-binary"},
	}
	if !reflect.DeepEqual(merged.MCPServers, want) {
		t.Fatalf("merge wrong: %+v", merged.MCPServers)
	}
	// The input config must stay untouched.
	if len(base.MCPServers) != 1 || base.MCPServers[0].Command != "user-binary" {
		t.Fatalf("input config mutated: %+v", base.MCPServers)
	}
}

func TestWithProjectMcpServersNoFileReturnsSameConfig(t *testing.T) {
	base := &AppConfig{}
	if got := WithProjectMcpServers(base, t.TempDir()); got != base {
		t.Fatal("without .mcp.json the same config pointer must be returned")
	}
}
