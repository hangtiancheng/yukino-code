package ui

import (
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

func editTextField(editor *inputEditor, key tea.KeyMsg, multiline bool) string {
	if len(editor.lines) == 0 {
		*editor = newInputEditor()
	}
	name := key.String()
	if name != "up" && name != "down" {
		editor.preferredColumn = -1
	}
	switch name {
	case "esc":
		return "escape"
	case "tab":
		return "tab"
	case "shift+tab":
		return "backtab"
	}
	if key.Paste || key.Type == tea.KeyRunes && strings.ContainsAny(string(key.Runes), "\r\n") {
		value := strings.ReplaceAll(strings.ReplaceAll(string(key.Runes), "\r\n", "\n"), "\r", "\n")
		if !multiline {
			value = strings.ReplaceAll(value, "\n", " ")
		}
		editor.InsertString(value)
		return ""
	}
	if multiline && (name == "ctrl+j" || name == "shift+enter") {
		editor.InsertString("\n")
		return ""
	}
	// The reference submits on any return keypress that is not a newline
	// request, including alt/option+enter.
	if name == "enter" || name == "alt+enter" {
		return "submit"
	}
	line := []rune(editor.lines[editor.line])
	col := editor.col
	switch name {
	case "home", "ctrl+a":
		editor.col = 0
	case "end", "ctrl+e":
		editor.col = len(line)
	case "left", "ctrl+b":
		if col > 0 {
			editor.col = inputBoundary(string(line), col, "previous", nil)
		} else if editor.line > 0 {
			editor.line--
			editor.col = len([]rune(editor.lines[editor.line]))
		}
	case "right", "ctrl+f":
		if col < len(line) {
			editor.col = inputBoundary(string(line), col, "next", nil)
		} else if editor.line < len(editor.lines)-1 {
			editor.line++
			editor.col = 0
		}
	case "backspace", "delete":
		if name == "delete" && col < len(line) {
			next := inputBoundary(string(line), col, "next", nil)
			editor.lines[editor.line] = string(line[:col]) + string(line[next:])
		} else if name == "backspace" && col > 0 {
			previous := inputBoundary(string(line), col, "previous", nil)
			editor.lines[editor.line] = string(line[:previous]) + string(line[col:])
			editor.col = previous
		} else if name == "backspace" && editor.line > 0 {
			length := len([]rune(editor.lines[editor.line-1]))
			editor.lines[editor.line-1] += string(line)
			editor.lines = append(editor.lines[:editor.line], editor.lines[editor.line+1:]...)
			editor.line--
			editor.col = length
		} else if name == "delete" && editor.line < len(editor.lines)-1 {
			editor.lines[editor.line] += editor.lines[editor.line+1]
			editor.lines = append(editor.lines[:editor.line+1], editor.lines[editor.line+2:]...)
		}
	case "up", "down":
		direction := 1
		if name == "up" {
			direction = -1
		}
		if !editor.moveVertical(direction) {
			if direction < 0 {
				return "up-boundary"
			}
			return "down-boundary"
		}
	default:
		if text, ok := textForKey(key); ok {
			editor.InsertString(text)
		}
	}
	return ""
}
func (m Model) renderTextField(editor inputEditor, indent int, prompt string) (string, int) {
	width := max(1, m.width-3-indent-visibleWidth(prompt))
	rows := layoutInputRows(editor.lines, width, nil)
	cursor := locateInputCursor(rows, editor.line, editor.col)
	maxRows := max(1, min(m.height*3/10, m.dialogAvailableRows()-2))
	start := max(0, min(cursor.row-maxRows/2, len(rows)-maxRows))
	end := min(len(rows), start+maxRows)
	var lines []string
	if start > 0 && m.dialogAvailableRows() >= 3 {
		lines = append(lines, paint("↑ "+strconv.Itoa(start)+" more lines", Theme.Dim))
	}
	focus := len(lines) + cursor.row - start
	for i := start; i < end; i++ {
		head := ""
		if i == 0 {
			head = paint(prompt, Theme.Dim)
		}
		var body strings.Builder
		for j, cell := range rows[i].cells {
			value := cell.text
			if i == cursor.row && j == cursor.cell {
				body.WriteString(cursorMarker)
			}
			body.WriteString(value)
		}
		lines = append(lines, strings.Repeat(" ", indent)+head+body.String())
	}
	if end < len(rows) && m.dialogAvailableRows() >= 3 {
		lines = append(lines, paint("↓ "+strconv.Itoa(len(rows)-end)+" more lines", Theme.Dim))
	}
	return strings.Join(lines, "\n"), focus
}
