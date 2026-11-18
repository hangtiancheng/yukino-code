package tools

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestWebFetchConversionRedirectAndCache(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/page", http.StatusFound)
		case "/page":
			hits.Add(1)
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<h1>Hello</h1><p>Some <strong>bold</strong> and <em>emphasis</em>.</p><p><a href="/link">link</a></p><script>secret script</script><style>secret style</style>`)
		default:
			w.Header().Set("Content-Type", "application/problem+json")
			fmt.Fprint(w, `{"detail":"text"}`)
		}
	}))
	defer server.Close()
	tool := &WebFetchTool{}
	for range 2 {
		result := tool.Execute(context.Background(), map[string]any{"url": server.URL + "/redirect"})
		if result.IsError || !strings.HasPrefix(result.Output, "[Redirected to "+server.URL+"/page]\n\nHello\n=====") || !strings.Contains(result.Output, "**bold**") || !strings.Contains(result.Output, "_emphasis_") || !strings.Contains(result.Output, "[link](/link)") || strings.Contains(result.Output, "secret") {
			t.Fatal(result)
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("cache not used: %d", hits.Load())
	}
	result := tool.Execute(context.Background(), map[string]any{"url": server.URL + "/json"})
	if result.IsError || result.Output != `{"detail":"text"}` {
		t.Fatal(result)
	}
	fetchCache.Lock()
	entry := fetchCache.entries[server.URL+"/redirect"]
	entry.expires = time.Now().Add(-time.Second)
	fetchCache.entries[server.URL+"/redirect"] = entry
	fetchCache.Unlock()
	result = tool.Execute(context.Background(), map[string]any{"url": server.URL + "/redirect"})
	if result.IsError || hits.Load() != 2 {
		t.Fatal(result, hits.Load())
	}
}
func TestWebFetchLimitsCancellationAndContentTypes(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/error":
			http.Error(w, "missing", 404)
		case "/binary":
			w.Header().Set("Content-Type", "application/pdf")
			fmt.Fprint(w, "binary")
		case "/declared":
			w.Header().Set("Content-Length", fmt.Sprint(MaxFetchContentBytes+1))
			w.WriteHeader(200)
		case "/stream":
			w.Header().Set("Content-Type", "text/plain")
			w.(http.Flusher).Flush()
			fmt.Fprint(w, strings.Repeat("a", MaxFetchContentBytes+1))
		case "/long":
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprint(w, strings.Repeat("a", MaxMarkdownLength-1)+"🙂end")
		case "/hang":
			close(started)
			<-r.Context().Done()
		}
	}))
	defer server.Close()
	tool := &WebFetchTool{}
	for _, tc := range []struct{ path, want string }{{"/error", "HTTP 404"}, {"/binary", "binary content"}, {"/declared", "over the"}, {"/stream", "response exceeds"}} {
		result := tool.Execute(context.Background(), map[string]any{"url": server.URL + tc.path})
		if !result.IsError || !strings.Contains(result.Output, tc.want) {
			t.Fatal(result)
		}
	}
	result := tool.Execute(context.Background(), map[string]any{"url": server.URL + "/long"})
	if result.IsError || strings.Contains(result.Output, "🙂") || !utf8.ValidString(result.Output) || !strings.HasSuffix(result.Output, "[Content truncated due to length...]") {
		t.Fatal(result.IsError, result.Output[len(result.Output)-100:])
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan ToolResult, 1)
	go func() { done <- tool.Execute(ctx, map[string]any{"url": server.URL + "/hang"}) }()
	<-started
	cancel()
	if result := <-done; !result.IsError {
		t.Fatal(result)
	}
	if result := tool.Execute(ctx, map[string]any{"url": server.URL + "/long"}); result.Output != "Error: fetch interrupted" {
		t.Fatal(result)
	}
	for _, args := range []map[string]any{{}, {"url": "not a URL"}, {"url": "file:///tmp/example"}, {"url": "http://"}} {
		if result := tool.Execute(context.Background(), args); !result.IsError {
			t.Fatal(result)
		}
	}
	for _, contentType := range []string{"", "text/plain", "application/json", "application/ld+json", "application/xml", "application/rss+xml", "application/javascript", "application/x-www-form-urlencoded"} {
		if isBinaryContentType(contentType) {
			t.Fatal(contentType)
		}
	}
	if !isBinaryContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
		t.Fatal("binary document accepted")
	}
}
