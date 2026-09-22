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
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	"github.com/hangtiancheng/yukino-code/yukino/memory"
	"github.com/hangtiancheng/yukino-code/yukino/permissions"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// parsedTextMemory is a memory block parsed from LLM streamed text
// (MEMORY_NAME/MEMORY_TYPE/MEMORY_DESC/MEMORY_BODY). TS extractor.ts:50-56.
type parsedTextMemory struct {
	name        string
	typ         string
	description string
	body        string
}

var (
	// textBlockSepRe splits streamed text on standalone --- lines (TS
	// extractor.ts:290 — m flag lets ^/$ match line start/end). The character
	// class spells out the JS \s set: RE2's \s is ASCII-only and misses the
	// NBSP/U+FEFF/line-separator whitespace TS matches.
	textBlockSepRe = regexp.MustCompile(`(?m)^---[` + jsSpaceClass + `]*$`)
	textNameRe     = regexp.MustCompile(`(?i)^MEMORY_NAME:[` + jsSpaceClass + `]*(.*)$`)
	textTypeRe     = regexp.MustCompile(`(?i)^MEMORY_TYPE:[` + jsSpaceClass + `]*(.*)$`)
	textDescRe     = regexp.MustCompile(`(?i)^MEMORY_DESC:[` + jsSpaceClass + `]*(.*)$`)
	textBodyRe     = regexp.MustCompile(`(?i)^MEMORY_BODY:[` + jsSpaceClass + `]?(.*)$`)
	// textNameValidRe mirrors TS /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u
	// (extractor.ts:339).
	textNameValidRe = regexp.MustCompile(`^[\pL\pN][\pL\pN._-]*$`)

	// scanTypeRe / scanDescRe pull type/description out of raw file content
	// for the dedup manifest (TS extractor.ts:138-139).
	scanTypeRe = regexp.MustCompile(`type:[` + jsSpaceClass + `]*(.+)`)
	scanDescRe = regexp.MustCompile(`description:[` + jsSpaceClass + `]*(.+)`)
)

