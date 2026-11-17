package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type SyntheticOutputTool struct {
	JSONSchema map[string]any
}

func (t *SyntheticOutputTool) Name() string           { return "SyntheticOutput" }
func (t *SyntheticOutputTool) Category() ToolCategory { return CategoryRead }

func (t *SyntheticOutputTool) Description() string { return SyntheticOutputDescription }

func (t *SyntheticOutputTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"output": map[string]any{
					"description": SyntheticOutputOutputDescription,
				},
			},
			"required": []string{"output"},
		},
	}
}

func (t *SyntheticOutputTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	output, ok := args["output"]
	if !ok {
		return ToolResult{Output: OutputRequiredError, IsError: true}
	}

	if err := t.validateSchema(output); err != "" {
		return ToolResult{
			Output:  fmt.Sprintf("Output does not match required schema: %s", err),
			IsError: true,
		}
	}

	if s, isString := output.(string); isString {
		return ToolResult{Output: s}
	}

	encoded, err := json.MarshalIndent(output, "", "  ")
	if err != nil {
		return ToolResult{
			Output:  fmt.Sprintf("Error: output is not serializable: %s", err),
			IsError: true,
		}
	}
	return ToolResult{Output: string(encoded)}
}

func (t *SyntheticOutputTool) validateSchema(data any) string {
	if t.JSONSchema == nil {
		return ""
	}
	describe := func() string {
		switch data.(type) {
		case []any:
			return "array"
		case nil:
			return "object"
		case string:
			return "string"
		case float64, int, int64:
			return "number"
		case bool:
			return "boolean"
		default:
			return "object"
		}
	}
	if expected, ok := t.JSONSchema["type"].(string); ok {
		switch expected {
		case "object":
			if _, isMap := data.(map[string]any); !isMap {
				return "Expected object, got " + describe()
			}
		case "array":
			if _, isSlice := data.([]any); !isSlice {
				return "Expected array, got " + describe()
			}
		case "string":
			if _, isString := data.(string); !isString {
				return "Expected string, got " + describe()
			}
		case "number":
			switch data.(type) {
			case float64, int, int64:
			default:
				return "Expected number, got " + describe()
			}
		case "boolean":
			if _, isBool := data.(bool); !isBool {
				return "Expected boolean, got " + describe()
			}
		case "null":
			if data != nil {
				return "Expected null, got " + describe()
			}
		}
	}

	var required []string
	switch values := t.JSONSchema["required"].(type) {
	case []any:
		for _, value := range values {
			if name, ok := value.(string); ok {
				required = append(required, name)
			}
		}
	case []string:
		required = values
	}
	obj, isObj := data.(map[string]any)
	if len(required) > 0 && isObj {
		var missing []string
		for _, name := range required {
			if _, present := obj[name]; !present {
				missing = append(missing, name)
			}
		}
		if len(missing) > 0 {
			return "Missing required fields: " + strings.Join(missing, ", ")
		}
	}
	return ""
}
