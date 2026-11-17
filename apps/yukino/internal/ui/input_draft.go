package ui

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
)

type pasteStore struct {
	counter      int
	imageCounter int
	entries      map[string]string
}

var pasteMarker = regexp.MustCompile(`\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]|\[Image #\d+\]`)
var inputEscape = regexp.MustCompile("\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|[ -/]*[@-~])")

func collapsePaste(text string, store *pasteStore) (string, *pasteStore) {
	lineCount := strings.Count(text, "\n") + 1
	length := len(utf16.Encode([]rune(text)))
	if lineCount <= 10 && length <= 1000 {
		return text, store
	}
	next := clonePasteStore(store)
	next.counter++
	detail := strconv.Itoa(length) + " chars"
	if lineCount > 10 {
		detail = "+" + strconv.Itoa(lineCount) + " lines"
	}
	marker := "[paste #" + strconv.Itoa(next.counter) + " " + detail + "]"
	next.entries[marker] = text
	return marker, next
}

func clonePasteStore(store *pasteStore) *pasteStore {
	next := &pasteStore{entries: map[string]string{}}
	if store != nil {
		next.counter, next.imageCounter = store.counter, store.imageCounter
		for k, v := range store.entries {
			next.entries[k] = v
		}
	}
	return next
}

func collapseImage(reference string, store *pasteStore) (string, *pasteStore) {
	next := clonePasteStore(store)
	next.imageCounter++
	marker := "[Image #" + strconv.Itoa(next.imageCounter) + "]"
	next.entries[marker] = reference
	return marker, next
}

func expandPastes(text string, store *pasteStore) string {
	if store == nil {
		return text
	}
	var out strings.Builder
	last := 0
	for _, loc := range pasteMarker.FindAllStringIndex(text, -1) {
		out.WriteString(text[last:loc[0]])
		marker := text[loc[0]:loc[1]]
		content, exists := store.entries[marker]
		if !exists {
			content = marker
		} else if strings.HasPrefix(marker, "[Image #") {
			if loc[0] > 0 && !unicode.IsSpace([]rune(text[:loc[0]])[len([]rune(text[:loc[0]]))-1]) {
				content = " " + content
			}
			if loc[1] < len(text) && !unicode.IsSpace([]rune(text[loc[1]:])[0]) {
				content += " "
			}
		}
		out.WriteString(content)
		last = loc[1]
	}
	out.WriteString(text[last:])
	return out.String()
}

func inputBoundary(text string, index int, direction string, store *pasteStore) int {
	if store != nil {
		for _, loc := range pasteMarker.FindAllStringIndex(text, -1) {
			if _, ok := store.entries[text[loc[0]:loc[1]]]; !ok {
				continue
			}
			start, end := len([]rune(text[:loc[0]])), len([]rune(text[:loc[1]]))
			if direction == "next" && start <= index && index < end {
				return end
			}
			if start < index && (index < end || direction == "previous" && index == end) {
				return start
			}
		}
	}
	bounds := graphemeBounds(text)
	switch direction {
	case "next":
		return nextGraphemeBoundary(bounds, index)
	case "previous":
		return previousGraphemeBoundary(bounds, index)
	default:
		return clampToGraphemeBoundary(bounds, index)
	}
}

type inputCell struct {
	offset int
	text   string
	width  int
}
type inputRow struct {
	line  int
	cells []inputCell
	width int
}
type inputPosition struct{ row, cell, column int }

func layoutInputRows(lines []string, width int, pastes *pasteStore) []inputRow {
	columns := max(1, width)
	rows := []inputRow{}
	for lineIndex, line := range lines {
		column := 0
		rows = append(rows, inputRow{line: lineIndex})
		appendCell := func(offset int, raw string) {
			display := raw
			if raw == "\t" {
				display = strings.Repeat(" ", TabSize-column%TabSize)
			} else if visibleWidth(raw) == 0 {
				display = " "
			}
			if visibleWidth(display) > columns {
				display = truncateToWidth(display, columns, "…")
			}
			cellWidth := visibleWidth(display)
			column += cellWidth
			row := &rows[len(rows)-1]
			if row.width > 0 && row.width+cellWidth > columns {
				rows = append(rows, inputRow{line: lineIndex})
				row = &rows[len(rows)-1]
			}
			row.cells = append(row.cells, inputCell{offset, display, cellWidth})
			row.width += cellWidth
		}
		escapes := map[int]int{}
		for _, loc := range inputEscape.FindAllStringIndex(line, -1) {
			escapes[len([]rune(line[:loc[0]]))] = len([]rune(line[:loc[1]]))
		}
		runes := []rune(line)
		boundaries := graphemeBounds(line)
		nextBoundaries := map[int]int{}
		for i := 0; i < len(boundaries)-1; i++ {
			nextBoundaries[boundaries[i]] = boundaries[i+1]
		}
		for index := 0; index < len(runes); {
			if end, ok := escapes[index]; ok {
				index = end
				continue
			}
			next := nextBoundaries[index]
			if pastes != nil && runes[index] == '[' {
				next = inputBoundary(line, index, "next", pastes)
			}
			if next <= index {
				next = index + 1
			}
			appendCell(index, string(runes[index:next]))
			index = next
		}
		appendCell(len(runes), " ")
	}
	return rows
}

