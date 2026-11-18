package llm

import "testing"

func TestNeedsToolSearchBeta(t *testing.T) {
	cases := []struct {
		desc  string
		tools []map[string]any
		want  bool
	}{
		{"no tools", nil, false},
		{"no deferred tools", []map[string]any{{"name": "Bash"}, {"name": "ToolSearch"}}, false},
		{
			"one tool has defer_loading",
			[]map[string]any{{"name": "Bash"}, {"name": "mcp__linear__x", "defer_loading": true}},
			true,
		},
		{
			"defer_loading=false does not count",
			[]map[string]any{{"name": "mcp__linear__x", "defer_loading": false}},
			false,
		},
	}
	for _, c := range cases {
		if got := needsToolSearchBeta(c.tools); got != c.want {
			t.Errorf("%s: got %v, want %v", c.desc, got, c.want)
		}
	}
}
