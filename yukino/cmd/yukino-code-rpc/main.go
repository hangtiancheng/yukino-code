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

// Command yukino-code-rpc serves one standalone agent session over Connect
// (protobuf RPC), the transport the terminal UI speaks. It mirrors the stdio
// deployment: no chat pipeline (the sink is a no-op), the workspace is the
// process working directory unless -workdir says otherwise, and the session
// lives as long as the process.
//
//	yukino-code-rpc [-addr 127.0.0.1:7860] [-workdir DIR]
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

	"github.com/hangtiancheng/yukino-code/yukino/bridge"
	"github.com/hangtiancheng/yukino-code/yukino/pb/gen/yukino/v1/yukinov1connect"
	pbserver "github.com/hangtiancheng/yukino-code/yukino/pb/server"
)

// noopSink drops finalized text: the client receives it through the Watch
// stream (stream_text / stream_end) and owns whatever persistence it wants.
// The empty return keeps the stream anchor on the streamed bubble.
type noopSink struct{}

func (noopSink) SaveAssistantText(_, _, _ string) string { return "" }

func main() {
	addr := flag.String("addr", "127.0.0.1:7860", "listen address for the Connect RPC server")
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
			log.Fatalf("yukino-code-rpc: %v", err)
		}
	}
	mgr.OverridePermissionMode(*permMode)
	sess, err := mgr.NewStandaloneSession("terminal", wd)
	if err != nil {
		mgr.Stop()
		log.Fatalf("yukino-code-rpc: %v", err)
	}
	defer sess.Close()

	mux := http.NewServeMux()
	path, handler := yukinov1connect.NewAgentServiceHandler(pbserver.NewAgentService(sess))
	mux.Handle(path, handler)

	httpSrv := &http.Server{Addr: *addr, Handler: mux}
	go func() {
		<-ctx.Done()
		log.Printf("yukino-code-rpc: shutting down")
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	}()

	log.Printf("yukino-code-rpc: serving %s on http://%s%s", wd, *addr, path)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("yukino-code-rpc: %v", err)
	}
}
