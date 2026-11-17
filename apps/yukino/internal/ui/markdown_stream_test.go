package ui

import (
	"strings"
	"testing"
)

// TestRenderStreamingMarkdownMatchesFullRender pins output equivalence between
// the cached streaming path and the full render across a growing document.
func TestRenderStreamingMarkdownMatchesFullRender(t *testing.T) {
	stages := []string{
		"# Title\n\nfirst paragraph",
		"# Title\n\nfirst paragraph\n\nsecond paragraph",
		"# Title\n\nfirst paragraph\n\nsecond paragraph\n\n```go\nfmt.Println(\"hi\")\n```",
		"# Title\n\nfirst paragraph\n\nsecond paragraph\n\n```go\nfmt.Println(\"hi\")\n```\n\nlast line",
	}
	var cache markdownCache
	for _, stage := range stages {
		streamed := renderStreamingMarkdown(stage, 80, &cache)
		full := renderMarkdownText(stage, 80, "assistant", true)
		if streamed != full {
			t.Fatalf("streaming render diverged:\nstreamed:\n%s\nfull:\n%s", streamed, full)
		}
	}
	if cache.prefix == "" || cache.rendered == "" {
		t.Fatalf("cache not populated: %+v", cache)
	}
}

// TestRenderStreamingMarkdownCacheReuse pins that an unchanged prefix reuses
// the cached rendering (the rendered string survives an identical re-render).
func TestRenderStreamingMarkdownCacheReuse(t *testing.T) {
	var cache markdownCache
	base := "# Title\n\nfirst paragraph\n\nsecond paragraph"
	renderStreamingMarkdown(base, 80, &cache)
	rendered := cache.rendered
	prefix := cache.prefix
	if prefix == "" {
		t.Fatal("expected a non-empty prefix for a multi-block document")
	}
	// Appending to the last block keeps the prefix (and its cache) intact.
	renderStreamingMarkdown(base+" more", 80, &cache)
	if cache.prefix != prefix || cache.rendered != rendered {
		t.Fatalf("prefix cache invalidated by a last-block append: %+v", cache)
	}
	// A width change invalidates the cache (the rebuilt entry records the new
	// width; the rendered bytes may coincide when nothing wraps).
	renderStreamingMarkdown(base+" more", 60, &cache)
	if cache.width != 60 {
		t.Fatalf("width change must rebuild the cache: %+v", cache)
	}
}

// TestRenderStreamingMarkdownReferenceDisablesCache pins the reference guard:
// link reference definitions can restyle earlier blocks, so no prefix cache.
func TestRenderStreamingMarkdownReferenceDisablesCache(t *testing.T) {
	var cache markdownCache
	doc := "[label]: http://example.com\n\nsee [label] and more"
	streamed := renderStreamingMarkdown(doc, 80, &cache)
	if cache.prefix != "" || cache.rendered != "" {
		t.Fatalf("reference definitions must disable the cache: %+v", cache)
	}
	full := renderMarkdownText(doc, 80, "assistant", true)
	if streamed != full {
		t.Fatalf("streaming render diverged:\n%s\nvs\n%s", streamed, full)
	}
}

// TestMarkdownLinkOSC8 pins the reference OSC-8 branch: on hyperlink-capable
// terminals a link renders as a clickable OSC-8 escape around the styled text
// instead of the "text (url)" fallback, and stays zero-width for measurement.
func TestMarkdownLinkOSC8(t *testing.T) {
	hyperlinkOnce.Do(func() {})
	previous := hyperlinkSupport
	t.Cleanup(func() { hyperlinkSupport = previous })

	hyperlinkSupport = false
	plain := renderMarkdownText("see [docs](http://example.com) here", 80, "assistant", false)
	if !strings.Contains(plain, "http://example.com") || strings.Contains(plain, "\x1b]8;;") {
		t.Fatalf("fallback must render the url plainly: %q", plain)
	}

	hyperlinkSupport = true
	clickable := renderMarkdownText("see [docs](http://example.com) here", 80, "assistant", false)
	if !strings.Contains(clickable, "\x1b]8;;http://example.com\x07") || !strings.Contains(clickable, "\x1b]8;;\x07") {
		t.Fatalf("expected an OSC-8 hyperlink: %q", clickable)
	}
	// The escapes themselves are zero-width: the measured width equals the
	// width of the visible text alone (the URL travels inside the escape).
	if got, want := visibleWidth(clickable), visibleWidth(plainTerminalText(clickable)); got != want {
		t.Fatalf("OSC-8 escapes must be zero-width: %d vs %d", got, want)
	}

	// oscSafeHref escapes spaces/tabs and drops control characters.
	if got := oscSafeHref("http://x/a b\tc\x00d"); got != "http://x/a%20b%20cd" {
		t.Fatalf("oscSafeHref = %q", got)
	}
}
