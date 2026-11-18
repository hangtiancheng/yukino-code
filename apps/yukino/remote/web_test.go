package remote

import (
	"bytes"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestBrowserBundleServesEveryArtifact(t *testing.T) {
	t.Chdir(t.TempDir())
	server := &Server{}
	err := fs.WalkDir(browserBundle, "browser/dist", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		t.Run(name, func(t *testing.T) {
			expected, err := browserBundle.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			server.handleIndex(response, httptest.NewRequest(http.MethodGet, "/"+strings.TrimPrefix(name, "browser/dist/"), nil))
			if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), expected) {
				t.Fatalf("artifact response: status=%d, bytes=%d; expected %d bytes", response.Code, response.Body.Len(), len(expected))
			}
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestBrowserAssetContentTypes(t *testing.T) {
	server := &Server{}
	for _, test := range []struct {
		url         string
		contentType string
	}{
		{"/index.html", "text/html; charset=utf-8"},
		{"/static/index.js", "application/javascript; charset=utf-8"},
		{"/static/index.css", "text/css; charset=utf-8"},
	} {
		t.Run(test.url, func(t *testing.T) {
			response := httptest.NewRecorder()
			server.handleIndex(response, httptest.NewRequest(http.MethodGet, test.url, nil))
			if actual := response.Header().Get("Content-Type"); actual != test.contentType {
				t.Fatalf("Content-Type = %q, want %q", actual, test.contentType)
			}
		})
	}
}

func TestBrowserEntryAndSPAFallback(t *testing.T) {
	index, err := browserBundle.ReadFile("browser/dist/index.html")
	if err != nil {
		t.Fatal(err)
	}
	if len(index) == 0 || !bytes.Contains(index, []byte("/static/index.js")) || !bytes.Contains(index, []byte("/static/index.css")) {
		t.Fatal("browser entry must load the synchronized JavaScript and CSS bundles")
	}
	server := &Server{}
	for _, route := range []string{"/", "/index.html", "/sessions/example", "/static/missing.js", "/../../server.go"} {
		t.Run(route, func(t *testing.T) {
			response := httptest.NewRecorder()
			server.handleIndex(response, httptest.NewRequest(http.MethodGet, route, nil))
			if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), index) {
				t.Fatalf("route %q did not receive the SPA entry: status=%d", route, response.Code)
			}
			if actual := response.Header().Get("Content-Type"); actual != "text/html; charset=utf-8" {
				t.Fatalf("Content-Type = %q", actual)
			}
		})
	}
}

func TestBrowserAssetHEADAndRange(t *testing.T) {
	asset, err := browserBundle.ReadFile("browser/dist/static/index.js")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{}
	head := httptest.NewRecorder()
	server.handleIndex(head, httptest.NewRequest(http.MethodHead, "/static/index.js", nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != strconv.Itoa(len(asset)) {
		t.Fatalf("invalid HEAD response: status=%d, headers=%v, bytes=%d", head.Code, head.Header(), head.Body.Len())
	}
	request := httptest.NewRequest(http.MethodGet, "/static/index.js", nil)
	request.Header.Set("Range", "bytes=0-15")
	partial := httptest.NewRecorder()
	server.handleIndex(partial, request)
	if partial.Code != http.StatusPartialContent || !bytes.Equal(partial.Body.Bytes(), asset[:16]) {
		t.Fatalf("invalid range response: status=%d, bytes=%d", partial.Code, partial.Body.Len())
	}
}
