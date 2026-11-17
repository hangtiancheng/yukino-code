package ui

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Ports of src/ui/selector-list.tsx, src/ui/selector-search.ts and
// src/ui/list-window.ts: the shared searchable list used by the provider,
// model and session selectors.

// getListWindowStart mirrors src/ui/list-window.ts.
func getListWindowStart(itemCount, cursor, visibleCount int) int {
	if itemCount <= visibleCount {
		return 0
	}
	clampedCursor := max(0, min(cursor, itemCount-1))
	return min(max(0, clampedCursor-visibleCount+1), itemCount-visibleCount)
}

func dropLastGrapheme(value string) string {
	bounds := graphemeBounds(value)
	if len(bounds) < 2 {
		return ""
	}
	runes := []rune(value)
	return string(runes[:bounds[len(bounds)-2]])
}

// updateSelectorQuery mirrors src/ui/selector-search.ts.
func updateSelectorQuery(query string, msg tea.KeyMsg) string {
	if msg.Alt {
		return query
	}
	switch msg.Type {
	case tea.KeyCtrlU:
		return ""
	case tea.KeyBackspace, tea.KeyDelete:
		return dropLastGrapheme(query)
	case tea.KeyRunes, tea.KeySpace:
		raw, _ := textForKey(msg)
		if raw == "" {
			return query
		}
		if strings.Contains(raw, "\x1b") || regexp.MustCompile(`\[<\d+;\d+;\d+[Mm]`).MatchString(raw) {
			return query
		}
		raw = regexp.MustCompile(`[\r\n\t]+`).ReplaceAllString(raw, " ")
		text := strings.Map(func(r rune) rune {
			switch r {
			case '\r', '\n', '\t':
				return ' '
			}
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, raw)
		return query + text
	default:
		return query
	}
}

type selectorListRowParams struct {
	label       string
	description string
	detail      string
	hasDetail   bool
	focused     bool
	current     bool
	width       int
}

// renderSelectorListRow mirrors SelectorListRow in src/ui/selector-list.tsx.
func renderSelectorListRow(p selectorListRowParams) string {
	padding := 0
	if p.width > 4 {
		padding = 1
	}
	rowWidth := max(0, p.width-2*padding)
	pointer := "  "
	if p.focused {
		pointer = Icons.Arrow + " "
	}
	marker := ""
	if p.current {
		marker = " " + Icons.Success
	}
	labelWidth := max(0, rowWidth-visibleWidth(pointer)-visibleWidth(marker))
	singleLineLabel := plainTerminalLine(p.label)
	remainingWidth := labelWidth - visibleWidth(singleLineLabel) - 2
	descriptionText := ""
	if p.description != "" && remainingWidth >= 12 {
		descriptionText = "  " + truncateToWidth(plainTerminalLine(p.description), remainingWidth, "…")
	}

	labelColor := normalText
	if p.focused {
		labelColor = accentColor
	}
	pad := strings.Repeat(" ", padding)
	var sb strings.Builder
	sb.WriteString(pad)
	sb.WriteString(lipgloss.NewStyle().Foreground(labelColor).Bold(p.focused).Render(pointer + truncateToWidth(singleLineLabel, labelWidth, "…")))
	sb.WriteString(lipgloss.NewStyle().Foreground(greenText).Render(marker))
	sb.WriteString(lipgloss.NewStyle().Foreground(mutedText).Render(descriptionText))
	sb.WriteString("\n")
	if p.hasDetail {
		sb.WriteString(pad)
		sb.WriteString(selectorHintStyle().Render(truncateToWidth("  "+plainTerminalLine(p.detail), rowWidth, "…")))
		sb.WriteString("\n")
	}
	result := strings.TrimSuffix(sb.String(), "\n")
	if p.focused {
		result = lipgloss.NewStyle().Background(lipgloss.Color(Theme.SelectedBg)).Width(max(1, p.width)).Render(result)
	}
	return result + "\n"
}

type selectorListParams struct {
	title     string
	hint      string
	query     string
	emptyText string
	// itemCount is the filtered count; totalCount the unfiltered one.
	itemCount int
	// itemHeight is the number of rows each entry occupies.
	itemHeight   int
	totalCount   int
	cursor       int
	searchActive bool
	width        int
	rows         int
	// renderRows renders the visible window [start, start+count) at the given
	// content width.
	renderRows func(start, count, width int) string
}

// renderSelectorList mirrors SelectorList in src/ui/selector-list.tsx.
func renderSelectorList(p selectorListParams) string {
	width := max(1, p.width)
	contentWidth := width
	if width > 2 {
		contentWidth = width - 2
	}
	listRows := max(0, p.rows-selectorChrome(p.rows, false).height-1)
	visibleCount := 0
	if p.itemHeight > 0 {
		visibleCount = min(10, listRows/p.itemHeight)
	}
	windowStart := getListWindowStart(p.itemCount, p.cursor, visibleCount)

	position := fmt.Sprintf("0/%d", p.itemCount)
	if p.itemCount > 0 {
		position = fmt.Sprintf("%d/%d", p.cursor+1, p.itemCount)
	}
	status := position
	if strings.TrimSpace(p.query) != "" {
		status = fmt.Sprintf("%s · %d total", position, p.totalCount)
	}
	statusStyled := selectorHintStyle().Render(truncateToWidth(status, contentWidth, "…"))
	searchWidth := max(0, contentWidth-visibleWidth(status)-1)
	searchPrefix := ""
	if searchWidth >= 9 {
		searchPrefix = "Search: "
	}
	search := cursorWindow(p.query, len([]rune(p.query)), max(1, searchWidth-visibleWidth(searchPrefix)))

	var searchCell string
	if searchWidth > 0 {
		before := searchPrefix
		if search.leadingEllipsis {
			before += "…"
		}
		before += search.before
		current := search.current
		after := search.after
		if p.query == "" {
			if searchPrefix != "" {
				current = "t"
				after = truncateToWidth("ype to filter", searchWidth-9, "…")
			} else {
				current = " "
				after = ""
			}
		} else if search.trailingEllipsis {
			after += "…"
		}
		color := dimText
		if p.query != "" {
			color = normalText
		}
		style := lipgloss.NewStyle().Foreground(color)
		if p.searchActive {
			searchCell = style.Render(before) + cursorMarker + style.Render(current) + style.Render(after)
		} else {
			searchCell = style.Render(before + current + after)
		}
	} else {
		searchCell = selectorHintStyle().Render(truncateToWidth(p.query, searchWidth, "…"))
	}
	cellWidth := contentWidth - visibleWidth(statusStyled)
	if visibleWidth(searchCell) > cellWidth {
		searchCell = truncateToWidth(searchCell, cellWidth, "…")
	}
	searchCell += strings.Repeat(" ", max(0, cellWidth-visibleWidth(searchCell)))

	var content strings.Builder
	content.WriteString(searchCell)
	content.WriteString(statusStyled)
	content.WriteString("\n")
	switch {
	case p.itemCount == 0:
		content.WriteString(lipgloss.NewStyle().Foreground(mutedText).Render(truncateToWidth(p.emptyText, contentWidth, "…")))
		content.WriteString("\n")
	case visibleCount == 0:
		content.WriteString(lipgloss.NewStyle().Foreground(mutedText).Render(truncateToWidth(TerminalTooShort, contentWidth, "…")))
		content.WriteString("\n")
	default:
		content.WriteString(p.renderRows(windowStart, visibleCount, contentWidth))
	}

	// The reference SelectorList passes no focusRef, so its frame never
	// scrolls: a stateless Model renders it exactly like the focus-less case.
	return Model{}.renderSelectorFrame(selectorFrameParams{
		title:   p.title,
		hint:    p.hint,
		content: strings.TrimSuffix(content.String(), "\n"),
		width:   width,
		rows:    p.rows,
	})
}
