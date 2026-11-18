// Package frontmatter extracts a leading YAML frontmatter block. Delimiters
// must occupy their own lines, so "---" inside a value or the body is content.
package frontmatter

import (
	"regexp"
	"strings"
)

var blockRE = regexp.MustCompile(`^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)`)

// Split strips a leading BOM and extracts the frontmatter block. It returns the
// trimmed frontmatter, the trimmed body that follows it, and whether a block was
// found. Without a block, frontmatter is empty and body is the trimmed input.
func Split(content string) (frontmatter, body string, ok bool) {
	content = strings.TrimPrefix(content, "\ufeff")
	m := blockRE.FindStringSubmatch(content)
	if m == nil {
		return "", strings.TrimSpace(content), false
	}
	return strings.TrimSpace(m[1]), strings.TrimSpace(content[len(m[0]):]), true
}
