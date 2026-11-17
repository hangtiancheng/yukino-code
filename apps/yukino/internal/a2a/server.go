package a2a

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/a2aproject/a2a-go/a2asrv"
	"github.com/a2aproject/a2a-go/a2asrv/taskstore"

	"github.com/yukino-js/yukino/yukino/internal/remote"
)

// ServerHandle is a running A2A HTTP server.
type ServerHandle struct {
	// URL is the base URL of the running server, e.g. http://127.0.0.1:18890/.
	URL string
	// CardURL is the URL of the agent card endpoint.
	CardURL string

	server   *http.Server
	executor *Executor

	mu     sync.Mutex
	closed bool
}

// ParseA2aAddress validates the listen address; only loopback hosts are
// allowed.
func ParseA2aAddress(address string) (string, int, error) {
	if address == "" {
		address = DefaultAddress
	}
	host, port, err := remote.ParseRemoteAddress(address, A2ADefaultPort, true)
	if err != nil {
		return "", 0, err
	}
	if !remote.LoopbackHosts[host] {
		return "", 0, errors.New(LoopbackRequiredError)
	}
	return host, port, nil
}

type StartServerOptions struct {
	Address        string
	RuntimeFactory RuntimeFactory
	Cwd            string
}

// StartServer starts the A2A HTTP server: the agent card at
// /.well-known/agent-card.json, JSON-RPC at POST /, and HTTP+JSON/REST under
// /v1/.... It binds first, then rewrites the card URLs with the actual port
// so port-0 (ephemeral) bindings advertise a reachable address.
func StartServer(options StartServerOptions) (*ServerHandle, error) {
	host, port, err := ParseA2aAddress(options.Address)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	bound, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return nil, errors.New(ServerNotBoundError)
	}
	url := "http://" + net.JoinHostPort(bound.IP.String(), strconv.Itoa(bound.Port)) + "/"

	card := BuildAgentCard(url)
	cwd := options.Cwd
	if cwd == "" {
		if cwd, err = os.Getwd(); err != nil {
			_ = listener.Close()
			return nil, err
		}
	}
	executor := NewExecutor(options.RuntimeFactory, cwd, DefaultIdleTimeout)
	requestHandler := &YukinoRequestHandler{
		Inner: a2asrv.NewHandler(executor, a2asrv.WithTaskStore(taskstore.NewInMemory(nil))),
	}

	mux := http.NewServeMux()
	mux.Handle(AgentCardPath, a2asrv.NewStaticAgentCardHandler(card))
	mux.Handle("/v1/", protocolMiddleware(http.StripPrefix("/v1", a2asrv.NewRESTHandler(requestHandler))))
	mux.Handle("/", protocolMiddleware(a2asrv.NewJSONRPCHandler(requestHandler)))

	server := &http.Server{Handler: mux}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// The listener failed after binding; nothing else can be done —
			// Close reports the state to the caller.
			_ = err
		}
	}()
	return &ServerHandle{
		URL:      url,
		CardURL:  url + AgentCardPath[1:],
		server:   server,
		executor: executor,
	}, nil
}

// Close stops the server and disposes the executor's runtimes.
func (h *ServerHandle) Close() error {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil
	}
	h.closed = true
	h.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.server.Shutdown(ctx); err != nil {
		_ = h.server.Close()
	}
	h.executor.Dispose()
	return nil
}

// protocolMiddleware enforces the A2A-Version header, the request body limit
// and the JSON-RPC method allowlist, mirroring the reference express
// middleware stack.
func protocolMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path != "/" && !strings.HasPrefix(path, "/v1/") {
			next.ServeHTTP(w, r)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, RequestBodyLimit+1))
		if err == nil && len(data) > RequestBodyLimit {
			sendProtocolError(w, path, data, 413, -32700, RequestTooLargeError, "CONTENT_TOO_LARGE")
			return
		}
		if err != nil || !json.Valid(data) {
			sendProtocolError(w, path, data, 400, -32700, MalformedJSONError, "INVALID_ARGUMENT")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(data))

		version := r.Header.Get("A2A-Version")
		if version != A2AProtocolVersion {
			status := 400
			if path == "/" {
				status = 200
			}
			message := MissingVersionError
			if version != "" {
				message = UnsupportedVersionError(version)
			}
			sendProtocolError(w, path, data, status, -32009, message, "VERSION_NOT_SUPPORTED")
			return
		}

		if path == "/" {
			var envelope struct {
				JSONRPC string `json:"jsonrpc"`
				Method  string `json:"method"`
			}
			if json.Unmarshal(data, &envelope) == nil && envelope.JSONRPC == "2.0" &&
				envelope.Method != "" && !a2aMethodSet[envelope.Method] {
				sendProtocolError(w, path, data, 200, -32601, UnknownMethodError(envelope.Method), "METHOD_NOT_FOUND")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func sendProtocolError(w http.ResponseWriter, path string, body []byte, httpStatus, code int, message, reason string) {
	details := []map[string]any{
		{
			"@type":  "type.googleapis.com/google.rpc.ErrorInfo",
			"reason": reason,
			"domain": "a2a-protocol.org",
		},
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(httpStatus)
	encoder := json.NewEncoder(w)
	if path == "/" {
		var id any
		var envelope struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(body, &envelope) == nil {
			id = envelope.ID
		}
		_ = encoder.Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"error":   map[string]any{"code": code, "message": message, "data": details},
		})
		return
	}
	status := "INVALID_ARGUMENT"
	if reason == "VERSION_NOT_SUPPORTED" {
		status = "FAILED_PRECONDITION"
	}
	_ = encoder.Encode(map[string]any{
		"error": map[string]any{"code": httpStatus, "message": message, "status": status, "details": details},
	})
}

// RunA2aServer starts the server and blocks until SIGINT/SIGTERM (CLI entry).
func RunA2aServer(address string) error {
	server, err := StartServer(StartServerOptions{Address: address})
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "A2A server listening at %s\n", server.URL)
	fmt.Fprintf(os.Stderr, "Agent card at %s\n", server.CardURL)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	<-signals
	return server.Close()
}
