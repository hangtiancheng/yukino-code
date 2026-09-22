// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package extractor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/memory"
)

func TestParseTextMemoryBlocks(t *testing.T) {
	t.Run("empty and NONE", func(t *testing.T) {
		if got := parseTextMemoryBlocks(""); got != nil {
			t.Errorf("empty text should parse to nothing, got %+v", got)
		}
		if got := parseTextMemoryBlocks("  NONE \n"); got != nil {
			t.Errorf("NONE should parse to nothing, got %+v", got)
		}
	})

	t.Run("multi-line body and separators", func(t *testing.T) {
		text := strings.Join([]string{
			"MEMORY_NAME: proj-one",
			"MEMORY_TYPE: project",
			"MEMORY_DESC: first note",
			"MEMORY_BODY: line one",
			"line two",
			"---",
			"MEMORY_NAME: ref-two",
			"MEMORY_BODY: only body",
		}, "\n")
		got := parseTextMemoryBlocks(text)
		if len(got) != 2 {
			t.Fatalf("expected 2 blocks, got %d: %+v", len(got), got)
		}
		if got[0].name != "proj-one" || got[0].typ != "project" || got[0].description != "first note" {
			t.Errorf("first block parsed wrong: %+v", got[0])
		}
		if got[0].body != "line one\nline two" {
			t.Errorf("multi-line body wrong: %q", got[0].body)
		}
		// Missing type defaults to reference (TS extractor.ts:342-345).
		if got[1].typ != "reference" {
			t.Errorf("type should default to reference, got %q", got[1].typ)
		}
	})

	t.Run("invalid blocks dropped", func(t *testing.T) {
		text := strings.Join([]string{
			"MEMORY_NAME: no-body",
			"MEMORY_DESC: body missing",
			"---",
			"MEMORY_TYPE: project",
			"MEMORY_BODY: name missing",
			"---",
			"MEMORY_NAME: bad name",
			"MEMORY_BODY: name has a space",
		}, "\n")
		if got := parseTextMemoryBlocks(text); len(got) != 0 {
			t.Errorf("invalid blocks should be dropped, got %+v", got)
		}
	})

	t.Run("case-insensitive keys", func(t *testing.T) {
		text := "memory_name: ci-note\nmemory_body: works"
		got := parseTextMemoryBlocks(text)
		if len(got) != 1 || got[0].name != "ci-note" || got[0].body != "works" {
			t.Errorf("keys should match case-insensitively, got %+v", got)
		}
	})

	// TS split(/^---\s*$/m) uses the JS \s class: a NBSP-guarded separator
	// line splits the text (Go's ASCII \s would miss it), and text.trim()
	// strips a U+FEFF BOM before the NONE check.
	t.Run("JS whitespace in separators and trims", func(t *testing.T) {
		text := strings.Join([]string{
			"MEMORY_NAME: first",
			"MEMORY_BODY: one",
			"---\u00a0",
			"MEMORY_NAME: second",
			"MEMORY_BODY: two",
		}, "\n")
		got := parseTextMemoryBlocks(text)
		if len(got) != 2 {
			t.Fatalf("NBSP-guarded --- line must split blocks, got %d: %+v", len(got), got)
		}
		if got := parseTextMemoryBlocks("\uFEFFNONE\uFEFF"); got != nil {
			t.Errorf("BOM-wrapped NONE should parse to nothing, got %+v", got)
		}
		if got := parseTextMemoryBlocks("\uFEFFMEMORY_NAME: bom\nMEMORY_BODY: kept\uFEFF"); len(got) != 1 || got[0].body != "kept" {
			t.Errorf("BOM-wrapped block should parse and trim, got %+v", got)
		}
	})
}

func TestFormatMemoryFile(t *testing.T) {
	got := formatMemoryFile(parsedTextMemory{
		name:        "my-note",
		typ:         "feedback",
		description: `says "no mocks"`,
		body:        "Rule body.",
	})
	want := "---\nname: \"my-note\"\ndescription: \"says \\\"no mocks\\\"\"\ntype: \"feedback\"\n---\n\nRule body.\n"
	if got != want {
		t.Errorf("format mismatch:\ngot:  %q\nwant: %q", got, want)
	}
}

