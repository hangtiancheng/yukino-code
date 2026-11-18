package remote

import (
	"bytes"
	"embed"
	"encoding/json"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed browser/dist
var browserBundle embed.FS

var browserMIMETypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "application/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".png":   "image/png",
	".svg":   "image/svg+xml",
	".ico":   "image/x-icon",
	".json":  "application/json; charset=utf-8",
	".woff2": "font/woff2",
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	clients := len(s.conns)
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "remote": true, "clients": clients})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	body, err := browserBundle.ReadFile("browser/dist/" + name)
	if err != nil {
		name = "index.html"
		body, err = browserBundle.ReadFile("browser/dist/" + name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
	}
	contentType := browserMIMETypes[path.Ext(name)]
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body))
}
