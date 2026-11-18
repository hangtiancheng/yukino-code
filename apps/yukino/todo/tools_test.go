package todo

import (
	"context"
	"strings"
	"testing"
)

func TestTodoWriteToolCancellationAndPrivateDelegation(t *testing.T) {
	list := testList(t)
	tool := &TodoWriteTool{Board: list}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if result := tool.Execute(ctx, map[string]any{"todos": []any{map[string]any{"subject": "cancelled"}}}); !result.IsError || len(list.List()) != 0 {
		t.Fatal(result)
	}
	result := tool.Execute(context.Background(), map[string]any{"todos": []any{map[string]any{"subject": "one"}}})
	if result.IsError || !strings.Contains(result.Output, `"id": "1"`) || !strings.Contains(result.Output, "DONE 0/1") {
		t.Fatal(result)
	}
	child := tool.ForSubagent()
	result = child.Execute(context.Background(), map[string]any{})
	if result.IsError || !strings.Contains(result.Output, "DONE 0/0") {
		t.Fatal(result)
	}
	if schema := tool.Schema()["input_schema"].(map[string]any); schema["additionalProperties"] != false {
		t.Fatal(schema)
	}
}