// The double-quoted style must emit the js-yaml escape table: named escapes
// \0 \a \b \v \f \e (plus the \t \n \r \" \\ already covered), \N \_ \L \P,
// and \xNN/\uNNNN with UPPERCASE hex for the remaining non-printables
// (dumper.js ESCAPE_SEQUENCES + encodeHex).
func TestYamlDoubleQuoteEscapeTable(t *testing.T) {
	cases := map[string]string{
		"\x00":       `"\0"`,
		"\x07":       `"\a"`,
		"\x08":       `"\b"`,
		"\x09":       `"\t"`,
		"\x0a":       `"\n"`,
		"\x0b":       `"\v"`,
		"\x0c":       `"\f"`,
		"\x0d":       `"\r"`,
		"\x1b":       `"\e"`,
		`"`:          `"\""`,
		`\`:          `"\\"`,
		"\x01":       `"\x01"`,
		"\x7f":       `"\x7F"`,
		"\u0085":     `"\N"`,
		"\u00a0":     `"\_"`,
		"\u2028":     `"\L"`,
		"\u2029":     `"\P"`,
		"\ufeff":     `"\uFEFF"`,
		"\ufffe":     `"\uFFFE"`,
		"a\x1fb":     `"a\x1Fb"`,
		"plain — ok": `"plain — ok"`,
		"\U0001D11E": "\"\U0001D11E\"", // printable astral code point passes through
		"":           `""`,
	}
	for in, want := range cases {
		if got := yamlDoubleQuote(in); got != want {
			t.Errorf("yamlDoubleQuote(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestScanExistingMemories(t *testing.T) {
	tmp := t.TempDir()
	memDir := memory.GetAutoMemPath(tmp)
	if err := os.MkdirAll(memDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(memDir, "a.md"), "---\nname: a\ndescription: first note\nmetadata:\n  type: project\n---\nbody")
	writeFile(t, filepath.Join(memDir, "MEMORY.md"), "index, must be skipped")
	writeFile(t, filepath.Join(memDir, "skip.txt"), "not markdown")

	e := InitExtractMemories(Deps{MemoryDir: memDir, ProjectRoot: tmp})
	got := e.scanExistingMemories()
	if !strings.Contains(got, "- [project] a.md: first note") {
		t.Errorf("manifest line missing, got: %q", got)
	}
	if strings.Contains(got, "MEMORY.md") || strings.Contains(got, "skip.txt") {
		t.Errorf("index/non-md files should be skipped, got: %q", got)
	}
}

func TestDirForMemoryType(t *testing.T) {
	e := InitExtractMemories(Deps{
		MemoryDir:     "/proj/.yukino/memory/",
		UserMemoryDir: "/home/u/.yukino/memory/",
	})
	if got := e.dirForMemoryType("user"); got != "/home/u/.yukino/memory" {
		t.Errorf("user -> user dir, got %q", got)
	}
	if got := e.dirForMemoryType("Feedback"); got != "/home/u/.yukino/memory" {
		t.Errorf("feedback (any case) -> user dir, got %q", got)
	}
	if got := e.dirForMemoryType("project"); got != "/proj/.yukino/memory" {
		t.Errorf("project -> project dir, got %q", got)
	}
	if got := e.dirForMemoryType("reference"); got != "/proj/.yukino/memory" {
		t.Errorf("reference -> project dir, got %q", got)
	}

	// Without a configured user dir everything lands in the project dir.
	e2 := InitExtractMemories(Deps{MemoryDir: "/proj/.yukino/memory/"})
	if got := e2.dirForMemoryType("user"); got != "/proj/.yukino/memory" {
		t.Errorf("unset user dir should fall back to project dir, got %q", got)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
