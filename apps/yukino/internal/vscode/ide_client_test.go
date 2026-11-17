package vscode

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type mockIde struct {
	server      *httptest.Server
	mu          sync.Mutex
	writeMu     sync.Mutex
	conn        *websocket.Conn
	received    []map[string]any
	authHeader  string
	subprotocol string
	connected   chan struct{}
}

func newMockIde(t *testing.T) *mockIde {
	t.Helper()
	upgrader := websocket.Upgrader{Subprotocols: []string{MCPWsSubprotocol}}
	mock := &mockIde{connected: make(chan struct{})}
	mock.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mock.mu.Lock()
		mock.authHeader = r.Header.Get(IdeAuthHeader)
		mock.mu.Unlock()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		mock.mu.Lock()
		mock.conn = conn
		mock.subprotocol = conn.Subprotocol()
		mock.mu.Unlock()
		close(mock.connected)
		go func() {
			defer conn.Close()
			for {
				_, data, err := conn.ReadMessage()
				if err != nil {
					return
				}
				var msg map[string]any
				if json.Unmarshal(data, &msg) != nil {
					continue
				}
				mock.mu.Lock()
				mock.received = append(mock.received, msg)
				mock.mu.Unlock()
				method, _ := msg["method"].(string)
				id, hasID := msg["id"]
				if method == "server/discover" && hasID {
					// The extension predates SEP-2575; a method-not-found error
					// makes the SDK fall back to the legacy initialize.
					out, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      id,
						"error":   map[string]any{"code": -32601, "message": "Method not found"},
					})
					mock.writeMu.Lock()
					_ = conn.WriteMessage(websocket.TextMessage, out)
					mock.writeMu.Unlock()
					continue
				}
				if method == "initialize" && hasID {
					params, _ := msg["params"].(map[string]any)
					protocolVersion, _ := params["protocolVersion"].(string)
					response := map[string]any{
						"jsonrpc": "2.0",
						"id":      id,
						"result": map[string]any{
							"protocolVersion": protocolVersion,
							"capabilities":    map[string]any{},
							"serverInfo":      map[string]any{"name": "mock-ide", "version": "1.0.0"},
						},
					}
					out, _ := json.Marshal(response)
					mock.writeMu.Lock()
					_ = conn.WriteMessage(websocket.TextMessage, out)
					mock.writeMu.Unlock()
				}
			}
		}()
	}))
	t.Cleanup(func() {
		mock.closeConn()
		mock.server.Close()
	})
	return mock
}

func (m *mockIde) closeConn() {
	m.mu.Lock()
	conn := m.conn
	m.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (m *mockIde) port(t *testing.T) int {
	t.Helper()
	parsed, err := url.Parse(m.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func (m *mockIde) send(t *testing.T, msg any) {
	t.Helper()
	m.mu.Lock()
	conn := m.conn
	m.mu.Unlock()
	if conn == nil {
		t.Fatal("no client connected")
	}
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatal(err)
	}
}

func (m *mockIde) methods() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, msg := range m.received {
		if method, ok := msg["method"].(string); ok {
			out = append(out, method)
		}
	}
	return out
}

func (m *mockIde) message(method string) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, msg := range m.received {
		if msg["method"] == method {
			return msg
		}
	}
	return nil
}

// setupIdeLock points CLAUDE_CONFIG_DIR at a temp dir with one ws lockfile for
// the mock server's port.
func setupIdeLock(t *testing.T, mock *mockIde, extra map[string]any) string {
	t.Helper()
	dir := setupLockDir(t)
	cwd := t.TempDir()
	entry := map[string]any{
		"transport":        "ws",
		"workspaceFolders": []string{cwd},
		"ideName":          "VS Code",
	}
	for key, value := range extra {
		entry[key] = value
	}
	writeLock(t, dir, strconv.Itoa(mock.port(t))+LockfileExtension, entry)
	return cwd
}

