package createapp

import (
	"strings"
	"testing"
)

func TestShellFallsBackToToolInputHTML(t *testing.T) {
	html, err := ShellHTML()
	if err != nil {
		t.Fatal(err)
	}
	const fallback = `readString(params._meta, "html") || readString(params.structuredContent, "html") || inputHtml`
	if !strings.Contains(html, fallback) {
		t.Fatal("shell must keep tool-input HTML when the host omits result meta")
	}
}
