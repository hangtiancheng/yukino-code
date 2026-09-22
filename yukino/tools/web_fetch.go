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
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"

	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// Resource controls: cap a single response, the request timeout, and how much
// markdown reaches the model, so one fetch cannot overwhelm the session.
const (
	webFetchMaxContentBytes  = 10 * 1024 * 1024
	webFetchTimeout          = 60 * time.Second
	webFetchMaxMarkdownChars = 100_000
)

// Fetched pages are cached per URL for 15 minutes (expired entries are dropped
// on access), bounded by a 50MB byte budget with oldest-first eviction.
const (
	webFetchCacheTTL      = 15 * time.Minute
	webFetchMaxCacheBytes = 50 * 1024 * 1024
)

type webFetchCacheEntry struct {
	markdown  string
	finalURL  string
	expiresAt time.Time
	size      int
	seq       int // insertion order, for oldest-first eviction
}

var (
	urlCacheMu    sync.Mutex
	urlCache      = make(map[string]*webFetchCacheEntry)
	urlCacheBytes int
	urlCacheSeq   int
)

func webFetchCacheGet(key string) *webFetchCacheEntry {
	urlCacheMu.Lock()
	defer urlCacheMu.Unlock()
	entry := urlCache[key]
	if entry == nil {
		return nil
	}
	if !time.Now().Before(entry.expiresAt) {
		delete(urlCache, key)
		urlCacheBytes -= entry.size
		return nil
	}
	return entry
}

func webFetchCacheSet(key, markdown, finalURL string) {
	urlCacheMu.Lock()
	defer urlCacheMu.Unlock()
	seq := urlCacheSeq + 1
	if existing := urlCache[key]; existing != nil {
		urlCacheBytes -= existing.size
		// TS Map.set on an EXISTING key keeps the original insertion position
		// (eviction order); only genuinely new keys move to the back.
		seq = existing.seq
	} else {
		urlCacheSeq++
	}
	size := max(1, len(markdown))
	urlCache[key] = &webFetchCacheEntry{
		markdown:  markdown,
		finalURL:  finalURL,
		expiresAt: time.Now().Add(webFetchCacheTTL),
		size:      size,
		seq:       seq,
	}
	urlCacheBytes += size
	// Drop oldest entries until under budget.
	for urlCacheBytes > webFetchMaxCacheBytes && len(urlCache) > 0 {
		var oldestKey string
		var oldest *webFetchCacheEntry
		for k, e := range urlCache {
			if oldest == nil || e.seq < oldest.seq {
				oldestKey, oldest = k, e
			}
		}
		if oldest == nil {
			break
		}
		delete(urlCache, oldestKey)
		urlCacheBytes -= oldest.size
	}
}

// jsParseURL classifies a raw URL string the way the WHATWG `new URL`
// constructor does, enough to reproduce the TS tool's two error classes:
// a parse failure (`Error: invalid URL`) versus a non-http(s) scheme
// (`Error: unsupported protocol`). It returns the normalized string (the
// WHATWG leading C0-control-or-space trim and tab/LF/CR removal), the
// lowercased scheme, and whether the constructor would succeed.
//
// Mirrored parser behavior: scheme state (leading ASCII alpha, then
// alpha/digit/+/-/.), special schemes (http/https/ws/wss/ftp) drop any run
// of leading slashes/backslashes before the authority (so "http:foo",
// "http:/foo" and "http:///foo" all parse with host foo), require a
// non-empty host, an all-digit port and bracket-balanced IPv6 literals, and
// reject forbidden host code points (space, controls, %, <, >, ^, |). The
// file scheme parses with anything after it ("file:x" is valid), and
// non-special schemes ("mailto:x@y", "foo:", "data:...") always parse, so
// they classify as unsupported protocols exactly like TS. IPv4/IPv6 address
// parsing (e.g. "http://999.1.1.1") and IDNA validation stay out of scope —
// such inputs pass classification here and surface as fetch failures, the
// documented residual.
func jsParseURL(raw string) (normalized, scheme string, ok bool) {
	s := strings.TrimFunc(raw, func(r rune) bool { return r <= 0x20 })
	s = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, s)

	colon := -1
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '+', c == '-', c == '.':
			if i == 0 && !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
				return s, "", false
			}
		case c == ':':
			colon = i
		default:
			return s, "", false
		}
		if colon >= 0 {
			break
		}
	}
	if colon < 0 {
		return s, "", false
	}
	scheme = strings.ToLower(s[:colon])
	rest := s[colon+1:]
	switch scheme {
	case "http", "https", "ws", "wss", "ftp":
		// Special schemes skip any leading slashes/backslashes before the
		// authority (special-authority-slashes + ignore-slashes states).
		authority := strings.TrimLeft(rest, "/\\")
		if i := strings.IndexAny(authority, "/?#\\"); i >= 0 {
			authority = authority[:i]
		}
		if i := strings.LastIndex(authority, "@"); i >= 0 {
			authority = authority[i+1:]
		}
		host := authority
		if i := strings.LastIndex(host, ":"); i >= 0 && !strings.Contains(host[i+1:], "]") {
			port := host[i+1:]
			if !isAllASCIIDigits(port) {
				return s, scheme, false
			}
			host = host[:i]
		}
		return s, scheme, jsHostValid(host)
	case "file":
		// file: parses with anything after it ("file:x" → file:///x).
		return s, scheme, true
	}
	return s, scheme, true
}

func isAllASCIIDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// jsHostValid applies the WHATWG empty-host and forbidden-host-code-point
// checks (minus the deep IPv4/IPv6/IDNA validation).
func jsHostValid(host string) bool {
	if host == "" {
		return false
	}
	if strings.ContainsRune(host, '[') {
		// IPv6 literals must be bracketed end to end; the address itself is
		// not validated (documented residual).
		return host[0] == '[' && host[len(host)-1] == ']'
	}
	if strings.ContainsRune(host, ']') {
		return false
	}
	for i := 0; i < len(host); i++ {
		c := host[i]
		if c <= 0x20 || c == '%' || c == '<' || c == '>' || c == '^' || c == '|' {
			return false
		}
	}
	return true
}

// webFetchMaxRedirects is the redirect cap of the fetch spec / undici
// (`maxRedirections = 20`); Go's default client stops after 10.
const webFetchMaxRedirects = 20

var errRedirectCountExceeded = errors.New("redirect count exceeded")

// webFetchHTTPClient is the default client; its redirect policy mirrors
// undici's. An injected HTTPClient keeps full control of its own policy.
var webFetchHTTPClient = &http.Client{
	CheckRedirect: func(_ *http.Request, via []*http.Request) error {
		// undici hits the origin 21 times (the initial request + 20 follows)
		// before rejecting — verified empirically — so the 21st redirect
		// response (len(via) == 21) is the one that must fail.
		if len(via) > webFetchMaxRedirects {
			return errRedirectCountExceeded
		}
		return nil
	},
}

// webFetchErrorString renders a fetch failure the way the TS tool does.
// Node's fetch (undici) wraps every transport failure — including the
// redirect cap — in TypeError("fetch failed") with the real cause attached,
// and asErrorString returns only err.message, so users always see
// "fetch failed"; abort/timeout surface their DOMException messages instead
// (verified against Node 24 / undici).
func webFetchErrorString(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "The operation was aborted due to timeout"
	case errors.Is(err, context.Canceled):
		return "This operation was aborted"
	}
	return "fetch failed"
}

// webFetchStatusText extracts the reason phrase from the wire status line.
// undici reports statusText verbatim from HTTP/1.x and always "" for HTTP/2
// (no reason phrase exists there), where Go's x/net/http2 transport
// synthesizes resp.Status from http.StatusText — so the canonical fallback
// must not be used.
func webFetchStatusText(resp *http.Response) string {
	if resp.ProtoMajor >= 2 {
		return ""
	}
	if _, reason, found := strings.Cut(resp.Status, " "); found {
		return reason
	}
	return ""
}

// isBinaryContentType splits text from binary: everything under text/ plus the
// structured text formats served as application/. Suffix and exact matches
// keep 'openxmlformats' (docx/xlsx) on the binary side.
func isBinaryContentType(contentType string) bool {
	if contentType == "" {
		return false
	}
	mt := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if strings.HasPrefix(mt, "text/") {
		return false
	}
	if strings.HasSuffix(mt, "+json") || mt == "application/json" {
		return false
	}
	if strings.HasSuffix(mt, "+xml") || mt == "application/xml" {
		return false
	}
	if strings.HasPrefix(mt, "application/javascript") {
		return false
	}
	if mt == "application/x-www-form-urlencoded" {
		return false
	}
	return true
}

