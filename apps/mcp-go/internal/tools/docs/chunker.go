package docs

import (
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

// MarkdownChunk is one retrieval unit and the heading that labels it.
type MarkdownChunk struct {
	Content string
	Title   string
}

const (
	// ChunkSize is measured in JavaScript UTF-16 code units.
	ChunkSize = 1000
	// ChunkOverlap is how much of the previous chunk is retained when merging splits.
	ChunkOverlap = 200
)

// markdownSeparators follow RecursiveCharacterTextSplitter.fromLanguage("markdown").
// Heading level 1 is intentionally absent; titles are recovered from the chunk text.
var markdownSeparators = []string{
	"\n## ",
	"\n### ",
	"\n#### ",
	"\n##### ",
	"\n###### ",
	"```\n\n",
	"\n\n***\n\n",
	"\n\n---\n\n",
	"\n\n___\n\n",
	"\n\n",
	"\n",
	" ",
	"",
}

var headingPattern = regexp.MustCompile(`^#{1,6} +(.+)$`)

// SplitMarkdown splits content with the markdown recursive splitter and tags each
// chunk with the nearest heading. Empty and whitespace-only input yields no chunks.
func SplitMarkdown(content string) []MarkdownChunk {
	units := utf16.Encode([]rune(content))
	separators := make([][]uint16, len(markdownSeparators))
	for i, separator := range markdownSeparators {
		separators[i] = utf16.Encode([]rune(separator))
	}
	parts := splitText(units, separators)
	chunks := make([]MarkdownChunk, 0, len(parts))
	currentTitle := ""
	for _, units := range parts {
		part := string(utf16.Decode(units))
		titles := headingsIn(part)
		title := currentTitle
		if len(titles) > 0 {
			title = titles[0]
			currentTitle = titles[len(titles)-1]
		}
		chunks = append(chunks, MarkdownChunk{Content: part, Title: title})
	}
	return chunks
}

func headingsIn(chunk string) []string {
	var titles []string
	for _, line := range strings.Split(chunk, "\n") {
		match := headingPattern.FindStringSubmatch(line)
		if match != nil {
			titles = append(titles, operations.TrimJS(match[1]))
		}
	}
	return titles
}

func indexUnits(text, separator []uint16) int {
	for i := 0; i+len(separator) <= len(text); i++ {
		if slices.Equal(text[i:i+len(separator)], separator) {
			return i
		}
	}
	return -1
}

func splitText(text []uint16, separators [][]uint16) [][]uint16 {
	separator := separators[len(separators)-1]
	var next [][]uint16
	for i, candidate := range separators {
		if len(candidate) == 0 {
			separator = candidate
			break
		}
		if indexUnits(text, candidate) >= 0 {
			separator = candidate
			next = separators[i+1:]
			break
		}
	}
	splits := splitOnSeparator(text, separator)
	var final, good [][]uint16
	for _, piece := range splits {
		if len(piece) < ChunkSize {
			good = append(good, piece)
			continue
		}
		if len(good) > 0 {
			final = append(final, mergeSplits(good)...)
			good = nil
		}
		if next == nil {
			final = append(final, piece)
		} else {
			final = append(final, splitText(piece, next)...)
		}
	}
	if len(good) > 0 {
		final = append(final, mergeSplits(good)...)
	}
	return final
}

func splitOnSeparator(text, separator []uint16) [][]uint16 {
	if len(separator) == 0 {
		parts := make([][]uint16, 0, len(text))
		for i := range text {
			parts = append(parts, text[i:i+1])
		}
		return parts
	}
	var indexes []int
	for start := 0; ; {
		rel := indexUnits(text[start:], separator)
		if rel < 0 {
			break
		}
		indexes = append(indexes, start+rel)
		start += rel + len(separator)
	}
	if len(indexes) == 0 {
		if len(text) == 0 {
			return nil
		}
		return [][]uint16{text}
	}
	parts := make([][]uint16, 0, len(indexes)+1)
	if indexes[0] > 0 {
		parts = append(parts, text[:indexes[0]])
	}
	for i, index := range indexes {
		end := len(text)
		if i+1 < len(indexes) {
			end = indexes[i+1]
		}
		if index < end {
			parts = append(parts, text[index:end])
		}
	}
	return parts
}

func mergeSplits(splits [][]uint16) [][]uint16 {
	var docs, current [][]uint16
	total := 0
	for _, piece := range splits {
		length := len(piece)
		if total+length > ChunkSize && len(current) > 0 {
			if doc := joinDocs(current); len(doc) > 0 {
				docs = append(docs, doc)
			}
			for total > ChunkOverlap || (total+length > ChunkSize && total > 0) {
				total -= len(current[0])
				current = current[1:]
			}
		}
		current = append(current, piece)
		total += length
	}
	if doc := joinDocs(current); len(doc) > 0 {
		docs = append(docs, doc)
	}
	return docs
}

func joinDocs(parts [][]uint16) []uint16 {
	var joined []uint16
	for _, part := range parts {
		joined = append(joined, part...)
	}
	// Trim in code-unit space so an isolated surrogate is preserved until the
	// complete chunk is encoded as UTF-8, exactly as the TS SQLite writer does.
	whitespace := func(unit uint16) bool { return operations.TrimJS(string(rune(unit))) == "" }
	for len(joined) > 0 && whitespace(joined[0]) {
		joined = joined[1:]
	}
	for len(joined) > 0 && whitespace(joined[len(joined)-1]) {
		joined = joined[:len(joined)-1]
	}
	return joined
}
