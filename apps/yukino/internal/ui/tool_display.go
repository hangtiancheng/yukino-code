package ui

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/charmbracelet/lipgloss"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

type toolBlockInfo struct {
	toolID, toolName         string
	args                     map[string]any
	output, progress, status string
	isError                  bool
	elapsed                  float64
	loading                  bool
}

func ansiStyle(text, open, close string) string {
	if text == "" {
		return ""
	}
	text = strings.ReplaceAll(text, close, open)
	text = strings.ReplaceAll(text, "\n", close+"\n"+open)
	return open + text + close
}
func paint(text, color string) string {
	var r, g, b uint8
	if _, err := fmt.Sscanf(color, "#%02x%02x%02x", &r, &g, &b); err != nil {
		return text
	}
	return ansiStyle(text, fmt.Sprintf("\x1b[38;2;%d;%d;%dm", r, g, b), "\x1b[39m")
}

func isDiffTool(name string) bool { return name == "EditFile" }

func renderDiffLines(output string) string {
	lines := strings.Split(output, "\n")
	for i, line := range lines {
		color := Theme.ToolDiffContext
		if strings.HasPrefix(line, "+ ") {
			color = Theme.ToolDiffAdded
		}
		if strings.HasPrefix(line, "- ") {
			color = Theme.ToolDiffRemoved
		}
		lines[i] = paint(line, color)
	}
	return strings.Join(lines, "\n")
}

func formatToolOutputPreview(name, text string, width int) string {
	normalized := expandTabs(strings.TrimRightFunc(plainTerminalText(text), unicode.IsSpace))
	if isDiffTool(name) {
		normalized = renderDiffLines(normalized)
	}
	lines := wrapToLines(normalized, width)
	lower := strings.ToLower(name)
	if lower == "askuserquestion" {
		return strings.Join(lines, "\n")
	}
	limit := 10
	shell := strings.Contains(lower, "bash") || strings.Contains(lower, "powershell")
	switch {
	case strings.Contains(lower, "grep"):
		limit = 15
	case strings.Contains(lower, "glob") || strings.Contains(lower, "find") || strings.Contains(lower, "list"):
		limit = 20
	case shell:
		limit = 5
	}
	if len(lines) <= limit {
		return strings.Join(lines, "\n")
	}
	visible := lines[:limit]
	if shell {
		visible = lines[len(lines)-limit:]
	}
	return fmt.Sprintf("%s\n… (%d more lines, Ctrl+O to expand)", strings.Join(visible, "\n"), len(lines)-limit)
}

func (m Model) renderToolBlock(tb toolBlockInfo) string {
	columns := max(1, m.width)
	padding := boolColumn(columns > 2)
	width := columns - padding*2
	status := tb.status
	if status == "" {
		if tb.loading {
			status = "running"
		} else if tb.isError {
			status = "failed"
		}
	}
	background, color := Theme.ToolSuccessBg, Theme.Success
	label := ""
	switch status {
	case "running":
		background, color, label = Theme.ToolPendingBg, Theme.Accent, "● running"
	case "failed":
		background, color, label = Theme.ToolErrorBg, Theme.Error, "✗ failed"
	case "stopped":
		background, color, label = Theme.ToolStoppedBg, Theme.Warning, "– stopped"
	case "completed":
		label = "✓ completed"
	}
	shell := strings.EqualFold(tb.toolName, "Bash") || strings.EqualFold(tb.toolName, "PowerShell")
	args := utils.FormatToolArgs(tb.args)
	title := tb.toolName
	if args != "" {
		title += " " + args
	}
	title = plainTerminalLine(title)
	if shell {
		prefix := "$ "
		if strings.EqualFold(tb.toolName, "PowerShell") {
			prefix = "> "
		}
		title = expandTabs(plainTerminalText(prefix + args))
	}
	timing := ""
	if tb.elapsed > 0 {
		timing = fmt.Sprintf("%.1fs", tb.elapsed)
	}
	metadata := strings.Join(nonEmpty(label, timing), " · ")
	inline := metadata != "" && width >= visibleWidth(metadata)+4 && (!shell || !strings.Contains(title, "\n") && visibleWidth(title)+visibleWidth(metadata)+2 <= width)
	titleWidth := width
	if inline {
		titleWidth -= visibleWidth(metadata) + 2
	}
	titleLines := []string{truncateToWidth(title, titleWidth, "…")}
	if shell {
		titleLines = wrapToLines(title, titleWidth)
	}
	for i, line := range titleLines {
		titleLines[i] = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(Theme.ToolTitle)).Render(truncateToWidth(line, titleWidth, "…"))
	}
	lines := []string{strings.Join(titleLines, "\n")}
	if inline {
		lines[0] += "  " + paint(metadata, color)
	} else if metadata != "" {
		lines = append(lines, paint(strings.Join(wrapToLines(metadata, width), "\n"), color))
	}
	if tb.progress != "" {
		lines = append(lines, paint(truncateToWidth(plainTerminalLine(tb.progress), width, "…"), Theme.ToolOutput))
	}
	if tb.output != "" {
		preview := expandTabs(strings.TrimRightFunc(plainTerminalText(tb.output), unicode.IsSpace))
		if !m.toolsExpanded {
			preview = formatToolOutputPreview(tb.toolName, tb.output, width)
		}
		if isDiffTool(tb.toolName) {
			preview = renderDiffLines(preview)
		} else {
			preview = paint(preview, Theme.ToolOutput)
		}
		lines = append(lines, strings.Join(wrapTerminalTextOptions(preview, width, true, false), "\n"))
	}
	return "\n" + renderPanel("\n"+strings.Join(lines, "\n")+"\n", columns, padding, background, Theme.ToolOutput)
}

func renderPanel(text string, columns, padding int, background, foreground string) string {
	width := max(1, columns-padding*2)
	lines := wrapToLines(text, width)
	style := lipgloss.NewStyle().Foreground(lipgloss.Color(foreground))
	if background != "" {
		style = style.Background(lipgloss.Color(background))
	}
	for i, line := range lines {
		line = truncateToWidth(line, width, "…")
		if background != "" {
			line += strings.Repeat(" ", max(0, width-visibleWidth(line)))
		}
		lines[i] = style.Render(strings.Repeat(" ", padding) + line + strings.Repeat(" ", padding))
	}
	return strings.Join(lines, "\n")
}

func nonEmpty(values ...string) []string {
	var result []string
	for _, value := range values {
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}
