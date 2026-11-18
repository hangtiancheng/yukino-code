// MCP transport over a WebSocket connection. The Go MCP SDK ships no
// WebSocket client transport that accepts custom headers, which the VSCode
// extension's embedded MCP server (ws, subprotocol "mcp") may require for
// auth; hence the Transport interface is implemented here on top of
// gorilla/websocket.
package vscode

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// WebSocketTransport implements mcp.Transport over a WebSocket with the "mcp"
// subprotocol and optional auth headers.
type WebSocketTransport struct {
	URL     string
	Headers map[string]string

	// OnNotification may intercept incoming notifications before the SDK sees
	// them. Returning true consumes the message. Used for the extension's
	// custom at_mentioned notification, which the SDK has no handler for.
	OnNotification func(method string, params json.RawMessage) bool

	mu   sync.Mutex
	conn *wsConnection
}

func (t *WebSocketTransport) Connect(ctx context.Context) (mcp.Connection, error) {
	dialer := websocket.Dialer{
		Subprotocols: []string{MCPWsSubprotocol},
		// A server that accepts the TCP connection but never completes the
		// WebSocket handshake would otherwise leave Connect pending forever.
		HandshakeTimeout: StartTimeout,
	}
	header := http.Header{}
	for key, value := range t.Headers {
		header.Set(key, value)
	}
	conn, _, err := dialer.DialContext(ctx, t.URL, header)
	if err != nil {
		return nil, err
	}
	connection := newWsConnection(t, conn)
	t.mu.Lock()
	t.conn = connection
	t.mu.Unlock()
	return connection, nil
}

// Notify sends a raw JSON-RPC notification over the live connection, bypassing
// the SDK session (which exposes no generic notification API). Used for the
// custom ide_connected announcement.
func (t *WebSocketTransport) Notify(method string, params any) error {
	t.mu.Lock()
	connection := t.conn
	t.mu.Unlock()
	if connection == nil {
		return errors.New("WebSocket is not open. Cannot send message.")
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return connection.writeMessage(&jsonrpc.Request{Method: method, Params: raw})
}

type incomingMessage struct {
	message jsonrpc.Message
	err     error
}

type wsConnection struct {
	transport *WebSocketTransport
	conn      *websocket.Conn
	closed    chan struct{}
	incoming  chan incomingMessage

	writeMu   sync.Mutex
	closeOnce sync.Once
	closeErr  error
}

// newWsConnection starts the read pump. gorilla forbids reading again after a
// failed read, so a single goroutine owns ReadMessage and hands results to
// Read through a channel; Read can then honor context cancellation and Close
// without touching the socket.
func newWsConnection(transport *WebSocketTransport, conn *websocket.Conn) *wsConnection {
	c := &wsConnection{
		transport: transport,
		conn:      conn,
		closed:    make(chan struct{}),
		incoming:  make(chan incomingMessage),
	}
	go c.pump()
	return c
}

func (c *wsConnection) pump() {
	defer close(c.incoming)
	for {
		messageType, data, err := c.conn.ReadMessage()
		if err != nil {
			select {
			case c.incoming <- incomingMessage{err: err}:
			case <-c.closed:
			}
			return
		}
		if messageType != websocket.TextMessage && messageType != websocket.BinaryMessage {
			continue
		}
		message, err := jsonrpc.DecodeMessage(data)
		if err != nil {
			// Malformed frames are skipped, mirroring the reference
			// transport's onerror path (which reports without closing).
			continue
		}
		if request, ok := message.(*jsonrpc.Request); ok && !request.IsCall() && c.transport.OnNotification != nil {
			if c.transport.OnNotification(request.Method, request.Params) {
				continue
			}
		}
		select {
		case c.incoming <- incomingMessage{message: message}:
		case <-c.closed:
			return
		}
	}
}

func (c *wsConnection) Read(ctx context.Context) (jsonrpc.Message, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		return nil, io.EOF
	case item, ok := <-c.incoming:
		if !ok {
			return nil, io.EOF
		}
		if item.err != nil {
			return nil, item.err
		}
		return item.message, nil
	}
}

func (c *wsConnection) Write(ctx context.Context, message jsonrpc.Message) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return c.writeMessage(message)
}

func (c *wsConnection) writeMessage(message jsonrpc.Message) error {
	data, err := jsonrpc.EncodeMessage(message)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	select {
	case <-c.closed:
		return mcp.ErrConnectionClosed
	default:
	}
	return c.conn.WriteMessage(websocket.TextMessage, data)
}

func (c *wsConnection) Close() error {
	c.closeOnce.Do(func() {
		close(c.closed)
		c.writeMu.Lock()
		deadline := time.Now().Add(time.Second)
		_ = c.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), deadline)
		c.writeMu.Unlock()
		c.closeErr = c.conn.Close()
	})
	return c.closeErr
}

func (c *wsConnection) SessionID() string { return "" }
