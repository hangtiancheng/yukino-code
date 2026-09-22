// Command yukino-code-ws serves one standalone agent session over a websocket
// speaking JSON-RPC 2.0 — the websocket counterpart of yukino-code-rpc (Connect)
// and yukino-code-stdio, and the transport the terminal UI's --ws mode
// connects to. It mirrors the stdio deployment: no chat pipeline (the sink is a
// no-op), the workspace is the process working directory unless -workdir says
// otherwise, and the session lives as long as the process. Prompts arrive over
// the socket as session/prompt requests; agent progress streams back as
// JSON-RPC notifications.
//
//	yukino-code-ws [-addr 127.0.0.1:7861] [-path /ws] [-workdir DIR] [-provider NAME] [-permission-mode MODE]
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hangtiancheng/yukino.go/yukino_http"

	"github.com/hangtiancheng/yukino-code/yukino/bridge"
	"github.com/hangtiancheng/yukino-code/yukino/ws"
)

// maxWSMessage caps one inbound websocket message. Prompts may carry base64
// image blocks, so the cap is generous; it mirrors the stdio transport's line
// limit scaled up for the framing overhead.
const maxWSMessage = 32 << 20

// noopSink drops finalized text: the client receives it through the socket
// (agent/stream_text, agent/stream_end) and owns whatever persistence it wants.
// The empty return keeps the stream anchor on the streamed bubble.
type noopSink struct{}

func (noopSink) SaveAssistantText(_, _, _ string) string { return "" }

func main() {
	addr := flag.String("addr", "127.0.0.1:7861", "listen address for the websocket server")
	path := flag.String("path", "/ws", "websocket route path")
	workDir := flag.String("workdir", "", "agent workspace directory (default: process working directory)")
	provider := flag.String("provider", "", "provider name from ~/.yukino/config.yaml (default: default_provider entry, else first)")
	permMode := flag.String("permission-mode", "", "override permission_mode (default/acceptEdits/plan/bypassPermissions)")
	flag.Parse()

	wd := *workDir
	if wd == "" {
		var err error
		if wd, err = os.Getwd(); err != nil {
			wd = "."
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mgr := bridge.NewManager(noopSink{})
	defer mgr.Stop()
	if *provider != "" {
		if err := mgr.UseProvider(*provider); err != nil {
			mgr.Stop()
			log.Fatalf("yukino-code-ws: %v", err)
		}
	}
	mgr.OverridePermissionMode(*permMode)
	sess, err := mgr.NewStandaloneSession("terminal", wd)
	if err != nil {
		mgr.Stop()
		log.Fatalf("yukino-code-ws: %v", err)
	}
	defer sess.Close()

	app := yukino_http.New()
	app.Get(*path, func(c *yukino_http.Context, _ func()) {
		conn, err := c.Upgrade(&yukino_http.UpgradeOptions{MaxMessageSize: maxWSMessage})
		if err != nil {
			// Upgrade already recorded the HTTP error status; respond() writes it.
			return
		}
		ws.ServeSession(sess, conn)
	})

	go func() {
		<-ctx.Done()
		log.Printf("yukino-code-ws: shutting down")
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = app.Shutdown(shutCtx)
	}()

	log.Printf("yukino-code-ws: serving %s on ws://%s%s", wd, *addr, *path)
	if err := app.Listen(*addr); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("yukino-code-ws: %v", err)
	}
}
