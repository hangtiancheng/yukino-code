package utils

import (
	"strings"
	"testing"
)

// Expected outputs byte-verified against src/utils/index.ts via npx tsx.
func TestPlainTerminalText(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain text", "plain text"},
		{"\x1b[31mred\x1b[0m", "red"},
		{"line1\r\nline2\rline3\n", "line1\nline2\nline3\n"},
		{"bell\x07here", "bellhere"},
		{"tab\there", "tab\there"},
		{"\x1b]8;;http://x\x07link\x1b]8;;\x07", "link"},
		{"nul\x00byte", "nulbyte"},
		{"\x1b[1;32mbold green\x1b[0m tail", "bold green tail"},
	}
	for _, c := range cases {
		if got := PlainTerminalText(c.in); got != c.want {
			t.Errorf("PlainTerminalText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFormatToolArgs(t *testing.T) {
	if got := FormatToolArgs(map[string]any{"command": "ls -la"}); got != "ls -la" {
		t.Errorf("command = %q", got)
	}
	long := strings.Repeat("x", 100)
	got := FormatToolArgs(map[string]any{"file_path": long})
	if len([]rune(got)) != 81 || !strings.HasSuffix(got, "…") {
		t.Errorf("file_path truncation = %d runes", len([]rune(got)))
	}
	if got := FormatToolArgs(map[string]any{"description": "short"}); got != "short" {
		t.Errorf("description = %q", got)
	}
	if got := FormatToolArgs(map[string]any{"other": 1}); got != "" {
		t.Errorf("other = %q", got)
	}
}

func TestIntArg(t *testing.T) {
	cases := []struct {
		value    any
		fallback int
		want     int
	}{
		{"42", 0, 42},
		{"12abc", 7, 7},
		{3.9, 0, 3},
		{"  -2.5 ", 0, -2},
		{nil, 5, 5},
	}
	for _, c := range cases {
		args := map[string]any{}
		if c.value != nil {
			args["n"] = c.value
		}
		if got := IntArg(args, "n", c.fallback); got != c.want {
			t.Errorf("IntArg(%v, fallback %d) = %d, want %d", c.value, c.fallback, got, c.want)
		}
	}
}

func TestBoolArg(t *testing.T) {
	if !BoolArg(map[string]any{"b": "TRUE"}, "b", false) {
		t.Error(`"TRUE" must be true`)
	}
	if BoolArg(map[string]any{"b": "0"}, "b", true) {
		t.Error(`"0" must be false`)
	}
	if !BoolArg(map[string]any{"b": 1}, "b", false) {
		t.Error("1 must be true")
	}
	if !BoolArg(map[string]any{}, "b", true) {
		t.Error("missing must fall back")
	}
}

func TestContentToText(t *testing.T) {
	content := []map[string]any{
		{"type": "text", "text": "a"},
		{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png"}},
		{"type": "tool_reference", "tool_name": "T"},
		{"type": "document", "title": "D"},
		{"type": "search_result", "title": "S", "source": "src", "content": []any{map[string]any{"type": "text", "text": "nested"}}},
	}
	want := "a\n[Image: image/png]\n[Tool reference: T]\n[Document: D]\nS (src)\nnested"
	if got := ContentToText(content); got != want {
		t.Errorf("ContentToText = %q, want %q", got, want)
	}
	if got := ContentToText("plain"); got != "plain" {
		t.Errorf("string passthrough = %q", got)
	}
}

func TestAsErrorStringAndRecord(t *testing.T) {
	if got := AsErrorString(strings.NewReader("x")); got == "" {
		t.Error("non-error values stringify")
	}
	if got := AsErrorString(errTest("boom")); got != "boom" {
		t.Errorf("error = %q", got)
	}
	if !IsRecord(map[string]any{}) || IsRecord([]any{}) || IsRecord(nil) {
		t.Error("IsRecord mismatch")
	}
	record := AsRecord([]any{"a", "b"})
	if record["0"] != "a" || record["1"] != "b" {
		t.Errorf("AsRecord(array) = %v", record)
	}
}

type errTest string

func (e errTest) Error() string { return string(e) }
