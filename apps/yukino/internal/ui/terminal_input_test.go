package ui

import (
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func TestTerminalInputFiltersEveryChunkBoundary(t *testing.T) {
	for _, report := range []string{"\x1b[?997;2n", "\x1b]11;rgb:ffff/ffff/ffff\a", "\x1b]11;#000000\x1b\\"} {
		for split := 0; split <= len(report); split++ {
			var f terminalInputFilter
			a, reportsA, _ := f.feed("中文" + report[:split])
			b, reportsB, _ := f.feed(report[split:] + "👩‍💻\x1b[A")
			if a+b != "中文👩‍💻\x1b[A" || !reflect.DeepEqual(append(reportsA, reportsB...), []string{report}) {
				t.Fatalf("split %d of %q: output %q, reports %q/%q", split, report, a+b, reportsA, reportsB)
			}
		}
	}
}

func TestTerminalInputPreservesPastedReports(t *testing.T) {
	text := pasteStart + "中文\x1b[?997;2n\x1b]11;#ffffff\a" + pasteEnd + "x"
	for split := 0; split <= len(text); split++ {
		var f terminalInputFilter
		a, ra, _ := f.feed(text[:split])
		b, rb, _ := f.feed(text[split:])
		if a+b != text || len(ra)+len(rb) != 0 || f.pending != "" || f.pasting {
			t.Fatalf("split %d: output %q, pending %q", split, a+b, f.pending)
		}
	}
}

func TestTerminalInputPipeLifecycle(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	input, err := NewTerminalInput(r)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	result := make(chan string, 1)
	go func() {
		buf := make([]byte, 16)
		n, _ := input.Stdin.Read(buf)
		result <- string(buf[:n])
	}()
	io.WriteString(w, "\x1b")
	select {
	case got := <-result:
		if got != "\x1b" {
			t.Fatalf("literal escape = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("literal Escape was swallowed")
	}
	io.WriteString(w, "\x1b]11;rgb:ffff/ffff/ffff\a")
	select {
	case report := <-input.reports:
		if !strings.Contains(report, "ffff") {
			t.Fatal(report)
		}
	case <-time.After(time.Second):
		t.Fatal("missing terminal response")
	}
	input.Close()
	input.Close()
}

func TestTerminalThemeReportsAndEnvironment(t *testing.T) {
	for _, c := range []struct {
		report string
		want   rgbColor
	}{
		{"\x1b]11;rgb:ffff/ffff/ffff\a", rgbColor{255, 255, 255}},
		{"\x1b]11;#182030\x1b\\", rgbColor{24, 32, 48}},
		{"\x1b]11;rgba:f/8/0/ffff\a", rgbColor{255, 136, 0}},
	} {
		got, ok := parseOsc11BackgroundColor(c.report)
		if !ok || got != c.want {
			t.Errorf("%q = %#v, %v; want %#v", c.report, got, ok, c.want)
		}
	}
	for _, report := range []string{"", "\x1b]11;rgb:zz/ff/ff\a", "\x1b]11;#abc\a", "\x1b]11;rgb:ff/ff\a"} {
		if _, ok := parseOsc11BackgroundColor(report); ok {
			t.Errorf("accepted %q", report)
		}
	}
	if parseTerminalColorSchemeReport("\x1b[?997;2n") != ThemeModeLight || parseTerminalColorSchemeReport("\x1b[?997;1n") != ThemeModeDark || parseTerminalColorSchemeReport("\x1b[?997;3n") != "" {
		t.Fatal("color scheme reports")
	}
	for value, want := range map[string]ThemeMode{"15;0": ThemeModeDark, "0;15": ThemeModeLight, "0;255": ThemeModeLight, "0;232": ThemeModeDark, "0;15;invalid": ThemeModeLight, "invalid": ""} {
		if got := themeFromEnvironment(value); got != want {
			t.Errorf("COLORFGBG %q = %q, want %q", value, got, want)
		}
	}
}

func TestSetThemeUpdatesAllRuntimeStyles(t *testing.T) {
	profile := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(profile)
	defer SetThemeMode(ThemeModeDark)
	for _, mode := range []ThemeMode{ThemeModeLight, ThemeModeDark} {
		SetThemeMode(mode)
		palette := PaletteFor(mode)
		if GetThemeMode() != mode || Theme != palette || string(accentColor) != palette.Accent || string(normalText) != palette.Text || string(dimText) != palette.Dim || string(brightText) != palette.Bright {
			t.Fatalf("stale styles after %s", mode)
		}
		frame := Model{}.renderSelectorFrame(selectorFrameParams{title: "title", subtitle: "subtitle", hint: "Enter select", rows: 8, width: 80})
		var got, want [3]int
		if _, err := fmt.Sscanf(frame, "\x1b[38;2;%d;%d;%dm", &got[0], &got[1], &got[2]); err != nil {
			t.Fatal(err)
		}
		fmt.Sscanf(palette.Border, "#%02x%02x%02x", &want[0], &want[1], &want[2])
		for i := range got {
			if difference := got[i] - want[i]; difference < -1 || difference > 1 {
				t.Fatalf("selector retained the previous theme: %v, want %v", got, want)
			}
		}
		for status, want := range map[string]string{"idle": palette.BorderMuted, "working": palette.ThinkingHigh, "retry": palette.Warning, "compacting": palette.Accent, "error": palette.Error} {
			if string(activityStatusColor(status)) != want {
				t.Errorf("%s status %s", mode, status)
			}
		}
	}
}
