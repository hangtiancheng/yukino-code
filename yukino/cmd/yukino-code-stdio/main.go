// Command yukino-code-stdio serves one standalone agent session over
// newline-delimited JSON-RPC 2.0 on stdin/stdout — the transport a terminal UI
// spawns as a child process. It mirrors yukino-code-rpc (Connect): no chat
// pipeline (the sink is a no-op), the workspace is the process working
// directory unless -workdir says otherwise, and the session lives as long as
// the process. Stdout belongs to the protocol alone; diagnostics go to stderr.
//
//	yukino-code-stdio [-workdir DIR] [-provider NAME] [-permission-mode MODE]
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/hangtiancheng/yukino-code/yukino/stdio"
)

func main() {
	workDir := flag.String("workdir", "", "agent workspace directory (default: process working directory)")
	provider := flag.String("provider", "", "provider name from ~/.yukino/config.yaml (default: first provider)")
	permMode := flag.String("permission-mode", "", "override permission_mode (default/acceptEdits/plan/bypassPermissions)")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := stdio.RunWithOptions(ctx, os.Stdin, os.Stdout, stdio.Options{
		WorkDir:        *workDir,
		Provider:       *provider,
		PermissionMode: *permMode,
	}); err != nil {
		log.Fatalf("yukino-code-stdio: %v", err)
	}
}
