package llm

import (
	"encoding/json"
	"testing"

	anthropic "github.com/anthropics/anthropic-sdk-go"
)

func TestToAnthropicToolSchemaPreservesExtraInputSchemaFields(t *testing.T) {
	schema := map[string]any{
		"name":        "EnterPlanMode",
		"description": "Enter plan mode",
		"strict":      true,
		"input_schema": map[string]any{
			"type":                 "object",
			"properties":           map[string]any{},
			"required":             []string{},
			"additionalProperties": false,
		},
	}

	tool := toAnthropicToolSchema(schema, false)
	if tool.OfTool == nil {
		t.Fatal("expected OfTool to be set")
	}
	data, err := json.Marshal(tool.OfTool.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["type"] != "object" {
		t.Errorf("type = %v, want object", decoded["type"])
	}
	if decoded["additionalProperties"] != false {
		t.Errorf("additionalProperties dropped; marshaled input_schema = %s", data)
	}
	if _, ok := decoded["properties"]; !ok {
		t.Errorf("properties missing; marshaled input_schema = %s", data)
	}
}

func TestToAnthropicToolSchemaCustomTypeAndDeferLoading(t *testing.T) {
	schema := map[string]any{
		"name":          "mcp__server__tool",
		"description":   "an mcp tool",
		"defer_loading": true,
		"input_schema": map[string]any{
			"type":       "object",
			"properties": map[string]any{"x": map[string]any{"type": "string"}},
		},
	}

	withCustom := toAnthropicToolSchema(schema, true)
	if withCustom.OfTool.Type != anthropic.ToolTypeCustom {
		t.Errorf("useExplicitCustomType: Type = %q, want custom", withCustom.OfTool.Type)
	}
	if !withCustom.OfTool.DeferLoading.Value {
		t.Error("defer_loading not propagated")
	}

	withoutCustom := toAnthropicToolSchema(schema, false)
	if withoutCustom.OfTool.Type == anthropic.ToolTypeCustom {
		t.Error("type should not be custom when useExplicitCustomType is false")
	}
}
