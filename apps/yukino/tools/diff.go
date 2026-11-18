package tools

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const (
	diffContextLines = 3
	maxDiffLines     = 200
)

type DiffResult struct {
	Text      string
	Additions int
	Removals  int
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func BuildDiff(oldContent, newContent string) DiffResult {
	oldLines := strings.Split(oldContent, "\n")
	newLines := strings.Split(newContent, "\n")

	prefixLen := 0
	maxPrefix := min(len(oldLines), len(newLines))
	for prefixLen < maxPrefix && oldLines[prefixLen] == newLines[prefixLen] {
		prefixLen++
	}

	suffixLen := 0
	maxSuffix := maxPrefix - prefixLen
	for suffixLen < maxSuffix &&
		oldLines[len(oldLines)-1-suffixLen] == newLines[len(newLines)-1-suffixLen] {
		suffixLen++
	}

	removedLines := oldLines[prefixLen : len(oldLines)-suffixLen]
	addedLines := newLines[prefixLen : len(newLines)-suffixLen]

	contextStart := max(0, prefixLen-diffContextLines)
	contextBefore := oldLines[contextStart:prefixLen]
	contextEnd := min(len(oldLines), len(oldLines)-suffixLen+diffContextLines)
	contextAfter := oldLines[len(oldLines)-suffixLen : contextEnd]

	var out []string
	oldLineNo := contextStart + 1
	newLineNo := contextStart + 1
	truncated := false
	additions, removals := 0, 0

	push := func(prefix string, lineNo int, content string) {
		if len(out) >= maxDiffLines {
			truncated = true
			return
		}
		out = append(out, fmt.Sprintf("%s %4d  %s", prefix, lineNo, content))
	}

	for _, l := range contextBefore {
		push(" ", oldLineNo, l)
		oldLineNo++
		newLineNo++
	}
	if len(removedLines) == len(addedLines) {
		for i, old := range removedLines {
			if old == addedLines[i] {
				push(" ", newLineNo, addedLines[i])
			} else {
				push("-", oldLineNo, old)
				push("+", newLineNo, addedLines[i])
				removals++
				additions++
			}
			oldLineNo++
			newLineNo++
		}
	} else {
		for _, line := range removedLines {
			push("-", oldLineNo, line)
			oldLineNo++
		}
		for _, line := range addedLines {
			push("+", newLineNo, line)
			newLineNo++
		}
		additions = len(addedLines)
		removals = len(removedLines)
	}
	for _, l := range contextAfter {
		push(" ", newLineNo, l)
		oldLineNo++
		newLineNo++
	}

	if truncated {
		out = append(out, fmt.Sprintf("  ... (diff truncated at %d lines)", maxDiffLines))
	}

	return DiffResult{
		Text:      strings.Join(out, "\n"),
		Additions: additions,
		Removals:  removals,
	}
}

var diffNumberPattern = regexp.MustCompile(`(?s)^([ +-])\s+(\d+) {2}(.*)$`)

func BuildEditDiff(content string, replacements []TextReplacement) DiffResult {
	starts := []int{0}
	for i := range len(content) {
		if content[i] == '\n' {
			starts = append(starts, i+1)
		}
	}
	type group struct {
		start, end   int
		replacements []TextReplacement
	}
	var groups []group
	line := 0
	for _, replacement := range replacements {
		for line+1 < len(starts) && starts[line+1] <= replacement.Start {
			line++
		}
		start := max(0, line-diffContextLines)
		end := line
		for end+1 < len(starts) && starts[end+1] <= replacement.End {
			end++
		}
		end = min(len(starts), end+1+diffContextLines)
		if len(groups) > 0 && start <= groups[len(groups)-1].end {
			previous := &groups[len(groups)-1]
			previous.end = max(previous.end, end)
			previous.replacements = append(previous.replacements, replacement)
		} else {
			groups = append(groups, group{start, end, []TextReplacement{replacement}})
		}
	}
	var output []string
	additions, removals, delta := 0, 0, 0
	truncated := false
	for _, g := range groups {
		start, end := starts[g.start], len(content)
		if g.end < len(starts) {
			end = starts[g.end]
		}
		before := content[start:end]
		var parts strings.Builder
		cursor := start
		for _, replacement := range g.replacements {
			parts.WriteString(content[cursor:replacement.Start])
			parts.WriteString(replacement.Text)
			cursor = replacement.End
		}
		parts.WriteString(content[cursor:end])
		after := parts.String()
		diff := BuildDiff(before, after)
		additions += diff.Additions
		removals += diff.Removals
		if len(output) > 0 && len(output) < maxDiffLines {
			output = append(output, "  ...")
		}
		for _, text := range strings.Split(diff.Text, "\n") {
			match := diffNumberPattern.FindStringSubmatch(text)
			if match == nil || len(output) >= maxDiffLines {
				truncated = true
				continue
			}
			offset := g.start
			if match[1] != "-" {
				offset += delta
			}
			number, _ := strconv.Atoi(match[2])
			output = append(output, fmt.Sprintf("%s %4d  %s", match[1], number+offset, match[3]))
		}
		delta += strings.Count(after, "\n") - strings.Count(before, "\n")
	}
	if truncated {
		output = append(output, fmt.Sprintf("  ... (diff truncated at %d lines)", maxDiffLines))
	}
	return DiffResult{strings.Join(output, "\n"), additions, removals}
}
