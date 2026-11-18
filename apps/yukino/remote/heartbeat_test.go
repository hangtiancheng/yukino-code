package remote

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// dialAndRegister upgrades a client connection and registers the server-side
// socket in the Server's conn set, mirroring handleWS's bookkeeping, then
// returns the server-side conn.
func dialAndRegister(t *testing.T, s *Server, url string) *websocket.Conn {
	t.Helper()
	serverConn := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns[conn] = struct{}{}
		s.mu.Unlock()
		serverConn <- conn
		// Hold the connection open until the test ends.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })

	select {
	case conn := <-serverConn:
		return conn
	case <-time.After(2 * time.Second):
		t.Fatal("server did not register the connection")
		return nil
	}
}

func TestSweepHeartbeatTerminatesStaleConnections(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)

	stale := dialAndRegister(t, s, "")
	fresh := dialAndRegister(t, s, "")

	now := time.Now().UnixMilli()
	s.mu.Lock()
	s.lastPongAt[stale] = now - HeartbeatStaleMS - 1
	s.lastPongAt[fresh] = now
	s.mu.Unlock()

	s.sweepHeartbeat()

	s.mu.Lock()
	_, stalePresent := s.conns[stale]
	_, freshPresent := s.conns[fresh]
	_, stalePong := s.lastPongAt[stale]
	s.mu.Unlock()

	if stalePresent {
		t.Fatal("stale connection was not removed from the conn set")
	}
	if stalePong {
		t.Fatal("stale connection's pong entry was not removed")
	}
	if !freshPresent {
		t.Fatal("fresh connection was incorrectly removed")
	}
}

func TestSweepHeartbeatTreatsUnknownPongAsFresh(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	conn := dialAndRegister(t, s, "")

	// No lastPongAt entry: the sweep must treat the connection as fresh
	// (mirrors the reference `?? now`) and keep it.
	s.sweepHeartbeat()

	s.mu.Lock()
	_, present := s.conns[conn]
	s.mu.Unlock()
	if !present {
		t.Fatal("connection without a pong entry was incorrectly terminated")
	}
}

func TestStartStopHeartbeatIsIdempotent(t *testing.T) {
	s := NewServer(nil, nil, nil, "", false, 0, nil, true)
	s.startHeartbeat()
	s.startHeartbeat() // second call must not spawn a duplicate loop
	s.mu.Lock()
	ticker := s.heartbeatTicker
	done := s.heartbeatDone
	s.mu.Unlock()
	if ticker == nil || done == nil {
		t.Fatal("heartbeat was not started")
	}
	s.stopHeartbeat()
	s.stopHeartbeat() // second stop must not panic on a closed channel
	s.mu.Lock()
	if s.heartbeatTicker != nil || s.heartbeatDone != nil {
		t.Fatal("heartbeat was not stopped")
	}
	s.mu.Unlock()
}

// dialClient upgrades a connection, registers it server-side, and returns the
// client socket so tests can read broadcast messages.
func dialClient(t *testing.T, s *Server) *websocket.Conn {
	t.Helper()
	registered := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns[conn] = struct{}{}
		s.mu.Unlock()
		registered <- struct{}{}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	select {
	case <-registered:
	case <-time.After(2 * time.Second):
		t.Fatal("server did not register the connection")
	}
	return client
}

// dialPair upgrades a connection, registers it server-side, and returns both
// the server-side socket (for unicast sends) and the client socket (for reads).
func dialPair(t *testing.T, s *Server) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	serverConn := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns[conn] = struct{}{}
		s.mu.Unlock()
		serverConn <- conn
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	select {
	case sc := <-serverConn:
		return sc, client
	case <-time.After(2 * time.Second):
		t.Fatal("server did not register the connection")
		return nil, nil
	}
}
