package agent

import (
	"context"
	"fmt"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type plainT struct {
	n   string
	cat tools.ToolCategory
}

func (t *plainT) Name() string                 { return t.n }
func (t *plainT) Description() string          { return t.n }
func (t *plainT) Category() tools.ToolCategory { return t.cat }
func (t *plainT) Schema() map[string]any       { return map[string]any{"name": t.n} }
func (t *plainT) Execute(context.Context, map[string]any) tools.ToolResult {
	return tools.ToolResult{}
}

func TestBashConcurrencySafetyByCommand(t *testing.T) {
	bash := &tools.BashTool{}

	// Recognized read-only commands are considered safe.
	safe := []string{"cat a.txt", "wc -l f", "grep pattern a.txt", "docker ps"}
	for _, cmd := range safe {
		if !tools.IsConcurrencySafe(bash, map[string]any{"command": cmd}) {
			t.Errorf("%q should be concurrency safe", cmd)
		}
	}

	// Unrecognized read-only commands still require serialization.
	for _, cmd := range []string{"ls", "ls -la", "git status", "pwd"} {
		if tools.IsConcurrencySafe(bash, map[string]any{"command": cmd}) {
			t.Errorf("%q should NOT be concurrency safe", cmd)
		}
	}

	unsafe := []string{
		"rm -rf build", "mv a b", "npm install", "git commit -m x",
		"echo hi > f", "ls | wc -l", "ls; rm x", "ls && rm x",
		"echo $(rm x)", "ls `rm x`",
	}
	for _, cmd := range unsafe {
		if tools.IsConcurrencySafe(bash, map[string]any{"command": cmd}) {
			t.Errorf("%q should NOT be concurrency safe", cmd)
		}
	}
}

func TestBashConcurrencySafetyBadArgs(t *testing.T) {
	bash := &tools.BashTool{}
	for _, args := range []map[string]any{
		{},
		{"command": nil},
		{"command": 123},
	} {
		if tools.IsConcurrencySafe(bash, args) {
			t.Errorf("args=%v should NOT be concurrency safe", args)
		}
	}
}

func TestConcurrencySafetyFallsBackToCategory(t *testing.T) {
	cases := []struct {
		name string
		tool tools.Tool
		want bool
	}{
		{"read", &plainT{n: "ReadFile", cat: tools.CategoryRead}, true},
		{"write", &plainT{n: "WriteFile", cat: tools.CategoryWrite}, false},
		{"command", &plainT{n: "Other", cat: tools.CategoryCommand}, false},
	}
	for _, c := range cases {
		if got := tools.IsConcurrencySafe(c.tool, nil); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestReadOnlyBashBatchesWithReadTools(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(&plainT{n: "ReadFile", cat: tools.CategoryRead})
	reg.Register(&plainT{n: "Grep", cat: tools.CategoryRead})
	reg.Register(&tools.BashTool{})

	entries := []toolCallEntry{
		{tc: toolCallInfo{toolID: "a", toolName: "ReadFile"}, index: 0},
		{tc: toolCallInfo{toolID: "b", toolName: "Bash",
			arguments: map[string]any{"command": "cat status.txt"}}, index: 1},
		{tc: toolCallInfo{toolID: "c", toolName: "Grep"}, index: 2},
	}

	batches := partitionToolCalls(entries, reg)
	if len(batches) != 1 || !batches[0].concurrent || len(batches[0].calls) != 3 {
		t.Fatalf("expected one concurrent batch of 3 calls, got %s", describe(batches))
	}
}

func TestMutatingBashBreaksTheBatch(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(&plainT{n: "ReadFile", cat: tools.CategoryRead})
	reg.Register(&plainT{n: "Grep", cat: tools.CategoryRead})
	reg.Register(&tools.BashTool{})

	entries := []toolCallEntry{
		{tc: toolCallInfo{toolID: "a", toolName: "ReadFile"}, index: 0},
		{tc: toolCallInfo{toolID: "b", toolName: "Bash",
			arguments: map[string]any{"command": "rm -rf build"}}, index: 1},
		{tc: toolCallInfo{toolID: "c", toolName: "Grep"}, index: 2},
	}

	batches := partitionToolCalls(entries, reg)
	want := "[concurrent:a] [serial:b] [concurrent:c]"
	if got := describe(batches); got != want {
		t.Errorf("got %s want %s", got, want)
	}
}

func describe(batches []toolBatch) string {
	out := ""
	for i, b := range batches {
		if i > 0 {
			out += " "
		}
		kind := "serial"
		if b.concurrent {
			kind = "concurrent"
		}
		ids := ""
		for j, c := range b.calls {
			if j > 0 {
				ids += ","
			}
			ids += c.tc.toolID
		}
		out += fmt.Sprintf("[%s:%s]", kind, ids)
	}
	return out
}
