package extractor

import (
	"strings"
	"testing"
)

func TestParseTextMemoryBlocks(t *testing.T) {
	text := `MEMORY_NAME: first-topic
MEMORY_TYPE: feedback
MEMORY_DESC: prefer terse replies
MEMORY_BODY: Keep answers short.
Second body line.

---
MEMORY_NAME: second-topic
MEMORY_DESC: project context
MEMORY_BODY: Ship on Friday.
`
	memories := parseTextMemoryBlocks(text)
	if len(memories) != 2 {
		t.Fatalf("got %d memories, want 2", len(memories))
	}
	first := memories[0]
	if first.Name != "first-topic" || first.Type != "feedback" || first.Description != "prefer terse replies" {
		t.Fatalf("first = %+v", first)
	}
	if first.Body != "Keep answers short.\nSecond body line." {
		t.Fatalf("first body = %q", first.Body)
	}
	second := memories[1]
	if second.Name != "second-topic" || second.Type != "reference" || second.Body != "Ship on Friday." {
		t.Fatalf("second = %+v", second)
	}
}

func TestParseTextMemoryBlocksSentinelAndInvalid(t *testing.T) {
	if got := parseTextMemoryBlocks("NONE"); len(got) != 0 {
		t.Fatalf("NONE should produce nothing, got %+v", got)
	}
	if got := parseTextMemoryBlocks("MEMORY_NAME: bad name!\nMEMORY_BODY: x"); len(got) != 0 {
		t.Fatalf("invalid name should be rejected, got %+v", got)
	}
	if got := parseTextMemoryBlocks("MEMORY_NAME: ok\nMEMORY_BODY: "); len(got) != 0 {
		t.Fatalf("empty body should be rejected, got %+v", got)
	}
}

func TestFormatMemoryFile(t *testing.T) {
	got := formatMemoryFile(ParsedTextMemory{Name: "n", Type: "user", Description: `has "quotes"`, Body: "body"})
	want := "---\nname: \"n\"\ndescription: \"has \\\"quotes\\\"\"\ntype: \"user\"\n---\n\nbody\n"
	if got != want {
		t.Fatalf("formatMemoryFile = %q, want %q", got, want)
	}
	if !strings.HasPrefix(got, "---\n") {
		t.Fatal("missing frontmatter")
	}
}
