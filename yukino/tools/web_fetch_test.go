// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package tools

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

func TestHTMLToMarkdown(t *testing.T) {
	cases := []struct {
		name string
		html string
		want string
	}{
		{
			"headings and paragraphs",
			"<html><body><h1>Title</h1><p>Hello <strong>world</strong></p><h3>Sub</h3></body></html>",
			"# Title\n\nHello **world**\n\n### Sub",
		},
		{
			"links",
			`<p><a href="https://example.com">site</a> and <a>plain</a></p>`,
			"[site](https://example.com) and plain",
		},
		{
			"unordered list",
			"<ul><li>one</li><li>two</li></ul>",
			"- one\n- two",
		},
		{
			"ordered list",
			"<ol><li>one</li><li>two</li></ol>",
			"1. one\n2. two",
		},
		{
			"nested list indents",
			"<ul><li>a<ul><li>b</li></ul></li></ul>",
			"- a\n\n  - b",
		},
		{
			"strips script style nav footer",
			"<p>a</p><script>evil()</script><style>.x{}</style><nav>menu</nav><footer>foot</footer><noscript>n</noscript><p>b</p>",
			"a\n\nb",
		},
		{
			"pre code fence",
			"<pre><code>line1\nline2</code></pre>",
			"```\nline1\nline2\n```",
		},
		{
			"inline code",
			"<p>use <code>foo()</code> now</p>",
			"use `foo()` now",
		},
		{
			"inline code containing backtick",
			"<p>run <code>a`b</code></p>",
			"run ``a`b``",
		},
		{
			"blockquote",
			"<blockquote>quoted line</blockquote>",
			"> quoted line",
		},
		{
			"table",
			"<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
			"A | B\n1 | 2",
		},
		{
			"br hr and emphasis",
			"<p>a<br>b</p><hr><p><em>i</em> <del>d</del></p>",
			"a\nb\n\n---\n\n*i* ~~d~~",
		},
		{
			"image",
			`<p><img src="x.png" alt="pic"></p>`,
			"![pic](x.png)",
		},
		{
			"whitespace collapses inline",
			"<p>hello    world\n   again</p>",
			"hello world again",
		},
		{
			"empty heading dropped",
			"<h2>  </h2><p>x</p>",
			"x",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := htmlToMarkdown(tc.html)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("htmlToMarkdown() =\n%q\nwant\n%q", got, tc.want)
			}
		})
	}
}

