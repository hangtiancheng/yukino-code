package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func TestRenderDiffLinesColorsByPrefix(t *testing.T) {
	before := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(before)
	lines := strings.Split(renderDiffLines("summary\n   10 context\n-   11 old\n+   11 new"), "\n")
	for i, expected := range []struct{ text, color string }{
		{"summary", Theme.ToolDiffContext},
		{"   10 context", Theme.ToolDiffContext},
		{"-   11 old", Theme.ToolDiffRemoved},
		{"+   11 new", Theme.ToolDiffAdded},
	} {
		if lines[i] != paint(expected.text, expected.color) {
			t.Errorf("line %d: %q", i, lines[i])
		}
		if visibleWidth(lines[i]) != len(expected.text) {
			t.Errorf("diff added indentation: %q", lines[i])
		}
	}
}
