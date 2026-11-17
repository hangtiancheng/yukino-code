package ui

import (
	"regexp"
	"strings"
	"unicode/utf8"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"github.com/rivo/uniseg"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

func textForKey(key tea.KeyMsg) (string, bool) {
	if key.Alt {
		return "", false
	}
	switch key.Type {
	case tea.KeySpace:
		return " ", true
	case tea.KeyRunes:
		return string(key.Runes), true
	}
	return "", false
}

func visibleWidth(text string) int {
	return ansi.StringWidth(text)
}

func wrapToLines(text string, width int) []string {
	return wrapTerminalText(text, width, false)
}

func wrapWordsToLines(text string, width int) []string {
	return wrapTerminalText(text, width, true)
}

// truncateToWidth mirrors src/ui/terminal-text.ts truncateToWidth.
func truncateToWidth(text string, width int, suffix string) string {
	columns := width
	if columns < 0 {
		columns = 0
	}
	if visibleWidth(text) <= columns {
		return text
	}
	ending := ansi.Cut(suffix, 0, columns)
	return ansi.Cut(text, 0, max(0, columns-visibleWidth(ending))) + ending
}

var plainNewlineRun = regexp.MustCompile(`\n+`)

// plainTerminalText mirrors src/utils/index.ts plainTerminalText.
func plainTerminalText(text string) string { return utils.PlainTerminalText(text) }

// plainTerminalLine mirrors src/ui/terminal-text.ts plainTerminalLine.
func plainTerminalLine(text string) string {
	return expandTabs(plainNewlineRun.ReplaceAllString(plainTerminalText(text), " "))
}

// expandTabs mirrors src/ui/terminal-text.ts expandTabs (two-column stops).
func expandTabs(text string) string {
	if !strings.Contains(text, "\t") {
		return text
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if !strings.Contains(line, "\t") {
			continue
		}
		segments := strings.Split(line, "\t")
		expanded := segments[0]
		for _, segment := range segments[1:] {
			advance := TabSize - (visibleWidth(expanded) % TabSize)
			expanded += strings.Repeat(" ", advance) + segment
		}
		lines[i] = expanded
	}
	return strings.Join(lines, "\n")
}

// graphemeBounds returns the rune indices of every grapheme cluster boundary,
// starting at 0 and ending at the rune count.
func graphemeBounds(value string) []int {
	bounds := []int{0}
	runes := 0
	rest := value
	for len(rest) > 0 {
		cluster, remaining, _, _ := uniseg.FirstGraphemeClusterInString(rest, -1)
		rest = remaining
		runes += utf8.RuneCountInString(cluster)
		bounds = append(bounds, runes)
	}
	return bounds
}

// previousGraphemeBoundary mirrors src/ui/terminal-text.ts; indices are rune
// offsets into the value.
func previousGraphemeBoundary(bounds []int, index int) int {
	if index <= 0 {
		return 0
	}
	previous := 0
	for _, start := range bounds[:len(bounds)-1] {
		if start >= index {
			return previous
		}
		previous = start
	}
	return previous
}

// nextGraphemeBoundary mirrors src/ui/terminal-text.ts.
func nextGraphemeBoundary(bounds []int, index int) int {
	end := bounds[len(bounds)-1]
	if index < 0 {
		index = 0
	}
	if index >= end {
		return end
	}
	for i := 0; i < len(bounds)-1; i++ {
		start := bounds[i]
		clusterEnd := bounds[i+1]
		if start >= index {
			if start == index {
				return clusterEnd
			}
			return start
		}
		if clusterEnd > index {
			return clusterEnd
		}
	}
	return end
}

// clampToGraphemeBoundary mirrors src/ui/terminal-text.ts.
func clampToGraphemeBoundary(bounds []int, index int) int {
	end := bounds[len(bounds)-1]
	if index < 0 {
		index = 0
	}
	if index > end {
		index = end
	}
	previous := previousGraphemeBoundary(bounds, index)
	if nextGraphemeBoundary(bounds, previous) == index {
		return index
	}
	return previous
}

type cursorWindowResult struct {
	before           string
	current          string
	after            string
	leadingEllipsis  bool
	trailingEllipsis bool
}

func boolColumn(b bool) int {
	if b {
		return 1
	}
	return 0
}

// cursorWindow mirrors src/ui/terminal-text.ts cursorWindow: a cursor-centered
// field view that never exceeds the given columns.
func cursorWindow(value string, cursor int, maxWidth int) cursorWindowResult {
	columns := maxWidth
	if columns < 1 {
		columns = 1
	}
	runes := []rune(value)
	bounds := graphemeBounds(value)
	position := clampToGraphemeBoundary(bounds, cursor)
	currentEnd := nextGraphemeBoundary(bounds, position)
	if currentEnd > len(runes) {
		currentEnd = len(runes)
	}
	current := string(runes[position:currentEnd])
	if current == "" {
		current = " "
	}
	currentValue := current
	if visibleWidth(current) > columns || visibleWidth(current) == 0 {
		currentValue = " "
	}
	currentWidth := visibleWidth(currentValue)
	left := string(runes[:position])
	rightStart := position
	if position < len(runes) {
		rightStart = currentEnd
	}
	right := string(runes[rightStart:])
	fullWidth := visibleWidth(value)
	if position == len(runes) {
		fullWidth += currentWidth
	}

	if fullWidth <= columns {
		return cursorWindowResult{before: left, current: currentValue, after: right}
	}

	leadingEllipsis := len(left) > 0
	trailingEllipsis := len(right) > 0
	for currentWidth+boolColumn(leadingEllipsis)+boolColumn(trailingEllipsis) > columns {
		if trailingEllipsis {
			trailingEllipsis = false
		} else {
			leadingEllipsis = false
		}
	}

	surroundingWidth := max(0, columns-currentWidth-boolColumn(leadingEllipsis)-boolColumn(trailingEllipsis))
	leftWidth := surroundingWidth / 2
	rightWidth := surroundingWidth - leftWidth
	availableLeftWidth := visibleWidth(left)
	availableRightWidth := visibleWidth(right)
	if availableLeftWidth < leftWidth {
		rightWidth += leftWidth - availableLeftWidth
		leftWidth = availableLeftWidth
	} else if availableRightWidth < rightWidth {
		leftWidth += rightWidth - availableRightWidth
		rightWidth = availableRightWidth
	}

	return cursorWindowResult{
		before:           ansi.Cut(left, max(0, availableLeftWidth-leftWidth), availableLeftWidth),
		current:          currentValue,
		after:            ansi.Cut(right, 0, rightWidth),
		leadingEllipsis:  leadingEllipsis,
		trailingEllipsis: trailingEllipsis,
	}
}