func TestCollapseHTMLWhitespace(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"a  b\n c", "a b c"},
		{"  x ", " x "},
		{"\n", " "},
		{"\n\na", " a"},
	}
	for _, tc := range cases {
		if got := collapseHTMLWhitespace(tc.in); got != tc.want {
			t.Errorf("collapseHTMLWhitespace(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestNormalizeMarkdown(t *testing.T) {
	in := "a\n\n\n\nb\n```\nkeep  spaces  \n\n\n```\n\n\n\nc"
	want := "a\n\nb\n```\nkeep  spaces  \n\n\n```\n\nc"
	if got := normalizeMarkdown(in); got != want {
		t.Errorf("normalizeMarkdown() =\n%q\nwant\n%q", got, want)
	}
	if got := collapseInnerSpaces("  - a    b "); got != "  - a b" {
		t.Errorf("collapseInnerSpaces() = %q", got)
	}
	// Whitespace-only lines keep their indent (they are not treated as blank).
	if got := collapseInnerSpaces("  "); got != "  " {
		t.Errorf("collapseInnerSpaces(whitespace) = %q", got)
	}
}

func TestIsBinaryContentType(t *testing.T) {
	textual := []string{
		"",
		"text/html; charset=utf-8",
		"text/plain",
		"text/markdown",
		"application/json",
		"application/ld+json",
		"application/xml",
		"application/rss+xml",
		"application/javascript",
		"application/x-www-form-urlencoded",
	}
	for _, ct := range textual {
		if isBinaryContentType(ct) {
			t.Errorf("%q must be textual", ct)
		}
	}
	binary := []string{
		"image/png",
		"application/pdf",
		"application/octet-stream",
		"application/zip",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	}
	for _, ct := range binary {
		if !isBinaryContentType(ct) {
			t.Errorf("%q must be binary", ct)
		}
	}
}

func TestTruncateWebFetchMarkdown(t *testing.T) {
	short := strings.Repeat("a", 100)
	if got := truncateWebFetchMarkdown(short); got != short {
		t.Error("short content must pass through")
	}
	long := strings.Repeat("あ", webFetchMaxMarkdownChars+10)
	got := truncateWebFetchMarkdown(long)
	if !strings.HasSuffix(got, "[Content truncated due to length...]") {
		t.Error("missing truncation marker")
	}
	body := strings.TrimSuffix(got, "\n\n[Content truncated due to length...]")
	if utils.UTF16Len(body) != webFetchMaxMarkdownChars {
		t.Errorf("truncated body has %d UTF-16 units, want %d", utils.UTF16Len(body), webFetchMaxMarkdownChars)
	}
}

func TestFormatWebFetchResult(t *testing.T) {
	if got := formatWebFetchResult("body", "https://a", "https://a"); got != "body" {
		t.Errorf("same URL must not add a redirect note: %q", got)
	}
	got := formatWebFetchResult("body", "https://a", "https://b")
	if got != "[Redirected to https://b]\n\nbody" {
		t.Errorf("redirect note = %q", got)
	}
}

func TestWebFetchCacheRoundTripAndExpiry(t *testing.T) {
	key := "https://example.invalid/cache-test"
	webFetchCacheSet(key, "# hi", "https://example.invalid/final")
	entry := webFetchCacheGet(key)
	if entry == nil || entry.markdown != "# hi" || entry.finalURL != "https://example.invalid/final" {
		t.Fatalf("cache get = %+v", entry)
	}

	urlCacheMu.Lock()
	urlCache[key].expiresAt = time.Now().Add(-time.Minute)
	urlCacheMu.Unlock()

	if got := webFetchCacheGet(key); got != nil {
		t.Errorf("expired entry returned: %+v", got)
	}
	urlCacheMu.Lock()
	_, stillThere := urlCache[key]
	urlCacheMu.Unlock()
	if stillThere {
		t.Error("expired entry was not dropped from the cache map")
	}
}

// TestWebFetchExecuteValidation covers the argument guards, which return
// before any network activity.
func TestWebFetchExecuteValidation(t *testing.T) {
	tool := &WebFetchTool{}
	result := tool.Execute(context.Background(), map[string]any{})
	if !result.IsError || result.Output != "Error: url is required" {
		t.Errorf("missing url = %+v", result)
	}
	result = tool.Execute(context.Background(), map[string]any{"url": "ftp://example.com/file"})
	if !result.IsError || !strings.Contains(result.Output, "unsupported protocol") {
		t.Errorf("ftp url = %+v", result)
	}
	// JS `new URL` rejects relative references and hostless special URLs with
	// "invalid URL"; url.Parse accepts both, so the tool must reject them the
	// same way (web-fetch.ts:198-203).
	for _, raw := range []string{"not a url", "/relative/path", "//example.com/x", "http://"} {
		result = tool.Execute(context.Background(), map[string]any{"url": raw})
		if !result.IsError || result.Output != `Error: invalid URL "`+raw+`"` {
			t.Errorf("url %q = %+v, want the TS invalid-URL error", raw, result)
		}
	}
}

// TS reports response.statusText — the reason phrase from the wire — not the
// canonical text for the status code (web-fetch.ts:244).
func TestWebFetchUsesWireStatusText(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, acceptErr := ln.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 4096)
		if _, readErr := conn.Read(buf); readErr != nil {
			return
		}
		_, _ = conn.Write([]byte("HTTP/1.1 404 Totally Missing\r\nContent-Length: 0\r\n\r\n"))
	}()

	tool := &WebFetchTool{}
	result := tool.Execute(context.Background(), map[string]any{"url": "http://" + ln.Addr().String() + "/x"})
	if !result.IsError {
		t.Fatalf("expected an error result, got %+v", result)
	}
	want := "Error: HTTP 404 Totally Missing for http://" + ln.Addr().String() + "/x"
	if result.Output != want {
		t.Errorf("output = %q, want %q", result.Output, want)
	}
}

