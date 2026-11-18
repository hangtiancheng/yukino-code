package tools

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/base"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/commonmark"
)

const (
	MaxFetchContentBytes = 10 * 1024 * 1024
	FetchTimeout         = 60 * time.Second
	MaxMarkdownLength    = 100000
	FetchCacheTTL        = 15 * time.Minute
	MaxFetchCacheBytes   = 50 * 1024 * 1024
	WebFetchDescription  = "Fetch a URL over HTTP(S) and return its content as Markdown. Use it to retrieve and analyze web pages.\n- url must be a fully-formed http or https URL; redirects are followed automatically and the final URL is reported when it differs.\n- HTML is converted to Markdown; other text formats (plain text, JSON, XML, Markdown) are returned as-is. Binary content (images, PDFs, archives) are rejected.\n- Responses over 10MB are rejected and results are truncated at 100K characters. Successful fetches are cached for 15 minutes."
)

type fetchCacheEntry struct {
	markdown, finalURL string
	expires            time.Time
	size               int
}

var fetchCache = struct {
	sync.Mutex
	entries map[string]fetchCacheEntry
	order   []string
	bytes   int
}{entries: map[string]fetchCacheEntry{}}

func removeFetchCacheKey(order []string, key string) []string {
	return slices.DeleteFunc(order, func(value string) bool { return value == key })
}

func cachedFetch(url string) (fetchCacheEntry, bool) {
	fetchCache.Lock()
	defer fetchCache.Unlock()
	entry, exists := fetchCache.entries[url]
	if exists && !entry.expires.After(time.Now()) {
		delete(fetchCache.entries, url)
		fetchCache.order = removeFetchCacheKey(fetchCache.order, url)
		fetchCache.bytes -= entry.size
		return fetchCacheEntry{}, false
	}
	return entry, exists
}
func cacheFetch(url, markdown, finalURL string) {
	fetchCache.Lock()
	defer fetchCache.Unlock()
	if old, exists := fetchCache.entries[url]; exists {
		fetchCache.bytes -= old.size
	}
	fetchCache.order = append(removeFetchCacheKey(fetchCache.order, url), url)
	size := max(1, len(markdown))
	fetchCache.entries[url] = fetchCacheEntry{markdown: markdown, finalURL: finalURL, expires: time.Now().Add(FetchCacheTTL), size: size}
	fetchCache.bytes += size
	for fetchCache.bytes > MaxFetchCacheBytes && len(fetchCache.order) > 0 {
		key := fetchCache.order[0]
		fetchCache.bytes -= fetchCache.entries[key].size
		delete(fetchCache.entries, key)
		fetchCache.order = fetchCache.order[1:]
	}
}
func isBinaryContentType(contentType string) bool {
	if contentType == "" {
		return false
	}
	mediaType, _, _ := strings.Cut(contentType, ";")
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))
	return !(strings.HasPrefix(mediaType, "text/") || strings.HasSuffix(mediaType, "+json") || mediaType == "application/json" || strings.HasSuffix(mediaType, "+xml") || mediaType == "application/xml" || strings.HasPrefix(mediaType, "application/javascript") || mediaType == "application/x-www-form-urlencoded")
}
func truncateUTF16(text string, limit int) string {
	units := 0
	for i, r := range text {
		count := 1
		if r > 0xffff {
			count = 2
		}
		if units+count > limit {
			return text[:i]
		}
		units += count
	}
	return text
}

func formatFetch(markdown, requested, final string) string {
	text := truncateUTF16(markdown, MaxMarkdownLength)
	if len(text) < len(markdown) {
		text += "\n\n[Content truncated due to length...]"
	}
	if final != "" && final != requested {
		text = "[Redirected to " + final + "]\n\n" + text
	}
	return text
}

type WebFetchTool struct{ Client *http.Client }

func (t *WebFetchTool) Name() string           { return "WebFetch" }
func (t *WebFetchTool) Description() string    { return WebFetchDescription }
func (t *WebFetchTool) Category() ToolCategory { return CategoryRead }
func (t *WebFetchTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{"type": "object", "properties": map[string]any{"url": map[string]any{"type": "string", "description": "The http or https URL to fetch content from."}}, "required": []string{"url"}}}
}
func (t *WebFetchTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	fail := func(format string, args ...any) ToolResult {
		return ToolResult{Output: fmt.Sprintf(format, args...), IsError: true}
	}
	if ctx.Err() != nil {
		return fail("Error: fetch interrupted")
	}
	requested, _ := args["url"].(string)
	if requested == "" {
		return fail("Error: url is required")
	}
	parsed, err := url.Parse(requested)
	if err != nil || parsed.Scheme == "" {
		return fail("Error: invalid URL %q", requested)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fail("Error: unsupported protocol %q — only http and https URLs can be fetched", parsed.Scheme+":")
	}
	if parsed.Host == "" {
		return fail("Error: invalid URL %q", requested)
	}
	if cached, exists := cachedFetch(requested); exists {
		return ToolResult{Output: formatFetch(cached.markdown, requested, cached.finalURL)}
	}
	if parsed.User != nil {
		return fail("Error: fetch failed: Request cannot be constructed from a URL that includes credentials")
	}
	ctx, cancel := context.WithTimeout(ctx, FetchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requested, nil)
	if err != nil {
		return fail("Error: fetch failed: %s", err)
	}
	request.Header.Set("Accept", "text/markdown, text/html, */*")
	client := t.Client
	if client == nil {
		client = &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 20 {
				return fmt.Errorf("redirect count exceeded")
			}
			return nil
		}}
	}
	response, err := client.Do(request)
	if err != nil {
		return fail("Error: fetch failed: %s", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fail("Error: HTTP %d %s for %s", response.StatusCode, http.StatusText(response.StatusCode), requested)
	}
	if response.ContentLength > MaxFetchContentBytes {
		return fail("Error: response is %d bytes, over the %d-byte limit", response.ContentLength, MaxFetchContentBytes)
	}
	contentType := response.Header.Get("Content-Type")
	if isBinaryContentType(contentType) {
		return fail("Error: binary content (%s) is not supported; only text content can be fetched", contentType)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxFetchContentBytes+1))
	if err != nil {
		return fail("Error: reading response body failed: %s", err)
	}
	if ctx.Err() != nil {
		return fail("Error: reading response body failed: %s", ctx.Err())
	}
	if len(data) > MaxFetchContentBytes {
		return fail("Error: response exceeds the %d-byte limit", MaxFetchContentBytes)
	}
	markdown := strings.ToValidUTF8(string(data), "�")
	if strings.Contains(contentType, "text/html") {
		conv := converter.NewConverter(converter.WithPlugins(base.NewBasePlugin(), commonmark.NewCommonmarkPlugin(commonmark.WithHeadingStyle(commonmark.HeadingStyleSetext), commonmark.WithEmDelimiter("_"), commonmark.WithBulletListMarker("*"), commonmark.WithListEndComment(false))))
		conv.Register.TagType("script", converter.TagTypeRemove, converter.PriorityEarly)
		conv.Register.TagType("style", converter.TagTypeRemove, converter.PriorityEarly)
		markdown, err = conv.ConvertString(markdown)
		if err != nil {
			return fail("Error: HTML to Markdown conversion failed: %s", err)
		}
	}
	if ctx.Err() != nil {
		return fail("Error: HTML to Markdown conversion failed: %s", ctx.Err())
	}
	final := requested
	if response.Request != nil && response.Request.URL != nil {
		final = response.Request.URL.String()
	}
	cacheFetch(requested, markdown, final)
	return ToolResult{Output: formatFetch(markdown, requested, final)}
}