func TestConnectToIdeNoIde(t *testing.T) {
	t.Setenv(ClaudeConfigDirEnvVar, t.TempDir())
	os.Unsetenv(ClaudeCodeSSEPortEnvVar)
	os.Unsetenv(TermProgramEnvVar)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	connection, err := ConnectToIde(ctx, ConnectToIdeOptions{Cwd: t.TempDir()})
	if err != nil || connection != nil {
		t.Fatalf("expected (nil, nil), got (%+v, %v)", connection, err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("expected immediate return outside an IDE terminal, took %s", time.Since(start))
	}
}

func TestConnectToIdeFullFlow(t *testing.T) {
	mock := newMockIde(t)
	cwd := setupIdeLock(t, mock, map[string]any{"authToken": "secret"})

	mentions := make(chan IdeAtMention, 4)
	disconnects := make(chan struct{}, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	connection, err := ConnectToIde(ctx, ConnectToIdeOptions{
		Cwd:           cwd,
		OnAtMentioned: func(mention IdeAtMention) { mentions <- mention },
		OnDisconnect:  func() { disconnects <- struct{}{} },
	})
	if err != nil || connection == nil {
		t.Fatalf("expected connection, got (%+v, %v)", connection, err)
	}
	if connection.IdeName != "VS Code" {
		t.Fatalf("ideName = %q", connection.IdeName)
	}

	select {
	case <-mock.connected:
	case <-time.After(5 * time.Second):
		t.Fatal("mock server never saw a connection")
	}
	if mock.authHeader != "secret" {
		t.Errorf("auth header = %q, want secret", mock.authHeader)
	}
	if mock.subprotocol != MCPWsSubprotocol {
		t.Errorf("subprotocol = %q, want mcp", mock.subprotocol)
	}

	// The SDK handshake plus the custom ide_connected announcement must arrive.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && mock.message(IdeConnectedMethod) == nil {
		time.Sleep(20 * time.Millisecond)
	}
	announcement := mock.message(IdeConnectedMethod)
	if announcement == nil {
		t.Fatalf("ide_connected not received; methods = %v", mock.methods())
	}
	params, _ := announcement["params"].(map[string]any)
	if pid, _ := params["pid"].(float64); int(pid) != os.Getpid() {
		t.Errorf("pid = %v, want %d", params["pid"], os.Getpid())
	}

	// at_mentioned: 0-based lines on the wire become 1-based in the callback.
	mock.send(t, map[string]any{
		"jsonrpc": "2.0",
		"method":  "at_mentioned",
		"params":  map[string]any{"filePath": "/tmp/a.go", "lineStart": 4, "lineEnd": 9},
	})
	select {
	case mention := <-mentions:
		if mention.FilePath != "/tmp/a.go" || mention.LineStart == nil || *mention.LineStart != 5 || mention.LineEnd == nil || *mention.LineEnd != 10 {
			t.Fatalf("mention = %+v", mention)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("at_mentioned not delivered")
	}

	// Malformed mentions are dropped.
	mock.send(t, map[string]any{
		"jsonrpc": "2.0",
		"method":  "at_mentioned",
		"params":  map[string]any{"lineStart": 1},
	})
	mock.send(t, map[string]any{
		"jsonrpc": "2.0",
		"method":  "at_mentioned",
		"params":  map[string]any{"filePath": "/tmp/b.go"},
	})
	select {
	case mention := <-mentions:
		if mention.FilePath != "/tmp/b.go" || mention.LineStart != nil || mention.LineEnd != nil {
			t.Fatalf("mention = %+v", mention)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("valid mention after malformed one not delivered")
	}

	// Manual close must not fire the disconnect callback.
	if err := connection.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case <-disconnects:
		t.Fatal("manual close must not fire OnDisconnect")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestConnectToIdeRemoteDisconnect(t *testing.T) {
	mock := newMockIde(t)
	cwd := setupIdeLock(t, mock, nil)

	disconnects := make(chan struct{}, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := ConnectToIde(ctx, ConnectToIdeOptions{
		Cwd:           cwd,
		OnAtMentioned: func(IdeAtMention) {},
		OnDisconnect:  func() { disconnects <- struct{}{} },
	})
	if err != nil || connection == nil {
		t.Fatalf("expected connection, got (%+v, %v)", connection, err)
	}
	select {
	case <-mock.connected:
	case <-time.After(5 * time.Second):
		t.Fatal("mock server never saw a connection")
	}

	mock.closeConn()
	select {
	case <-disconnects:
	case <-time.After(5 * time.Second):
		t.Fatal("server-side close must fire OnDisconnect")
	}
}

func TestInIdeTerminal(t *testing.T) {
	os.Unsetenv(ClaudeCodeSSEPortEnvVar)
	os.Unsetenv(TermProgramEnvVar)
	if InIdeTerminal() {
		t.Fatal("expected false without env markers")
	}
	t.Setenv(TermProgramEnvVar, TermProgramVscode)
	if !InIdeTerminal() {
		t.Fatal("expected true for TERM_PROGRAM=vscode")
	}
	t.Setenv(TermProgramEnvVar, "iTerm.app")
	if InIdeTerminal() {
		t.Fatal("expected false for other terminals")
	}
	t.Setenv(ClaudeCodeSSEPortEnvVar, "")
	if !InIdeTerminal() {
		t.Fatal("expected true when CLAUDE_CODE_SSE_PORT is set (even empty)")
	}
}

func TestParseAtMentionRejectsNullLines(t *testing.T) {
	if _, ok := parseAtMention(json.RawMessage(`{"filePath":"a","lineStart":null}`)); ok {
		t.Fatal("null lineStart must be rejected like zod optional(number)")
	}
	if _, ok := parseAtMention(json.RawMessage(`{"filePath":3}`)); ok {
		t.Fatal("non-string filePath must be rejected")
	}
	if _, ok := parseAtMention(json.RawMessage(`not json`)); ok {
		t.Fatal("malformed params must be rejected")
	}
}

func TestTransportNotifyWithoutConnect(t *testing.T) {
	transport := &WebSocketTransport{URL: "ws://127.0.0.1:1"}
	if err := transport.Notify("x", nil); err == nil || !strings.Contains(err.Error(), "not open") {
		t.Fatalf("expected not-open error, got %v", err)
	}
}

func TestDetectIdeUsesLockfileForConnect(t *testing.T) {
	// Guard the lockfile → connect pipeline against a dead port: connection
	// fails and ConnectToIde returns (nil, nil) after logging.
	dir := setupLockDir(t)
	cwd := t.TempDir()
	writeLock(t, dir, "1"+LockfileExtension, map[string]any{
		"transport":        "ws",
		"workspaceFolders": []string{cwd},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	connection, err := ConnectToIde(ctx, ConnectToIdeOptions{Cwd: cwd})
	if err != nil || connection != nil {
		t.Fatalf("expected (nil, nil) for unreachable IDE, got (%+v, %v)", connection, err)
	}
	_ = filepath.Base(dir)
}
