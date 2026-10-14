package main

import (
	"context"
	"errors"
	"flag"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/httpserver"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/logger"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/server"
)

func main() {
	if err := run(); err != nil {
		logger.Error("fatal error during startup", logger.Err(err))
		os.Exit(1)
	}
}

func run() error {
	opts, err := parseOptions(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := config.LoadFile(opts.configPath); err != nil {
		return err
	}
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	mcpServer := server.New()
	server.InitModules(ctx)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.ShutdownModules(shutdownCtx)
	}()

	if opts.http || cfg.Transport == "http" {
		addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
		return httpserver.Listen(ctx, addr, mcpServer)
	}

	logger.Info("MCP stdio server connected")
	err = mcpServer.Run(ctx, &mcp.StdioTransport{})
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

type options struct {
	configPath string
	http       bool
}

func parseOptions(args []string) (options, error) {
	var opts options
	flags := flag.NewFlagSet("yukino-mcp", flag.ContinueOnError)
	flags.StringVar(&opts.configPath, "config", config.DefaultPath, "JSON/JSONC configuration file")
	flags.BoolVar(&opts.http, "http", false, "use HTTP transport instead of configured transport")
	if err := flags.Parse(args); err != nil {
		return opts, err
	}
	if flags.NArg() != 0 {
		return opts, errors.New("unexpected positional arguments")
	}
	return opts, nil
}
