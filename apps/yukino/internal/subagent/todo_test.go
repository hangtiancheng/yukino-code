package subagent

import (
	"context"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestDelegatedTodoBoardsAreIndependent(t *testing.T) {
	list, err := todo.NewTaskList(nil)
	if err != nil {
		t.Fatal(err)
	}
	registry := tools.NewRegistry()
	registry.Register(&todo.TodoWriteTool{Board: list})
	if _, err := list.Write(map[string]any{"todos": []any{map[string]any{"subject": "parent"}}}); err != nil {
		t.Fatal(err)
	}
	first := FilterToolsForAgent(registry, nil, nil, true)
	second := FilterToolsForAgent(registry, nil, nil, false)
	defer first.Dispose()
	defer second.Dispose()
	result := first.Get("TodoWrite").Execute(context.Background(), map[string]any{"todos": []any{map[string]any{"subject": "child"}}})
	if result.IsError || !strings.Contains(result.Output, "DONE 0/1") {
		t.Fatal(result)
	}
	result = second.Get("TodoWrite").Execute(context.Background(), map[string]any{})
	if result.IsError || !strings.Contains(result.Output, "DONE 0/0") || len(list.List()) != 1 || list.List()[0].Subject != "parent" {
		t.Fatal(result, list.List())
	}
}
