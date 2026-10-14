package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/joho/godotenv"
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
	// Like dotenv/config in the TS entrypoint, load the process .env before
	// resolving transport settings or constructing any module.
	path := os.Getenv("DOTENV_CONFIG_PATH")
	if path == "" {
		path = ".env"
	}
	if os.Getenv("DOTENV_CONFIG_OVERRIDE") == "true" {
		_ = godotenv.Overload(path)
	} else {
		_ = godotenv.Load(path)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	mcpServer := server.New()
	server.InitModules(ctx)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.ShutdownModules(shutdownCtx)
	}()

	if useHTTP(os.Args[1:]) {
		cfg := config.Load()
		addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
		return httpserver.Listen(ctx, addr, mcpServer)
	}

	logger.Info("MCP stdio server connected")
	err := mcpServer.Run(ctx, &mcp.StdioTransport{})
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func useHTTP(args []string) bool {
	if os.Getenv("MCP_TRANSPORT") == "http" {
		return true
	}
	for _, arg := range args {
		if arg == "--http" {
			return true
		}
	}
	return false
}
