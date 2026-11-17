package mcp

import (
	"context"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type stubMCPTool struct {
	name    string
	noDefer bool
}

func (s *stubMCPTool) Name() string                   { return s.name }
func (s *stubMCPTool) Description() string            { return "stub" }
func (s *stubMCPTool) Category() tools.ToolCategory   { return tools.CategoryCommand }
func (s *stubMCPTool) ShouldDefer() bool              { return !s.noDefer }
func (s *stubMCPTool) SetDeferLoading(on bool)        { s.noDefer = !on }
func (s *stubMCPTool) MCPServerName() string          { return "linear" }
func (s *stubMCPTool) MCPInputSchema() map[string]any { return map[string]any{"type": "object"} }

func (s *stubMCPTool) Schema() map[string]any {
	return map[string]any{
		"name":         s.name,
		"description":  "stub",
		"input_schema": map[string]any{"type": "object", "properties": map[string]any{}},
	}
}

func (s *stubMCPTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	return tools.ToolResult{Output: "ok"}
}

func TestIsOfficialAnthropicEndpoint(t *testing.T) {
	if !IsOfficialAnthropicEndpoint("") {
		t.Error("empty base_url should count as official")
	}
	if !IsOfficialAnthropicEndpoint("https://api.anthropic.com") {
		t.Error("official domains should count as official")
	}
	if IsOfficialAnthropicEndpoint("https://api.minimaxi.com/anthropic") {
		t.Error("third-party endpoints must not count as official")
	}
}

func TestDecideMode(t *testing.T) {
	const window = 200000
	cases := []struct {
		desc    string
		baseURL string
		chars   int
		want    tools.McpLoadingMode
	}{
		{"small schemas load eagerly", "https://proxy.example.com", 1000, tools.McpLoadingEager},
		{"no MCP tools still loads eagerly", "https://proxy.example.com", 0, tools.McpLoadingEager},
		{"official endpoints use native deferral", "", 500000, tools.McpLoadingNative},
		{"third-party endpoints dispatch via McpCall", "https://api.minimaxi.com/anthropic", 500000, tools.McpLoadingDispatch},
	}
	for _, c := range cases {
		if got := DecideMode(c.baseURL, "anthropic", window, c.chars, "auto", DefaultEagerThresholdPercent); got != c.want {
			t.Errorf("%s: got %s, want %s", c.desc, got, c.want)
		}
	}
}

func TestDecideModeConfigurationAndProtocol(t *testing.T) {
	for _, protocol := range []string{"openai", "openai-compat"} {
		for _, loading := range []string{"auto", "native"} {
			if got := DecideMode("", protocol, 200000, 500000, loading, 10); got != tools.McpLoadingDispatch {
				t.Fatal(protocol, loading, got)
			}
		}
	}
	for _, loading := range []string{"eager", "dispatch", "native"} {
		if got := DecideMode("", "anthropic", 200000, 0, loading, 10); string(got) != loading {
			t.Fatal(loading, got)
		}
	}
}

func TestMeasureSchemaCharsCountsOnlyMCPTools(t *testing.T) {
	reg := tools.CreateDefaultRegistry()
	if got := MeasureSchemaChars(reg); got != 0 {
		t.Errorf("builtin-only tools should count 0, got %d", got)
	}
	reg.Register(&stubMCPTool{name: "mcp__linear__create_issue"})
	if got := MeasureSchemaChars(reg); got <= 0 {
		t.Errorf("MCP tools should count above 0, got %d", got)
	}
}

func TestApplyMode(t *testing.T) {
	mcpCount := func(reg *tools.Registry) (total, deferred int) {
		for _, s := range reg.GetAllSchemas("anthropic") {
			name, _ := s["name"].(string)
			if len(name) > 5 && name[:5] == "mcp__" {
				total++
				if s["defer_loading"] == true {
					deferred++
				}
			}
		}
		return
	}

	reg := tools.CreateDefaultRegistry()
	reg.Register(&stubMCPTool{name: "mcp__linear__create_issue"})
	ApplyMode(reg, tools.McpLoadingEager)
	if total, deferred := mcpCount(reg); total != 1 || deferred != 0 {
		t.Errorf("eager: tools should be registered without markers, got total=%d deferred=%d", total, deferred)
	}

	reg = tools.CreateDefaultRegistry()
	reg.Register(&stubMCPTool{name: "mcp__linear__create_issue"})
	ApplyMode(reg, tools.McpLoadingNative)
	if total, deferred := mcpCount(reg); total != 1 || deferred != 1 {
		t.Errorf("native: tools should be registered with markers, got total=%d deferred=%d", total, deferred)
	}

	reg = tools.CreateDefaultRegistry()
	reg.Register(&stubMCPTool{name: "mcp__linear__create_issue"})
	ApplyMode(reg, tools.McpLoadingDispatch)
	if total, _ := mcpCount(reg); total != 0 {
		t.Errorf("dispatch: MCP tools must not be registered, got %d", total)
	}
}

func TestNativeFlagNotSentOnOpenAIProtocol(t *testing.T) {
	reg := tools.CreateDefaultRegistry()
	reg.Register(&stubMCPTool{name: "mcp__linear__create_issue"})
	ApplyMode(reg, tools.McpLoadingNative)
	for _, s := range reg.GetAllSchemas("openai") {
		if name, _ := s["name"].(string); len(name) > 5 && name[:5] == "mcp__" {
			t.Errorf("openai protocol must not surface MCP tools: %s", name)
		}
	}
}

func TestMCPToolNamePrefixSanitizes(t *testing.T) {
	if got := MCPToolNamePrefix("chrome-devtools"); got != "mcp__chrome_devtools__" {
		t.Errorf("got %q", got)
	}
}
