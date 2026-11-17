package tools

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

type orderPlainTool struct{ n string }

func (t *orderPlainTool) Name() string           { return t.n }
func (t *orderPlainTool) Description() string    { return t.n }
func (t *orderPlainTool) Category() ToolCategory { return CategoryRead }
func (t *orderPlainTool) Schema() map[string]any {
	return map[string]any{"name": t.n, "input_schema": map[string]any{"type": "object"}}
}
func (t *orderPlainTool) Execute(context.Context, map[string]any) ToolResult {
	return ToolResult{Output: "ok"}
}

type orderDeferTool struct{ n string }

func (t *orderDeferTool) Name() string           { return t.n }
func (t *orderDeferTool) Description() string    { return t.n }
func (t *orderDeferTool) Category() ToolCategory { return CategoryRead }
func (t *orderDeferTool) ShouldDefer() bool      { return true }
func (t *orderDeferTool) Schema() map[string]any {
	return map[string]any{"name": t.n, "input_schema": map[string]any{"type": "object"}}
}
func (t *orderDeferTool) Execute(context.Context, map[string]any) ToolResult {
	return ToolResult{Output: "ok"}
}

func schemaNames(schemas []map[string]any) string {
	var out []string
	for _, s := range schemas {
		out = append(out, s["name"].(string))
	}
	return strings.Join(out, ",")
}

func TestGetAllSchemasOrderIsStable(t *testing.T) {
	reg := NewRegistry()
	for i := 0; i < 20; i++ {
		reg.Register(&orderPlainTool{n: fmt.Sprintf("Tool%02d", i)})
	}
	for i := 0; i < 10; i++ {
		reg.Register(&orderDeferTool{n: fmt.Sprintf("mcp__srv__t%02d", i)})
	}
	reg.McpLoadingMode = McpLoadingNative
	reg.ExposeToolSearch = true

	want := schemaNames(reg.GetAllSchemas("anthropic"))
	for i := 0; i < 100; i++ {
		if got := schemaNames(reg.GetAllSchemas("anthropic")); got != want {
			t.Fatalf("call %d changed the order\nfirst: %s\nthis: %s", i, want, got)
		}
	}

	wantOpenAI := schemaNames(reg.GetAllSchemas("openai"))
	for i := 0; i < 20; i++ {
		if got := schemaNames(reg.GetAllSchemas("openai")); got != wantOpenAI {
			t.Fatalf("openai protocol: call %d changed the order", i)
		}
	}
}

func TestNonDeferredToolExistsForCacheMarker(t *testing.T) {
	reg := NewRegistry()
	for _, n := range []string{"ReadFile", "WriteFile", "Bash", "ToolSearch"} {
		reg.Register(&orderPlainTool{n: n})
	}
	for i := 0; i < 5; i++ {
		reg.Register(&orderDeferTool{n: fmt.Sprintf("mcp__srv__z%02d", i)})
	}
	reg.McpLoadingMode = McpLoadingNative
	reg.ExposeToolSearch = true

	schemas := reg.GetAllSchemas("anthropic")
	lastDeferred, _ := schemas[len(schemas)-1]["defer_loading"].(bool)
	if !lastDeferred {
		t.Fatal("the last sorted tool should be deferred; the test premise no longer holds")
	}

	found := -1
	for i := len(schemas) - 1; i >= 0; i-- {
		if dl, _ := schemas[i]["defer_loading"].(bool); !dl {
			found = i
			break
		}
	}
	if found < 0 {
		t.Fatal("no non-deferred tool found; the cache breakpoint has nowhere to go")
	}
	if name := schemas[found]["name"].(string); strings.HasPrefix(name, MCPToolPrefix) {
		t.Errorf("landing spot %s is an MCP tool and must not be selected", name)
	}
}
