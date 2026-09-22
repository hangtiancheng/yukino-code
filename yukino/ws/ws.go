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

// Package ws runs the browser-facing transport of the Yukino agent bridge:
// one private agent per chat user (internal/bridge), streamed to the browser
// over a dedicated websocket using JSON-RPC 2.0 — one text frame per message.
//
// Prompts do not arrive here directly: they travel the normal chat pipeline
// (Manager.Dispatch), so they are persisted, echoed and reflected in session
// lists like any other message, and only then get dispatched to the owning
// agent. This socket carries the parts of a run that have no place in a chat
// transcript — token deltas, thinking, tool calls, permission prompts, as
// server-to-client notifications — plus the control requests those prompts
// need answered (permission/respond, question/respond, session/cancel, ping).
package ws

import (
	"encoding/json"
	"errors"
	"log"

	"github.com/hangtiancheng/yukino.go/yukino_http"

	"github.com/hangtiancheng/yukino-code/yukino/bridge"
	"github.com/hangtiancheng/yukino-code/yukino/jsonrpc"
)

// Manager wraps the transport-agnostic bridge manager with the websocket
// control socket. Session ownership, the shared MCP pool, idle eviction and
// chat dispatch all live in the embedded manager.
type Manager struct {
	*bridge.Manager
}

func NewManager(sink bridge.ChatSink) *Manager {
	return &Manager{Manager: bridge.NewManager(sink)}
}

// wsConn adapts a yukino_http websocket to bridge.Conn: every encoded
// JSON-RPC message becomes exactly one text frame.
type wsConn struct{ c *yukino_http.WSConn }

func (w wsConn) WriteMessage(data []byte) error {
	return w.c.WriteMessage(yukino_http.TextMessage, data)
}

// Serve runs the control socket for one chat client: it reports progress for
// the user's agent as JSON-RPC notifications and answers the control requests
// permission and question prompts block on. Prompts do not arrive here — in the
// chat deployment they travel the pipeline (Manager.Dispatch), so the socket is
// control-only.
func (m *Manager) Serve(userID string, c *yukino_http.WSConn) {
	defer c.Close()

	sess, err := m.Session(userID)
	if err != nil {
		writeNotification(c, bridge.MethodAgentError, map[string]string{"message": err.Error()})
		return
	}
	serveConn(userID, sess, c, false)
}

// ServeSession runs the control socket for one standalone session — the
// terminal deployment, where a client drives the agent directly over the socket
// and there is no chat pipeline. It is the websocket counterpart of the stdio
// transport: prompts arrive as session/prompt requests and finalized text is
// streamed back as notifications rather than filed into a transcript.
func ServeSession(sess *bridge.Session, c *yukino_http.WSConn) {
	defer c.Close()
	serveConn("terminal", sess, c, true)
}

// serveConn attaches one websocket client to sess and answers its JSON-RPC
// requests until the socket closes. allowPrompt gates session/prompt: the chat
// deployment leaves it off (prompts travel the chat pipeline), the standalone
// terminal deployment turns it on.
func serveConn(userID string, sess *bridge.Session, c *yukino_http.WSConn, allowPrompt bool) {
	conn := wsConn{c}
	sess.Attach(conn)
	defer sess.Detach(conn)

	for {
		_, raw, err := c.ReadMessage()
		if err != nil {
			if !errors.Is(err, yukino_http.ErrWSClosed) {
				log.Printf("ws %s: read error: %v", userID, err)
			}
			return
		}
		req, rpcErr := jsonrpc.Parse(raw)
		if rpcErr != nil {
			writeResponse(c, jsonrpc.Response{ID: parsedID(req), Err: rpcErr})
			continue
		}
		if req.IsNotification() {
			// The protocol defines no client-to-server notifications; an
			// unanswerable message is ignored rather than rejected.
			continue
		}
		var result any
		if allowPrompt && req.Method == bridge.MethodSessionPrompt {
			result, rpcErr = sess.SubmitPromptRequest(req)
		} else {
			result, rpcErr = sess.HandleControl(req)
		}
		writeResponse(c, jsonrpc.Response{ID: req.ID, Result: result, Err: rpcErr})
	}
}

// parsedID extracts the id to echo in an error response; a message that never
// decoded has none, and the spec requires a null id in that case.
func parsedID(req *jsonrpc.Request) jsonrpc.ID {
	if req == nil {
		return nil
	}
	return req.ID
}

func writeResponse(c *yukino_http.WSConn, resp jsonrpc.Response) {
	data, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_ = c.WriteMessage(yukino_http.TextMessage, data)
}

func writeNotification(c *yukino_http.WSConn, method string, params any) {
	data, err := json.Marshal(jsonrpc.NewNotification(method, params))
	if err != nil {
		return
	}
	_ = c.WriteMessage(yukino_http.TextMessage, data)
}