// jsSpaceClass is the JS \s class (ECMA-262 WhiteSpace + LineTerminator) in
// RE2 syntax: unlike Go's ASCII-only \s it covers NBSP, U+FEFF, and the
// Unicode space separators and line separators.
const jsSpaceClass = `\t\n\v\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

// isJSSpace mirrors the JS \s class as a rune predicate (see the memory
// package helper of the same name).
func isJSSpace(r rune) bool {
	return r == 0xFEFF || (unicode.IsSpace(r) && r != 0x85)
}

// trimJSSpace mirrors String.prototype.trim (TS text.trim(), extractor.ts:283).
func trimJSSpace(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

// scanExistingMemories scans existing memory files and builds a manifest for
// LLM deduplication (TS extractor.ts:118-154): top-level .md files (excluding
// MEMORY.md) in the project dir then the user dir, one `- [type] file: desc`
// line each.
func (e *Extractor) scanExistingMemories() string {
	var entries []string
	for _, dir := range []string{e.projectMemDir(), e.userMemDir()} {
		if dir == "" {
			continue
		}
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() {
				continue
			}
			name := f.Name()
			if !strings.HasSuffix(name, ".md") || name == memory.AutoMemEntrypointName {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				continue
			}
			content := string(data)
			typ := "reference"
			if m := scanTypeRe.FindStringSubmatch(content); m != nil {
				typ = trimJSSpace(m[1])
			}
			desc := ""
			if m := scanDescRe.FindStringSubmatch(content); m != nil {
				desc = trimJSSpace(m[1])
			}
			entries = append(entries, fmt.Sprintf("- [%s] %s: %s", typ, name, desc))
		}
	}
	return strings.Join(entries, "\n")
}

// persistTextMemories is the text protocol fallback: when the sub-agent did
// not invoke any tools but instead emitted structured text blocks
// (MEMORY_NAME/MEMORY_TYPE/MEMORY_DESC/MEMORY_BODY, separated by a standalone
// `---` line), parse them locally and persist by type (TS extractor.ts:251-279).
// Returns the list of written memory names (without extensions). Like the TS
// version, a mkdir/write failure aborts the whole fallback path with an error.
func (e *Extractor) persistTextMemories(text string) ([]string, error) {
	memories := parseTextMemoryBlocks(text)
	if len(memories) == 0 {
		return nil, nil
	}

	checker := memory.NewSubAgentChecker(e.deps.ProjectRoot, e.deps.UserMemoryDir, false)
	var saved []string
	for _, mem := range memories {
		dir := e.dirForMemoryType(mem.typ)
		filePath := filepath.Join(dir, mem.name+".md")
		if checker.Check(&tools.WriteFileTool{}, map[string]any{"file_path": filePath}).Effect != permissions.Allow {
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return saved, err
		}
		if err := os.WriteFile(filePath, []byte(formatMemoryFile(mem)), 0o644); err != nil {
			return saved, err
		}
		saved = append(saved, mem.name)
	}
	return saved, nil
}

// parseTextMemoryBlocks parses structured text blocks; returns nil for NONE or
// empty text (TS extractor.ts:281-298).
func parseTextMemoryBlocks(text string) []parsedTextMemory {
	// TS text.trim() strips the JS whitespace set (U+FEFF included, U+0085
	// excluded), so a BOM-wrapped NONE/block still parses.
	trimmed := trimJSSpace(text)
	if trimmed == "" || trimmed == "NONE" {
		return nil
	}

	var memories []parsedTextMemory
	for _, block := range textBlockSepRe.Split(trimmed, -1) {
		if mem, ok := parseTextMemoryBlock(block); ok {
			memories = append(memories, mem)
		}
	}
	return memories
}

// parseTextMemoryBlock parses a single block; MEMORY_BODY supports multi-line.
// Returns false for blocks without a valid MEMORY_NAME or with an empty body
// (TS extractor.ts:300-347).
func parseTextMemoryBlock(block string) (parsedTextMemory, bool) {
	var mem parsedTextMemory
	var bodyLines []string
	inBody := false

	for _, line := range strings.Split(block, "\n") {
		switch {
		case textNameRe.MatchString(line):
			mem.name = trimJSSpace(textNameRe.FindStringSubmatch(line)[1])
			inBody = false
		case textTypeRe.MatchString(line):
			mem.typ = trimJSSpace(textTypeRe.FindStringSubmatch(line)[1])
			inBody = false
		case textDescRe.MatchString(line):
			mem.description = trimJSSpace(textDescRe.FindStringSubmatch(line)[1])
			inBody = false
		case textBodyRe.MatchString(line):
			mem.body = textBodyRe.FindStringSubmatch(line)[1]
			inBody = true
		default:
			if inBody {
				bodyLines = append(bodyLines, line)
			}
		}
	}

	all := bodyLines
	if mem.body != "" {
		all = append([]string{mem.body}, bodyLines...)
	}
	// TS join("\n").trimEnd() uses the JS whitespace set.
	mem.body = strings.TrimRightFunc(strings.Join(all, "\n"), isJSSpace)

	if !textNameValidRe.MatchString(mem.name) || trimJSSpace(mem.body) == "" {
		return parsedTextMemory{}, false
	}
	if mem.typ == "" {
		// Default to project-level reference when no type is given.
		mem.typ = "reference"
	}
	return mem, true
}

// dirForMemoryType routes to the appropriate directory by type: user/feedback
// -> user-level; otherwise -> project-level (TS extractor.ts:349-356). The Go
// port keeps the user dir injectable; when it is unset (chat-server isolation)
// every type lands in the project dir.
func (e *Extractor) dirForMemoryType(typ string) string {
	t := strings.ToLower(typ)
	if (t == "user" || t == "feedback") && e.deps.UserMemoryDir != "" {
		return e.userMemDir()
	}
	return e.projectMemDir()
}

// formatMemoryFile formats a memory file: frontmatter (name/description/type)
// + body (TS extractor.ts:358-365 — js-yaml dump with forceQuotes,
// lineWidth -1, double-quote style).
func formatMemoryFile(mem parsedTextMemory) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + yamlDoubleQuote(mem.name) + "\n")
	b.WriteString("description: " + yamlDoubleQuote(mem.description) + "\n")
	b.WriteString("type: " + yamlDoubleQuote(mem.typ) + "\n")
	b.WriteString("---\n\n")
	b.WriteString(mem.body)
	b.WriteString("\n")
	return b.String()
}

// yamlDoubleQuote renders s as a YAML double-quoted scalar with the js-yaml
// escape table (dumper.js ESCAPE_SEQUENCES + isPrintable + encodeHex): named
// escapes for the control characters that have them (\0 \a \b \t \n \v \f \r
// \e \" \\) plus \N (NEL), \_ (NBSP), \L/\P (line/paragraph separators), and
// \xNN/\uNNNN/\UNNNNNNNN (zero-padded uppercase hex) for every other
// non-printable code point.
func yamlDoubleQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case 0x00:
			b.WriteString(`\0`)
		case 0x07:
			b.WriteString(`\a`)
		case 0x08:
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case 0x0B:
			b.WriteString(`\v`)
		case 0x0C:
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		case 0x1B:
			b.WriteString(`\e`)
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case 0x85:
			b.WriteString(`\N`)
		case 0xA0:
			b.WriteString(`\_`)
		case 0x2028:
			b.WriteString(`\L`)
		case 0x2029:
			b.WriteString(`\P`)
		default:
			if yamlIsPrintable(r) {
				b.WriteRune(r)
			} else {
				b.WriteString(yamlEncodeHex(r))
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// yamlIsPrintable mirrors the js-yaml isPrintable predicate (dumper.js:188-193,
// derived from the YAML nb-char production minus \t, #x85, #xA0, #x2028, #x2029).
func yamlIsPrintable(c rune) bool {
	return (c >= 0x20 && c <= 0x7E) ||
		(c >= 0xA1 && c <= 0xD7FF && c != 0x2028 && c != 0x2029) ||
		(c >= 0xE000 && c <= 0xFFFD && c != 0xFEFF) ||
		(c >= 0x10000 && c <= 0x10FFFF)
}

// yamlEncodeHex mirrors the js-yaml encodeHex helper: \x for code points up to
// 0xFF, \u up to 0xFFFF, \U beyond, zero-padded with uppercase hex digits
// (toString(16).toUpperCase()).
func yamlEncodeHex(c rune) string {
	switch {
	case c <= 0xFF:
		return fmt.Sprintf(`\x%02X`, c)
	case c <= 0xFFFF:
		return fmt.Sprintf(`\u%04X`, c)
	default:
		return fmt.Sprintf(`\U%08X`, c)
	}
}
