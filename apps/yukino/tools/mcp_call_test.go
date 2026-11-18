package tools

import (
	"context"
	"reflect"
	"sort"
	"strings"
	"testing"
)

type mockDispatchTool struct {
	name     string
	server   string
	schema   map[string]any
	received map[string]any
	noDefer  bool
}

func (m *mockDispatchTool) Name() string            { return m.name }
func (m *mockDispatchTool) Description() string     { return "mock" }
func (m *mockDispatchTool) Category() ToolCategory  { return CategoryCommand }
func (m *mockDispatchTool) ShouldDefer() bool       { return !m.noDefer }
func (m *mockDispatchTool) SetDeferLoading(on bool) { m.noDefer = !on }
func (m *mockDispatchTool) MCPServerName() string   { return m.server }
func (m *mockDispatchTool) MCPInputSchema() map[string]any {
	if m.schema == nil {
		return map[string]any{}
	}
	return m.schema
}

func (m *mockDispatchTool) Schema() map[string]any {
	return map[string]any{
		"name":         m.name,
		"description":  "mock",
		"input_schema": m.MCPInputSchema(),
	}
}

func (m *mockDispatchTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	m.received = args
	return ToolResult{Output: "ok"}
}

var testSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"issueId": map[string]any{"type": "string"},
		"limit":   map[string]any{"type": "integer"},
		"ratio":   map[string]any{"type": "number"},
		"flag":    map[string]any{"type": "boolean"},
		"labels":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"ports":   map[string]any{"type": "array", "items": map[string]any{"type": "integer"}},
		"config": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"replicas": map[string]any{"type": "integer"},
				"features": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			},
		},
	},
}

func TestCoerceBySchemaContract(t *testing.T) {
	cases := []struct {
		desc  string
		given map[string]any
		want  map[string]any
	}{
		{"string from integer", map[string]any{"issueId": float64(8891)}, map[string]any{"issueId": "8891"}},
		{"string from float", map[string]any{"issueId": 1.5}, map[string]any{"issueId": "1.5"}},
		{"integer from numeric string", map[string]any{"limit": "5"}, map[string]any{"limit": int64(5)}},
		{"number from padded numeric string", map[string]any{"ratio": " 1.5 "}, map[string]any{"ratio": 1.5}},
		{"boolean ← true", map[string]any{"flag": "true"}, map[string]any{"flag": true}},
		{"boolean from uppercase FALSE", map[string]any{"flag": "FALSE"}, map[string]any{"flag": false}},
		{
			"array unwraps single-key objects",
			map[string]any{"labels": map[string]any{"item": []any{"a", "b"}}},
			map[string]any{"labels": []any{"a", "b"}},
		},
		{
			"array from comma-separated string",
			map[string]any{"labels": "a, b"},
			map[string]any{"labels": []any{"a", "b"}},
		},
		{
			"array recurses through items",
			map[string]any{"ports": []any{"8080", "9090"}},
			map[string]any{"ports": []any{int64(8080), int64(9090)}},
		},
		{
			"object recurses through properties, including nested levels",
			map[string]any{"config": map[string]any{
				"replicas": "4",
				"features": map[string]any{"item": []any{"x"}},
			}},
			map[string]any{"config": map[string]any{
				"replicas": int64(4),
				"features": []any{"x"},
			}},
		},
	}
	for _, c := range cases {
		got := CoerceBySchema(c.given, testSchema)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %#v, want %#v", c.desc, got, c.want)
		}
	}
}

func TestCoerceBySchemaLeavesThingsAlone(t *testing.T) {
	if got := CoerceBySchema(map[string]any{"issueId": true}, testSchema); got.(map[string]any)["issueId"] != true {
		t.Errorf("bool must not be converted to string, got %#v", got)
	}
	if got := CoerceBySchema(map[string]any{"limit": "many"}, testSchema); got.(map[string]any)["limit"] != "many" {
		t.Error("unconvertible values must be kept as-is")
	}
	if got := CoerceBySchema(map[string]any{"extra": 1}, testSchema); got.(map[string]any)["extra"] != 1 {
		t.Error("unknown keys must be kept as-is")
	}
	if got := CoerceBySchema(map[string]any{"a": "1"}, map[string]any{}); got.(map[string]any)["a"] != "1" {
		t.Error("an empty schema must not modify args")
	}
}

func TestCoerceNumericShapeParity(t *testing.T) {
	cases := []struct {
		key  string
		in   string
		want any
	}{
		{"limit", "5", int64(5)},
		{"limit", "+5", int64(5)},
		{"limit", "5.7", "5.7"},
		{"limit", "1_000", "1_000"},
		{"limit", "1e3", "1e3"},
		{"limit", "5abc", "5abc"},
		{"ratio", " 1.5 ", 1.5},
		{"ratio", "1e3", 1000.0},
		{"ratio", "inf", "inf"},
		{"ratio", "nan", "nan"},
	}
	for _, c := range cases {
		got := CoerceBySchema(map[string]any{c.key: c.in}, testSchema).(map[string]any)[c.key]
		if got != c.want {
			t.Errorf("%s=%q converted to %#v, want %#v", c.key, c.in, got, c.want)
		}
	}
}

func TestCoerceMultiKeyObjectForArrayLeftAlone(t *testing.T) {
	inner := map[string]any{"item": "metrics", "tracing": ""}
	got := CoerceBySchema(map[string]any{"labels": inner}, testSchema).(map[string]any)["labels"]
	m, ok := got.(map[string]any)
	if !ok || len(m) != 2 || m["item"] != "metrics" {
		t.Errorf("multi-key objects must be kept as-is, got %#v", got)
	}
}

