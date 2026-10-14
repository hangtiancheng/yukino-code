package httpserver

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The legacy HTTP route and sessionId spelling match the TypeScript server.
// The SDK owns framing, JSON-RPC delivery and transport closure.
func newLegacySSE(server *mcp.Server) http.Handler {
	var mu sync.Mutex
	type entry struct {
		transport *mcp.SSEServerTransport
		ready     chan struct{}
		failed    bool
	}
	sessions := map[string]*entry{}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodPost && (req.URL.Path == "/messages" || req.URL.Path == "/sse") {
			id := req.URL.Query().Get("sessionId")
			if id == "" {
				id = req.URL.Query().Get("sessionid")
			}
			mu.Lock()
			current := sessions[id]
			mu.Unlock()
			if current != nil {
				select {
				case <-current.ready:
				case <-req.Context().Done():
					return
				}
			}
			if current == nil || current.failed {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"Unknown session"}`))
				return
			}
			current.transport.ServeHTTP(w, req)
			return
		}
		if req.Method != http.MethodGet || req.URL.Path != "/sse" {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			http.Error(w, "cannot create session", http.StatusInternalServerError)
			return
		}
		id := hex.EncodeToString(random[:])
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		transport := &mcp.SSEServerTransport{Endpoint: "/messages?sessionId=" + id, Response: w}
		current := &entry{transport: transport, ready: make(chan struct{})}
		mu.Lock()
		sessions[id] = current
		mu.Unlock()
		session, err := server.Connect(req.Context(), transport, nil)
		current.failed = err != nil
		close(current.ready)
		if err != nil {
			mu.Lock()
			delete(sessions, id)
			mu.Unlock()
			http.Error(w, "connection failed", http.StatusInternalServerError)
			return
		}
		defer func() {
			mu.Lock()
			delete(sessions, id)
			mu.Unlock()
			_ = session.Close()
		}()
		done := make(chan struct{})
		go func() { _ = session.Wait(); close(done) }()
		select {
		case <-req.Context().Done():
		case <-done:
		}
	})
}
