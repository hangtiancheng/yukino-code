package docs

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// MarkdownChunk is one retrieval unit and the heading that labels it.
type MarkdownChunk struct {
	Content string
	Title   string
}

const (
	// ChunkSize is the maximum chunk length in bytes, matching the TypeScript splitter.
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
	parts := splitText(content, markdownSeparators)
	chunks := make([]MarkdownChunk, 0, len(parts))
	currentTitle := ""
	for _, part := range parts {
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
			titles = append(titles, strings.TrimSpace(match[1]))
		}
	}
	return titles
}

func splitText(text string, separators []string) []string {
	separator := separators[len(separators)-1]
	var next []string
	for i, candidate := range separators {
		if candidate == "" {
			separator = candidate
			break
		}
		if strings.Contains(text, candidate) {
			separator = candidate
			next = separators[i+1:]
			break
		}
	}
	splits := splitOnSeparator(text, separator)
	var final []string
	var good []string
	for _, piece := range splits {
		if len(piece) < ChunkSize {
			good = append(good, piece)
			continue
		}
		if len(good) > 0 {
			final = append(final, mergeSplits(good, "")...)
			good = nil
		}
		if next == nil {
			final = append(final, piece)
		} else {
			final = append(final, splitText(piece, next)...)
		}
	}
	if len(good) > 0 {
		final = append(final, mergeSplits(good, "")...)
	}
	return final
}

func splitOnSeparator(text, separator string) []string {
	if separator == "" {
		if text == "" {
			return nil
		}
		parts := make([]string, 0, utf8.RuneCountInString(text))
		for _, r := range text {
			parts = append(parts, string(r))
		}
		return parts
	}
	var indexes []int
	for start := 0; ; {
		rel := strings.Index(text[start:], separator)
		if rel < 0 {
			break
		}
		indexes = append(indexes, start+rel)
		start += rel + len(separator)
	}
	if len(indexes) == 0 {
		if text == "" {
			return nil
		}
		return []string{text}
	}
	parts := make([]string, 0, len(indexes)+1)
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

func mergeSplits(splits []string, separator string) []string {
	var docs []string
	var current []string
	total := 0
	for _, piece := range splits {
		length := len(piece)
		if total+length+len(current)*len(separator) > ChunkSize && len(current) > 0 {
			if doc := joinDocs(current, separator); doc != "" {
				docs = append(docs, doc)
			}
			for total > ChunkOverlap || (total+length+len(current)*len(separator) > ChunkSize && total > 0) {
				total -= len(current[0])
				current = current[1:]
			}
		}
		current = append(current, piece)
		total += length
	}
	if doc := joinDocs(current, separator); doc != "" {
		docs = append(docs, doc)
	}
	return docs
}

func joinDocs(docs []string, separator string) string {
	return strings.TrimSpace(strings.Join(docs, separator))
}