func truncateWebFetchMarkdown(content string) string {
	// TS measures content.length (UTF-16 code units) and slices there; a rune
	// count cuts mixed CJK/emoji pages at a different point.
	if utils.UTF16Len(content) <= webFetchMaxMarkdownChars {
		return content
	}
	return utils.TruncateUTF16(content, webFetchMaxMarkdownChars) + "\n\n[Content truncated due to length...]"
}

func formatWebFetchResult(markdown, requestedURL, finalURL string) string {
	content := truncateWebFetchMarkdown(markdown)
	// Redirects are followed automatically, so surface the final URL when it
	// differs from the request — the content may reference it.
	if finalURL != "" && finalURL != requestedURL {
		return fmt.Sprintf("[Redirected to %s]\n\n%s", finalURL, content)
	}
	return content
}

// WebFetchTool fetches a URL over HTTP(S) and returns its content as Markdown.
type WebFetchTool struct {
	// HTTPClient overrides the default client (tests); nil uses a plain
	// http.Client, which follows redirects like the TS fetch() default.
	HTTPClient *http.Client
}

func (t *WebFetchTool) Name() string { return "WebFetch" }

func (t *WebFetchTool) Description() string { return WebFetchDescription }

func (t *WebFetchTool) Category() ToolCategory { return CategoryRead }

func (t *WebFetchTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url": map[string]any{
					"type":        "string",
					"description": "The http or https URL to fetch content from.",
				},
			},
			"required": []string{"url"},
		},
	}
}

func (t *WebFetchTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	rawURL, _ := args["url"].(string)
	if rawURL == "" {
		return ToolResult{Output: "Error: url is required", IsError: true}
	}

	// WHATWG `new URL` classification (web-fetch.ts:198-209): a parse failure
	// renders `invalid URL`; any parsed non-http(s) scheme — including mailto:,
	// file: and other schemes url.Parse would treat as opaque — renders the
	// unsupported-protocol error with the lowercased scheme plus colon.
	normalized, scheme, ok := jsParseURL(rawURL)
	if !ok {
		return ToolResult{Output: `Error: invalid URL "` + rawURL + `"`, IsError: true}
	}
	if scheme != "http" && scheme != "https" {
		return ToolResult{
			Output:  `Error: unsupported protocol "` + scheme + `:" — only http and https URLs can be fetched`,
			IsError: true,
		}
	}

	if cached := webFetchCacheGet(rawURL); cached != nil {
		return ToolResult{Output: formatWebFetchResult(cached.markdown, rawURL, cached.finalURL)}
	}

	// WHATWG percent-encodes spaces outside the host (which rejects them
	// outright); Go's url.Parse refuses them, so encode before the request.
	fetchURL := strings.ReplaceAll(normalized, " ", "%20")

	reqCtx, cancel := context.WithTimeout(ctx, webFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, fetchURL, nil)
	if err != nil {
		log.Error("web fetch failed", "err", err, "url", rawURL)
		return ToolResult{Output: "Error: fetch failed: " + webFetchErrorString(err), IsError: true}
	}
	req.Header.Set("Accept", "text/markdown, text/html, */*")
	// Node's fetch (undici) sends `User-Agent: node` by default; the TS tool
	// overrides nothing (its own UA header is commented out).
	req.Header.Set("User-Agent", "node")

	client := t.HTTPClient
	if client == nil {
		client = webFetchHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Error("web fetch failed", "err", err, "url", rawURL)
		return ToolResult{Output: "Error: fetch failed: " + webFetchErrorString(err), IsError: true}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return ToolResult{
			Output:  fmt.Sprintf("Error: HTTP %d %s for %s", resp.StatusCode, webFetchStatusText(resp), rawURL),
			IsError: true,
		}
	}

	if resp.ContentLength > webFetchMaxContentBytes {
		return ToolResult{
			Output:  fmt.Sprintf("Error: response is %d bytes, over the %d-byte limit", resp.ContentLength, webFetchMaxContentBytes),
			IsError: true,
		}
	}

	contentType := resp.Header.Get("Content-Type")
	if isBinaryContentType(contentType) {
		return ToolResult{
			Output:  fmt.Sprintf("Error: binary content (%s) is not supported; only text content can be fetched", contentType),
			IsError: true,
		}
	}

	// TS reads the whole body (response.arrayBuffer()) and only then compares
	// byteLength against the cap, so the over-limit message reports the true
	// size; a LimitReader would report the truncated count instead.
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Error("reading response body failed", "err", err, "url", rawURL)
		return ToolResult{Output: fmt.Sprintf("Error: reading response body failed: %s", err), IsError: true}
	}
	if len(body) > webFetchMaxContentBytes {
		return ToolResult{
			Output:  fmt.Sprintf("Error: response is %d bytes, over the %d-byte limit", len(body), webFetchMaxContentBytes),
			IsError: true,
		}
	}

	// TS: Buffer.from(body).toString("utf-8") — Node's WHATWG maximal-subpart
	// decoding, not a raw byte cast.
	markdown := decodeUTF8Lenient(body)
	if strings.Contains(contentType, "text/html") {
		markdown, err = htmlToMarkdown(markdown)
		if err != nil {
			log.Error("HTML to Markdown conversion failed", "err", err, "url", rawURL)
			return ToolResult{Output: fmt.Sprintf("Error: HTML to Markdown conversion failed: %s", err), IsError: true}
		}
	}

	finalURL := rawURL
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	webFetchCacheSet(rawURL, markdown, finalURL)
	return ToolResult{Output: formatWebFetchResult(markdown, rawURL, finalURL)}
}

