// Package httpserver mounts the MCP Streamable HTTP and legacy SSE handlers on
// yukino_http.
//
// The SDK handlers write the ResponseWriter themselves. Context.TakeOver disables
// deferred rendering, so respond does not emit a second WriteHeader after the
// handler has already committed a status.
package httpserver

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	httpapp "github.com/hangtiancheng/yukino.go/libs/yukino_http"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/logger"
)

// Handler serves stateless JSON Streamable HTTP at /mcp and legacy SSE at /sse.
func Handler(server *mcp.Server) http.Handler {
	getServer := func(*http.Request) *mcp.Server { return server }
	streamable := http.NewCrossOriginProtection().Handler(mcp.NewStreamableHTTPHandler(getServer, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
	}))
	sse := http.NewCrossOriginProtection().Handler(newLegacySSE(server))

	app := httpapp.New()
	app.Use(httpapp.Recovery())
	app.All("/mcp", func(ctx *httpapp.Context, _ func()) {
		ctx.TakeOver()
		streamable.ServeHTTP(ctx.Writer, ctx.Request)
	})
	app.All("/sse", func(ctx *httpapp.Context, _ func()) {
		ctx.TakeOver()
		sse.ServeHTTP(ctx.Writer, ctx.Request)
	})
	app.All("/messages", func(ctx *httpapp.Context, _ func()) {
		ctx.TakeOver()
		sse.ServeHTTP(ctx.Writer, ctx.Request)
	})
	return app
}

// Listen serves in the foreground until ctx is canceled, then drains requests
// and closes MCP sessions.
func Listen(ctx context.Context, addr string, server *mcp.Server) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen for MCP requests: %w", err)
	}
	defer listener.Close()
	defer func() {
		for session := range server.Sessions() {
			_ = session.Close()
		}
	}()

	baseCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	httpServer := &http.Server{
		Handler:           Handler(server),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
	}
	logger.Info("MCP HTTP server listening",
		"addr", listener.Addr().String(),
		"streamableHttp", "POST /mcp",
		"sse", "GET /sse, POST /messages?sessionId=...",
	)
	log.Printf("MCP HTTP listening on http://%s (POST /mcp, GET /sse, POST /messages?sessionId=...)", listener.Addr())

	finished := make(chan error, 1)
	go func() { finished <- httpServer.Serve(listener) }()
	select {
	case <-ctx.Done():
	case err := <-finished:
		if err != nil && err != http.ErrServerClosed {
			return err
		}
		return nil
	}
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		_ = httpServer.Close()
		return fmt.Errorf("drain MCP requests: %w", err)
	}
	return nil
}