func newDispatchRegistry() (*Registry, *McpCallTool, *mockDispatchTool) {
	reg := NewRegistry()
	reg.McpLoadingMode = McpLoadingDispatch
	tool := &mockDispatchTool{name: "mcp__linear__create_issue", server: "linear", schema: testSchema}
	reg.Register(tool)
	d := &McpCallTool{Registry: reg}
	reg.Register(d)
	return reg, d, tool
}

func TestMcpCallResolvesFullName(t *testing.T) {
	_, d, tool := newDispatchRegistry()
	res := d.Execute(context.Background(), map[string]any{
		"server": "linear", "tool": "mcp__linear__create_issue",
		"arguments": map[string]any{"issueId": "A"},
	})
	if res.IsError {
		t.Fatalf("should not error: %s", res.Output)
	}
	if tool.received["issueId"] != "A" {
		t.Errorf("args did not reach the tool: %#v", tool.received)
	}
}

func TestMcpCallResolvesShortName(t *testing.T) {
	_, d, tool := newDispatchRegistry()
	res := d.Execute(context.Background(), map[string]any{
		"server": "linear", "tool": "create_issue",
		"arguments": map[string]any{"issueId": "A"},
	})
	if res.IsError {
		t.Fatalf("the short name should resolve: %s", res.Output)
	}
	if tool.received["issueId"] != "A" {
		t.Errorf("args did not reach the tool: %#v", tool.received)
	}
}

func TestMcpCallRejectsWrongServer(t *testing.T) {
	_, d, tool := newDispatchRegistry()
	res := d.Execute(context.Background(), map[string]any{
		"server": "typo", "tool": "create_issue",
		"arguments": map[string]any{"issueId": "A"},
	})
	if !res.IsError || tool.received != nil {
		t.Errorf("a wrong server must never route to another server: %s", res.Output)
	}
}

func TestMcpCallAmbiguousSuffixErrors(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&mockDispatchTool{name: "mcp__linear__create_issue", server: "linear"})
	reg.Register(&mockDispatchTool{name: "mcp__jira__create_issue", server: "jira"})
	d := &McpCallTool{Registry: reg}
	res := d.Execute(context.Background(), map[string]any{
		"server": "nope", "tool": "create_issue", "arguments": map[string]any{},
	})
	if !res.IsError {
		t.Fatal("two tools sharing a name suffix must error instead of guessing")
	}
	if !strings.Contains(res.Output, "mcp__linear__create_issue") {
		t.Errorf("the error should list available tools: %s", res.Output)
	}
}

func TestMcpCallCoercesBeforeDispatch(t *testing.T) {
	_, d, tool := newDispatchRegistry()
	d.Execute(context.Background(), map[string]any{
		"server": "linear", "tool": "create_issue",
		"arguments": map[string]any{"issueId": float64(8891), "ports": []any{"1"}},
	})
	if tool.received["issueId"] != "8891" {
		t.Errorf("issueId should be converted to a string: %#v", tool.received["issueId"])
	}
	ports, _ := tool.received["ports"].([]any)
	if len(ports) != 1 || ports[0] != int64(1) {
		t.Errorf("ports elements should be converted to integers: %#v", tool.received["ports"])
	}
}

func TestMcpCallPermissionContentNormalization(t *testing.T) {
	cases := []struct{ server, tool, want string }{
		{"linear", "mcp__linear__create_issue", "linear__create_issue"},
		{"linear", "create_issue", "linear__create_issue"},
		{"chrome-2", "mcp__chrome_2__click", "chrome_2__click"},
		{"chrome-devtools", "click", "chrome_devtools__click"},
		{"chrome-devtools", "mcp__chrome_devtools__click", "chrome_devtools__click"},
	}
	for _, c := range cases {
		if got := McpCallPermissionContent(c.server, c.tool); got != c.want {
			t.Errorf("(%s,%s) got %q, want %q", c.server, c.tool, got, c.want)
		}
	}
}

func TestToolExposureByMode(t *testing.T) {
	build := func(mode McpLoadingMode) []string {
		reg := NewRegistry()
		reg.Register(&ToolSearchTool{Registry: reg})
		reg.Register(&McpCallTool{Registry: reg})
		mcpTool := &mockDispatchTool{name: "mcp__linear__create_issue", server: "linear", schema: testSchema}
		reg.Register(mcpTool)

		reg.McpLoadingMode = mode
		eager := mode == McpLoadingEager
		mcpTool.SetDeferLoading(!eager)
		reg.ExposeToolSearch = !eager
		reg.ExposeMcpCall = mode == McpLoadingDispatch

		var names []string
		for _, s := range reg.GetAllSchemas("anthropic") {
			names = append(names, s["name"].(string))
		}
		sort.Strings(names)
		return names
	}

	cases := []struct {
		mode McpLoadingMode
		want []string
	}{
		{McpLoadingEager, []string{"mcp__linear__create_issue"}},
		{McpLoadingNative, []string{"ToolSearch", "mcp__linear__create_issue"}},
		{McpLoadingDispatch, []string{"McpCall", "ToolSearch"}},
	}
	for _, c := range cases {
		got := build(c.mode)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("mode %s: tools[] = %v, want %v", c.mode, got, c.want)
		}
	}
}

func TestToolExposureDefaultsOff(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&ToolSearchTool{Registry: reg})
	reg.Register(&McpCallTool{Registry: reg})
	if n := len(reg.GetAllSchemas("anthropic")); n != 0 {
		t.Errorf("without MCP connections these two tools must not be exposed, got %d", n)
	}
}
