package llm

import (
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/packages/param"
)

func TestMarkToolsForCache(t *testing.T) {
	plain := func(name string) anthropic.ToolUnionParam {
		return anthropic.ToolUnionParam{OfTool: &anthropic.ToolParam{Name: name}}
	}
	deferred := func(name string) anthropic.ToolUnionParam {
		return anthropic.ToolUnionParam{OfTool: &anthropic.ToolParam{
			Name:         name,
			DeferLoading: param.NewOpt(true),
		}}
	}
	var unmarked anthropic.CacheControlEphemeralParam
	marked := func(tools []anthropic.ToolUnionParam) []string {
		var out []string
		for _, u := range tools {
			if u.OfTool == nil || u.OfTool.CacheControl == unmarked {
				continue
			}
			out = append(out, u.OfTool.Name)
		}
		return out
	}

	t.Run("walks backwards when the tail is deferred tools", func(t *testing.T) {
		tools := []anthropic.ToolUnionParam{
			plain("ReadFile"), plain("WriteFile"), plain("ToolSearch"),
			deferred("mcp__linear__create_issue"), deferred("mcp__sentry__resolve"),
		}
		markToolsForCache(tools)
		got := marked(tools)
		if len(got) != 1 || got[0] != "ToolSearch" {
			t.Fatalf("expected ToolSearch to be marked, got %v", got)
		}
	})

	t.Run("marks the last tool when none are deferred", func(t *testing.T) {
		tools := []anthropic.ToolUnionParam{plain("ReadFile"), plain("Bash")}
		markToolsForCache(tools)
		if got := marked(tools); len(got) != 1 || got[0] != "Bash" {
			t.Fatalf("expected Bash to be marked, got %v", got)
		}
	})

	t.Run("deferred tools in the middle are never selected", func(t *testing.T) {
		tools := []anthropic.ToolUnionParam{
			plain("Bash"), deferred("mcp__a__x"), plain("Grep"), deferred("mcp__z__y"),
		}
		markToolsForCache(tools)
		if got := marked(tools); len(got) != 1 || got[0] != "Grep" {
			t.Fatalf("expected Grep to be marked, got %v", got)
		}
	})

	t.Run("marks nothing when every tool is deferred", func(t *testing.T) {
		tools := []anthropic.ToolUnionParam{deferred("mcp__a__x"), deferred("mcp__b__y")}
		markToolsForCache(tools)
		if got := marked(tools); len(got) != 0 {
			t.Fatalf("no tool should be marked, got %v", got)
		}
	})
}