// htmlToMarkdown converts an HTML document to Markdown: headings, links,
// lists, code blocks and paragraphs, with script/style/nav/footer stripped.
func htmlToMarkdown(raw string) (string, error) {
	doc, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		return "", err
	}
	return normalizeMarkdown(renderHTMLNode(doc, 0, false)), nil
}

func renderHTMLChildren(n *html.Node, listDepth int, inPre bool) string {
	var sb strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		sb.WriteString(renderHTMLNode(c, listDepth, inPre))
	}
	return sb.String()
}

func renderHTMLNode(n *html.Node, listDepth int, inPre bool) string {
	switch n.Type {
	case html.TextNode:
		if inPre {
			return n.Data
		}
		return collapseHTMLWhitespace(n.Data)
	case html.ElementNode:
		return renderHTMLElement(n, listDepth, inPre)
	case html.DocumentNode:
		// html.Parse returns a document root; descend into it.
		return renderHTMLChildren(n, listDepth, inPre)
	}
	return ""
}

func renderHTMLElement(n *html.Node, listDepth int, inPre bool) string {
	switch n.Data {
	case "script", "style", "nav", "footer", "noscript", "template", "svg", "iframe":
		return ""
	case "br":
		return "\n"
	case "hr":
		return "\n\n---\n\n"
	case "h1", "h2", "h3", "h4", "h5", "h6":
		text := strings.TrimSpace(renderHTMLChildren(n, listDepth, false))
		if text == "" {
			return ""
		}
		level, _ := strconv.Atoi(n.Data[1:])
		return "\n\n" + strings.Repeat("#", level) + " " + text + "\n\n"
	case "p":
		text := strings.TrimSpace(renderHTMLChildren(n, listDepth, false))
		if text == "" {
			return ""
		}
		return "\n\n" + text + "\n\n"
	case "strong", "b":
		text := renderHTMLChildren(n, listDepth, inPre)
		if strings.TrimSpace(text) == "" {
			return text
		}
		return "**" + text + "**"
	case "em", "i":
		text := renderHTMLChildren(n, listDepth, inPre)
		if strings.TrimSpace(text) == "" {
			return text
		}
		return "*" + text + "*"
	case "del", "s", "strike":
		text := renderHTMLChildren(n, listDepth, inPre)
		if strings.TrimSpace(text) == "" {
			return text
		}
		return "~~" + text + "~~"
	case "code":
		if inPre {
			return renderHTMLChildren(n, listDepth, true)
		}
		text := htmlTextContent(n)
		if text == "" {
			return ""
		}
		fence := "`"
		if strings.Contains(text, "`") {
			fence = "``"
		}
		return fence + text + fence
	case "pre":
		text := strings.Trim(htmlTextContent(n), "\n")
		if text == "" {
			return ""
		}
		return "\n\n```\n" + text + "\n```\n\n"
	case "a":
		text := strings.TrimSpace(renderHTMLChildren(n, listDepth, inPre))
		if text == "" {
			return ""
		}
		href := htmlAttr(n, "href")
		if href == "" {
			return text
		}
		return "[" + text + "](" + href + ")"
	case "img":
		src := htmlAttr(n, "src")
		if src == "" {
			return ""
		}
		return "![" + htmlAttr(n, "alt") + "](" + src + ")"
	case "ul":
		return renderHTMLList(n, false, listDepth)
	case "ol":
		return renderHTMLList(n, true, listDepth)
	case "li":
		// A bare li outside its list parent.
		text := strings.TrimSpace(renderHTMLChildren(n, listDepth, false))
		if text == "" {
			return ""
		}
		return "\n- " + text + "\n"
	case "blockquote":
		inner := strings.TrimSpace(renderHTMLChildren(n, listDepth, false))
		if inner == "" {
			return ""
		}
		var qb strings.Builder
		for _, line := range strings.Split(inner, "\n") {
			if line == "" {
				qb.WriteString(">\n")
			} else {
				qb.WriteString("> " + line + "\n")
			}
		}
		return "\n\n" + strings.TrimRight(qb.String(), "\n") + "\n\n"
	case "table":
		return renderHTMLTable(n)
	default:
		return renderHTMLChildren(n, listDepth, inPre)
	}
}

