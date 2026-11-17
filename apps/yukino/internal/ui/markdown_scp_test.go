package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// TestMarkdownScpStyleRemote mirrors the reference scp-style-remote tokenizer:
// scp-style git remotes stay verbatim plain text (no mailto autolink), while
// genuine email addresses still autolink.
func TestMarkdownScpStyleRemote(t *testing.T) {
	before := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(before)

	const linkColor = "\x1b[38;2;166;173;200m" // THEME.mdLinkUrl

	scp := renderMarkdownText("git clone git@github.com:owner/repo.git", 80, "assistant", false)
	if got := plainTerminalText(scp); got != "git clone git@github.com:owner/repo.git" {
		t.Errorf("scp text = %q", got)
	}
	if strings.Contains(scp, linkColor+"git@github.com") {
		t.Error("scp-style remote must not be autolinked as an email")
	}

	email := renderMarkdownText("email foo@example.com here", 80, "assistant", false)
	if !strings.Contains(email, linkColor+"foo@example.com") {
		t.Error("genuine email must still autolink")
	}

	// A colon followed by whitespace is an ordinary address, not an scp remote.
	colonSpace := renderMarkdownText("see foo@example.com: the docs", 80, "assistant", false)
	if !strings.Contains(colonSpace, linkColor+"foo@example.com") {
		t.Error("address with ': ' must still autolink")
	}
}
