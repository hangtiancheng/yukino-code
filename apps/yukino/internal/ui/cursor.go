package ui

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const cursorMarker = "\x1b]777;yukino-caret\a"

var cursorFramePattern = regexp.MustCompile("\x1b\\]777;yukino-cursor;(-?[0-9]+);([0-9]+)\a")

func cursorFrame(view string, width, height int) string {
	lines := strings.Split(view, "\n")
	up, column := -1, 0
	for row, line := range lines {
		if index := strings.Index(line, cursorMarker); index >= 0 {
			col := visibleWidth(line[:index])
			if (width <= 0 || col < width) && (height <= 0 || len(lines)-row <= height) {
				up, column = len(lines)-row-1, col
			}
			lines[row] = strings.ReplaceAll(line, cursorMarker, "")
		}
	}
	last := len(lines) - 1
	lines[last] = fmt.Sprintf("\x1b]777;yukino-cursor;%d;%d\a", up, column) + lines[last]
	return strings.Join(lines, "\n")
}

type terminalCursor struct {
	up, column int
	active     bool
	parked     bool
	shaped     bool
}

func (c *terminalCursor) render(p []byte) []byte {
	if len(p) == 0 {
		return p
	}
	var out strings.Builder
	if c.parked {
		out.WriteString("\x1b8\x1b[?25l")
		c.parked = false
	}
	text := cursorFramePattern.ReplaceAllStringFunc(string(p), func(marker string) string {
		match := cursorFramePattern.FindStringSubmatch(marker)
		c.up, _ = strconv.Atoi(match[1])
		c.column, _ = strconv.Atoi(match[2])
		c.active = c.up >= 0
		return ""
	})
	out.WriteString(text)
	if strings.Contains(text, "\x1b[?25h") {
		c.active = false
	}
	if c.active && strings.HasSuffix(text, "\r") {
		// Bubble Tea ends each inline frame at column zero of its last row.
		out.WriteString("\x1b7")
		if c.up > 0 {
			fmt.Fprintf(&out, "\x1b[%dA", c.up)
		}
		fmt.Fprintf(&out, "\x1b[%dG\x1b[6 q\x1b[?25h", c.column+1)
		c.parked, c.shaped = true, true
	} else if c.shaped && !c.active {
		out.WriteString("\x1b[0 q")
		c.shaped = false
	}
	return []byte(out.String())
}