func renderHTMLList(n *html.Node, ordered bool, depth int) string {
	var sb strings.Builder
	sb.WriteString("\n\n")
	idx := 1
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.Data != "li" {
			continue
		}
		marker := "-"
		if ordered {
			marker = strconv.Itoa(idx) + "."
			idx++
		}
		// Split the item into inline content and nested lists so nested
		// bullets land on their own indented lines.
		var inline, nested strings.Builder
		for cc := c.FirstChild; cc != nil; cc = cc.NextSibling {
			if cc.Type == html.ElementNode && (cc.Data == "ul" || cc.Data == "ol") {
				nested.WriteString(renderHTMLList(cc, cc.Data == "ol", depth+1))
			} else {
				inline.WriteString(renderHTMLNode(cc, depth, false))
			}
		}
		sb.WriteString(strings.Repeat("  ", depth) + marker + " " + strings.TrimSpace(inline.String()) + "\n")
		if nested.Len() > 0 {
			sb.WriteString(strings.TrimRight(nested.String(), "\n") + "\n")
		}
	}
	return sb.String() + "\n"
}

func renderHTMLTable(n *html.Node) string {
	var rows [][]string
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode {
			switch node.Data {
			case "script", "style":
				return
			case "tr":
				var cells []string
				for c := node.FirstChild; c != nil; c = c.NextSibling {
					if c.Type == html.ElementNode && (c.Data == "td" || c.Data == "th") {
						cells = append(cells, strings.TrimSpace(renderHTMLChildren(c, 0, false)))
					}
				}
				rows = append(rows, cells)
				return
			}
		}
		for c := node.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)

	var sb strings.Builder
	sb.WriteString("\n\n")
	for _, cells := range rows {
		sb.WriteString(strings.Join(cells, " | ") + "\n")
	}
	return sb.String() + "\n"
}

func htmlAttr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// htmlTextContent concatenates descendant text verbatim (no whitespace
// collapsing) — used for pre/code where spacing is meaningful.
func htmlTextContent(n *html.Node) string {
	var sb strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		switch node.Type {
		case html.TextNode:
			sb.WriteString(node.Data)
		case html.ElementNode:
			if node.Data == "script" || node.Data == "style" {
				return
			}
		}
		for c := node.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return sb.String()
}

// collapseHTMLWhitespace mirrors HTML inline rendering: runs of whitespace
// become one space, but a leading/trailing space is preserved so adjacent
// inline elements do not run together.
func collapseHTMLWhitespace(s string) string {
	body := strings.Join(strings.Fields(s), " ")
	if body == "" {
		if s == "" {
			return ""
		}
		return " "
	}
	if s[0] == ' ' || s[0] == '\t' || s[0] == '\n' || s[0] == '\r' {
		body = " " + body
	}
	if last := s[len(s)-1]; last == ' ' || last == '\t' || last == '\n' || last == '\r' {
		body += " "
	}
	return body
}

// normalizeMarkdown tidies the rendered output: at most one blank line
// between blocks, no trailing spaces, collapsed inner space runs — while
// leaving fenced code blocks untouched.
func normalizeMarkdown(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	inFence := false
	blankRun := 0
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			out = append(out, strings.TrimRight(line, " \t"))
			blankRun = 0
			continue
		}
		if inFence {
			out = append(out, line)
			blankRun = 0
			continue
		}
		line = collapseInnerSpaces(line)
		if line == "" {
			blankRun++
			if blankRun <= 1 {
				out = append(out, "")
			}
			continue
		}
		blankRun = 0
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// collapseInnerSpaces keeps the leading indent (list nesting, blockquote
// markers) and collapses inner whitespace runs to single spaces.
func collapseInnerSpaces(line string) string {
	i := 0
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	return line[:i] + strings.Join(strings.Fields(line[i:]), " ")
}
