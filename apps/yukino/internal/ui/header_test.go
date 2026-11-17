package ui

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/yukino-js/yukino/yukino/internal/utils"
	"github.com/yukino-js/yukino/yukino/internal/version"
)

func stripANSI(s string) string { return ansi.Strip(s) }

func TestTranscriptHeader(t *testing.T) {
	m := newChatModel(t)
	if m.selectedProvider == nil {
		t.Fatal("New must resolve the remembered provider before the first render")
	}
	m.width = 100
	lines := strings.Split(m.renderTranscriptHeader(), "\n")
	if len(lines) != 4 || lines[0] != "" {
		t.Fatalf("expected a blank line followed by 3 header lines, got %q", lines)
	}
	if got, want := stripANSI(lines[1]), " ✳ Yukino v"+version.Version; got != want {
		t.Fatalf("title = %q, want %q", got, want)
	}
	if got, want := stripANSI(lines[2]), " Esc interrupt · /commands · Ctrl+O details"; got != want {
		t.Fatalf("hint = %q, want %q", got, want)
	}
	wantModel := fmt.Sprintf(" test/m · %s", utils.CompactPath(m.getWorkDir()))
	if got := stripANSI(lines[3]); got != wantModel {
		t.Fatalf("model line = %q, want %q", got, wantModel)
	}

	// Narrow terminals fall back to the compact hint.
	m.width = 50
	lines = strings.Split(m.renderTranscriptHeader(), "\n")
	if got, want := stripANSI(lines[2]), " /help · Esc interrupt · Ctrl+O details"; got != want {
		t.Fatalf("narrow hint = %q, want %q", got, want)
	}
}