// undici leaves statusText empty for HTTP/2 (no reason phrase exists there),
// where Go's x/net/http2 transport synthesizes resp.Status from
// http.StatusText — the fallback must not leak into the rendered error.
func TestWebFetchStatusTextHTTP2IsEmpty(t *testing.T) {
	h2 := &http.Response{Proto: "HTTP/2.0", ProtoMajor: 2, StatusCode: 404, Status: "404 Not Found"}
	if got := webFetchStatusText(h2); got != "" {
		t.Errorf("HTTP/2 statusText = %q, want empty (undici parity)", got)
	}
	h1 := &http.Response{Proto: "HTTP/1.1", ProtoMajor: 1, StatusCode: 404, Status: "404 Custom Reason"}
	if got := webFetchStatusText(h1); got != "Custom Reason" {
		t.Errorf("HTTP/1.1 statusText = %q, want the wire reason", got)
	}
	empty := &http.Response{Proto: "HTTP/1.1", ProtoMajor: 1, StatusCode: 404, Status: "404"}
	if got := webFetchStatusText(empty); got != "" {
		t.Errorf("missing wire reason must render empty, got %q", got)
	}
}

// Ground truth captured from Node 24's `new URL` (WHATWG parser). The scheme
// is only asserted for inputs that parse; for rejections jsParseURL may still
// report the scheme it read before failing.
func TestJsParseURL(t *testing.T) {
	cases := []struct {
		raw       string
		wantOK    bool
		wantSchem string
	}{
		{"https://example.com/x", true, "https"},
		{"HTTP://a.com/x", true, "http"},
		{" https://a.com/x ", true, "https"}, // WHATWG trims C0-or-space
		{"ht\ttp://a.com/x", true, "http"},   // tabs are removed anywhere
		{"http:foo", true, "http"},           // missing slashes still parse
		{"http:/foo", true, "http"},          // host foo
		{"http:///foo", true, "http"},        // host foo
		{"http://user:pw@a.com:8080/p?q#r", true, "http"},
		{"http://a.com:", true, "http"}, // empty port is fine
		{"http://[::1]/x", true, "http"},
		{"mailto:a@b.c", true, "mailto"},
		{"file:///x", true, "file"},
		{"file:/x", true, "file"},
		{"file:x", true, "file"}, // parses to file:///x
		{"file:", true, "file"},
		{"foo:bar", true, "foo"},
		{"data:text/plain,hi", true, "data"},
		{"wss://h", true, "wss"},
		{"ftp://h/f", true, "ftp"},
		{"http://a.com/x y", true, "http"}, // space in path percent-encodes
		{"not a url", false, ""},
		{"/relative/path", false, ""},
		{"//example.com/x", false, ""}, // protocol-relative needs a base
		{"http://", false, "http"},
		{"ws://", false, "ws"},
		{"http://user@/x", false, "http"},      // empty host
		{"http://a.com:port/x", false, "http"}, // non-digit port
		{"http://a b.com/x", false, "http"},    // space in host
		{"http://[::1/x", false, "http"},       // unterminated IPv6 literal
		{"http://x%y/", false, "http"},         // forbidden host code point
		{"http://x^y/", false, "http"},         // forbidden host code point
		{"0http://a/", false, ""},              // scheme must start with alpha
		{"", false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			_, scheme, ok := jsParseURL(tc.raw)
			if ok != tc.wantOK {
				t.Fatalf("jsParseURL(%q) ok = %v, want %v", tc.raw, ok, tc.wantOK)
			}
			if ok && scheme != tc.wantSchem {
				t.Errorf("jsParseURL(%q) scheme = %q, want %q", tc.raw, scheme, tc.wantSchem)
			}
		})
	}
}

