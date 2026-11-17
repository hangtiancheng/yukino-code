package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupGlobTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := []string{
		"main.go",
		"cmd/cli/main.go",
		"internal/subagent/agent.go",
		"internal/subagent/agent_test.go",
		"docs/readme.md",
	}
	for _, rel := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestGlobDoubleStarPattern(t *testing.T) {
	root := setupGlobTree(t)
	tool := &GlobTool{}
	res := tool.Execute(context.Background(), map[string]any{
		"pattern": "**/*.go",
		"path":    root,
	})
	if res.IsError {
		t.Fatalf("glob errored: %s", res.Output)
	}
	output := strings.ReplaceAll(res.Output, "\\", "/")
	for _, want := range []string{"main.go", "cmd/cli/main.go", "internal/subagent/agent.go", "internal/subagent/agent_test.go"} {
		if !strings.Contains(output, want) {
			t.Errorf("expected %q in output, got:\n%s", want, output)
		}
	}
	if strings.Contains(res.Output, "readme.md") {
		t.Errorf("readme.md should NOT match **/*.go")
	}
}

func TestGlobPlainPatternStillWorks(t *testing.T) {
	root := setupGlobTree(t)
	tool := &GlobTool{}
	res := tool.Execute(context.Background(), map[string]any{
		"pattern": "*.go",
		"path":    root,
	})
	if res.IsError {
		t.Fatalf("glob errored: %s", res.Output)
	}
	if !strings.Contains(res.Output, "main.go") {
		t.Errorf("plain pattern should still match base names, got:\n%s", res.Output)
	}
}

func TestMatchGlobExtglob(t *testing.T) {
	cases := []struct {
		pattern string
		name    string
		want    bool
	}{
		// @(a|b): exactly one of the alternatives.
		{"@(foo|bar)", "foo", true},
		{"@(foo|bar)", "bar", true},
		{"@(foo|bar)", "baz", false},
		{"@(foo|bar)", "foobar", false},
		// ?(a): zero or one occurrence.
		{"foo?(bar)", "foo", true},
		{"foo?(bar)", "foobar", true},
		{"foo?(bar)", "foobarbar", false},
		// *(a): zero or more occurrences.
		{"foo*(bar)", "foo", true},
		{"foo*(bar)", "foobar", true},
		{"foo*(bar)", "foobarbar", true},
		{"foo*(bar)", "foobaz", false},
		// +(a): one or more occurrences.
		{"foo+(bar)", "foo", false},
		{"foo+(bar)", "foobar", true},
		{"foo+(bar)", "foobarbar", true},
		// Extglob combined with wildcards and alternatives.
		{"@(*.ts|*.tsx)", "app.ts", true},
		{"@(*.ts|*.tsx)", "app.tsx", true},
		{"@(*.ts|*.tsx)", "app.go", false},
		{"src/@(a|b)/*.go", "src/a/x.go", true},
		{"src/@(a|b)/*.go", "src/c/x.go", false},
		// !(a|b): negation. The lookahead includes the segment tail, so
		// !(a).ts rejects exactly "a.ts" while !(a) alone still matches it.
		{"!(a).ts", "a.ts", false},
		{"!(a).ts", "ab.ts", true},
		{"!(a).ts", "foo.ts", true},
		{"!(a)", "a", false},
		{"!(a)", "ab", true},
		{"!(a)", "a.ts", true},
		{"!(a|b).ts", "a.ts", false},
		{"!(a|b).ts", "b.ts", false},
		{"!(a|b).ts", "c.ts", true},
		{"*.!(ts)", "a.ts", false},
		{"*.!(ts)", "b.tsx", true},
		{"*.!(ts)", ".hidden.ts", true},
		{"*.!(ts)", "x.js", true},
		{"!(*.ts)", "a.ts", false},
		{"!(*.ts)", "b.tsx", true},
		{"!(a)*", "a.ts", false},
		{"!(a)*", "ab.ts", false},
		{"!(a)*", "ba.ts", true},
		{"@(x|!(a)).ts", "a.ts", false},
		{"@(x|!(a)).ts", "ab.ts", true},
		{"!(deep)", "deep", false},
		{"!(deep)", "a.ts", true},
		{"!(src)", "src", false},
		{"x!(a)b", "xab", false},
		{"x!(a)b", "xaab", true},
		{"!()", "a", true},
		// Non-extglob patterns must keep working.
		{"*.go", "main.go", true},
		{"*.go", "main.ts", false},
		{"[!abc].go", "d.go", true},
		{"[!abc].go", "a.go", false},
	}
	for _, tc := range cases {
		if got := matchGlob(tc.pattern, tc.name); got != tc.want {
			t.Errorf("matchGlob(%q, %q) = %v, want %v", tc.pattern, tc.name, got, tc.want)
		}
	}
	// An empty !() is a non-empty star at the segment level (matchGlob maps
	// the empty name through path.Base before matching).
	if matchSegment("!()", "") {
		t.Error(`matchSegment("!()", "") = true, want false`)
	}
}

func TestGlobExtglobPattern(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"app.ts", "app.tsx", "app.go"} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	tool := &GlobTool{}
	res := tool.Execute(context.Background(), map[string]any{
		"pattern": "@(*.ts|*.tsx)",
		"path":    root,
	})
	if res.IsError {
		t.Fatalf("glob errored: %s", res.Output)
	}
	output := strings.ReplaceAll(res.Output, "\\", "/")
	if !strings.Contains(output, "app.ts") || !strings.Contains(output, "app.tsx") {
		t.Errorf("expected app.ts and app.tsx in output, got:\n%s", output)
	}
	if strings.Contains(output, "app.go") {
		t.Errorf("app.go should NOT match @(*.ts|*.tsx), got:\n%s", output)
	}
}