func locateInputCursor(rows []inputRow, line, col int) inputPosition {
	// The fallback position (cursor before the first editable cell, e.g. a line
	// opening with a skipped ANSI escape) must point at the first wrapped row of
	// the cursor's logical line, mirroring the reference's firstRow.
	firstRow := 0
	for i, row := range rows {
		if row.line == line {
			firstRow = i
			break
		}
	}
	position := inputPosition{row: firstRow}
	for i, row := range rows {
		if row.line != line {
			continue
		}
		column := 0
		for j, cell := range row.cells {
			if cell.offset > col {
				return position
			}
			position = inputPosition{i, j, column}
			column += cell.width
		}
	}
	return position
}

type inputSnapshot struct {
	lines     []string
	line, col int
	pastes    *pasteStore
}
type inputEditor struct {
	lines                           []string
	line, col                       int
	width, height                   int
	pastes                          *pasteStore
	preferredColumn, preferredWidth int
}

func newInputEditor() inputEditor {
	return inputEditor{lines: []string{""}, width: 78, height: 1, preferredColumn: -1}
}
func (e inputEditor) Value() string { return strings.Join(e.lines, "\n") }
func (e *inputEditor) SetValue(value string) {
	e.lines = strings.Split(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"), "\n")
	e.line = len(e.lines) - 1
	e.col = len([]rune(e.lines[e.line]))
	e.preferredColumn = -1
}
func (e *inputEditor) Reset() {
	width, height := e.width, e.height
	*e = newInputEditor()
	e.width = width
	e.height = height
}
func (e *inputEditor) SetWidth(width int)   { e.width = max(1, width) }
func (e *inputEditor) SetHeight(height int) { e.height = max(1, height) }
func (e inputEditor) Height() int           { return e.height }
func (e inputEditor) snapshot() inputSnapshot {
	return inputSnapshot{append([]string(nil), e.lines...), e.line, e.col, e.pastes}
}
func (e *inputEditor) restore(s inputSnapshot) {
	e.lines = append([]string(nil), s.lines...)
	e.line = s.line
	e.col = s.col
	e.pastes = s.pastes
	e.preferredColumn = -1
}
func (e *inputEditor) InsertString(text string) {
	if len(e.lines) == 0 {
		e.lines = []string{""}
	}
	line := []rune(e.lines[e.line])
	col := inputBoundary(e.lines[e.line], e.col, "clamp", e.pastes)
	insert := strings.Split(text, "\n")
	lastLen := len([]rune(insert[len(insert)-1]))
	insert[0] = string(line[:col]) + insert[0]
	insert[len(insert)-1] += string(line[col:])
	next := append([]string(nil), e.lines[:e.line]...)
	next = append(next, insert...)
	next = append(next, e.lines[e.line+1:]...)
	e.lines = next
	e.line += len(insert) - 1
	e.col = lastLen
	if len(insert) == 1 {
		e.col += col
	}
	e.preferredColumn = -1
}
func (e *inputEditor) paste(text string, image bool) {
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	if text == "" {
		return
	}
	if image {
		text, e.pastes = collapseImage(text, e.pastes)
		before := []rune(e.lines[e.line])[:e.col]
		if len(before) > 0 && !unicode.IsSpace(before[len(before)-1]) {
			text = " " + text
		}
		text += " "
	} else {
		text, e.pastes = collapsePaste(text, e.pastes)
	}
	e.InsertString(text)
}
func (e *inputEditor) moveVertical(direction int) bool {
	rows := layoutInputRows(e.lines, e.width, e.pastes)
	current := locateInputCursor(rows, e.line, e.col)
	index := current.row + direction
	if index < 0 || index >= len(rows) {
		return false
	}
	column := current.column
	if e.preferredColumn >= 0 && e.preferredWidth == e.width {
		column = e.preferredColumn
	}
	target := rows[index]
	offset, displayColumn := target.cells[0].offset, 0
	for _, cell := range target.cells {
		if displayColumn > column {
			break
		}
		offset = cell.offset
		displayColumn += cell.width
	}
	e.line, e.col = target.line, offset
	e.preferredColumn, e.preferredWidth = column, e.width
	return true
}