// Non-http(s) schemes that WHATWG `new URL` accepts must render the
// unsupported-protocol error (web-fetch.ts:204-209), not invalid URL.
func TestWebFetchUnsupportedProtocolSchemes(t *testing.T) {
	tool := &WebFetchTool{}
	cases := []struct{ raw, protocol string }{
		{"mailto:agent@example.com", "mailto:"},
		{"file:///etc/passwd", "file:"},
		{"file:x", "file:"},
		{"foo:bar", "foo:"},
		{"data:text/plain,hi", "data:"},
		{"FTP://example.com/f", "ftp:"},
	}
	for _, tc := range cases {
		result := tool.Execute(context.Background(), map[string]any{"url": tc.raw})
		want := `Error: unsupported protocol "` + tc.protocol + `" — only http and https URLs can be fetched`
		if !result.IsError || result.Output != want {
			t.Errorf("url %q = %+v, want %q", tc.raw, result, want)
		}
	}
}

// Node fetch sends `User-Agent: node` (undici default; the TS tool overrides
// nothing) — verified empirically against Node 24.
func TestWebFetchSendsNodeUserAgent(t *testing.T) {
	var gotUA, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		gotAccept = r.Header.Get("Accept")
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("hello"))
	}))
	defer srv.Close()

	tool := &WebFetchTool{}
	result := tool.Execute(context.Background(), map[string]any{"url": srv.URL + "/ua"})
	if result.IsError || result.Output != "hello" {
		t.Fatalf("fetch = %+v", result)
	}
	if gotUA != "node" {
		t.Errorf("User-Agent = %q, want %q", gotUA, "node")
	}
	if gotAccept != "text/markdown, text/html, */*" {
		t.Errorf("Accept = %q", gotAccept)
	}
}

// undici follows 20 redirects (21 requests total) and then rejects with
// TypeError("fetch failed"); asErrorString renders only err.message, so the
// tool output is the opaque double "fetch failed" (verified against Node 24).
func TestWebFetchRedirectCapMatchesUndici(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(w, r, "/loop", http.StatusFound)
	}))
	defer srv.Close()

	tool := &WebFetchTool{}
	result := tool.Execute(context.Background(), map[string]any{"url": srv.URL + "/loop"})
	if !result.IsError || result.Output != "Error: fetch failed: fetch failed" {
		t.Errorf("redirect cap result = %+v", result)
	}
	if got := hits.Load(); got != 21 {
		t.Errorf("server hit %d times, want 21 (initial + 20 follows, undici parity)", got)
	}
}

// A cache refresh must not change the eviction position: TS Map.set on an
// existing key keeps the original insertion order, so the refreshed entry is
// still the first eviction candidate.
func TestWebFetchCacheRefreshKeepsEvictionOrder(t *testing.T) {
	keyA := "https://example.invalid/refresh-a"
	keyB := "https://example.invalid/refresh-b"
	keyC := "https://example.invalid/refresh-c"
	// Start from an empty cache so earlier tests' entries (with older
	// insertion seqs) do not absorb the eviction.
	urlCacheMu.Lock()
	urlCache = make(map[string]*webFetchCacheEntry)
	urlCacheBytes = 0
	urlCacheMu.Unlock()

	// A (100B) → B (100B) → refresh A (keeps its insertion slot) → C sized so
	// that eviction must drop exactly ONE entry and land below the budget.
	webFetchCacheSet(keyA, strings.Repeat("a", 100), keyA)
	webFetchCacheSet(keyB, strings.Repeat("b", 100), keyB)
	webFetchCacheSet(keyA, strings.Repeat("a", 100), keyA)
	webFetchCacheSet(keyC, strings.Repeat("c", webFetchMaxCacheBytes-150), keyC)

	urlCacheMu.Lock()
	aExists := urlCache[keyA] != nil
	bThere := urlCache[keyB] != nil
	cThere := urlCache[keyC] != nil
	urlCacheMu.Unlock()

	if aExists {
		t.Error("refreshed entry A must keep its original eviction slot and be evicted first")
	}
	if !bThere || !cThere {
		t.Errorf("B and C must survive (b=%v c=%v); the refresh had moved A behind them", bThere, cThere)
	}
}
