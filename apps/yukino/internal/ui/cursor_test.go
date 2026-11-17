package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestCursorFrameCoordinatesAndClipping(t *testing.T) {
	for _, tc := range []struct {
		name, view, marker string
		width, height      int
	}{
		{"wide grapheme", "title\n 中" + cursorMarker + "a\nfooter", "\x1b]777;yukino-cursor;1;3\a", 20, 10},
		{"scrolled out", cursorMarker + "top\nmiddle\nfooter", "\x1b]777;yukino-cursor;-1;0\a", 20, 2},
		{"clipped column", "1234" + cursorMarker + "5", "\x1b]777;yukino-cursor;-1;0\a", 4, 2},
		{"inactive", "dialog\nfooter", "\x1b]777;yukino-cursor;-1;0\a", 20, 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frame := cursorFrame(tc.view, tc.width, tc.height)
			if !strings.Contains(frame, tc.marker) || strings.Contains(frame, cursorMarker) {
				t.Fatalf("unexpected frame: %q", frame)
			}
			if ansi.Strip(frame) != strings.ReplaceAll(tc.view, cursorMarker, "") {
				t.Fatalf("cursor changed visible text: %q", frame)
			}
		})
	}
}

func TestTerminalCursorPreservesRendererPositionAndRestoresShape(t *testing.T) {
	var cursor terminalCursor
	frame := cursorFrame("title\n 中"+cursorMarker+"a\nfooter", 20, 10) + "\r"
	output := string(cursor.render([]byte(frame)))
	if strings.Contains(output, "yukino-") || !strings.HasSuffix(output, "\x1b7\x1b[1A\x1b[4G\x1b[6 q\x1b[?25h") {
		t.Fatalf("missing native steady bar: %q", output)
	}
	// A diff frame may skip the unchanged metadata row.
	output = string(cursor.render([]byte("\x1b[2Achanged\r\n\n\r")))
	if !strings.HasPrefix(output, "\x1b8\x1b[?25l") || !strings.HasSuffix(output, "\x1b7\x1b[1A\x1b[4G\x1b[6 q\x1b[?25h") {
		t.Fatalf("diff frame lost the renderer/caret positions: %q", output)
	}
	output = string(cursor.render([]byte(cursorFrame("dialog", 20, 10) + "\r")))
	if !strings.HasPrefix(output, "\x1b8\x1b[?25l") || !strings.HasSuffix(output, "\x1b[0 q") || cursor.parked {
		t.Fatalf("inactive dialog retained a caret: %q", output)
	}
	cursor.render([]byte(frame))
	output = string(cursor.render([]byte("\x1b[?25h")))
	if output != "\x1b8\x1b[?25l\x1b[?25h\x1b[0 q" || cursor.active || cursor.parked {
		t.Fatalf("shutdown did not restore terminal cursor: %q", output)
	}
}

func TestTextInputsUseNativeCaretMarkers(t *testing.T) {
	m := newChatModel(t)
	m.editor.SetValue("中abc")
	m.editor.col = 1
	field, _ := m.renderTextField(m.editor, 1, "> ")
	for name, text := range map[string]string{
		"composer":   m.renderComposer(8),
		"dialog":     renderDialogTextField("Model: ", "中abc", 1, 30),
		"text field": field,
	} {
		t.Run(name, func(t *testing.T) {
			if !strings.Contains(text, cursorMarker) || strings.Contains(text, "\x1b[7m") {
				t.Fatalf("input did not use native caret: %q", text)
			}
			frame := cursorFrame(text, 80, 24)
			if !cursorFramePattern.MatchString(ansi.Truncate(frame, 80, "")) {
				t.Fatalf("renderer truncation discarded cursor metadata: %q", frame)
			}
		})
	}
}
