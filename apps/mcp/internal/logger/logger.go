// Package logger provides the structured logger used across the MCP server.
//
// It mirrors the TypeScript build, which emits pino JSON records to stderr
// (file descriptor 2) under the name "yukino-mcp". Keeping logs on stderr is
// essential for the stdio transport, where stdout carries the JSON-RPC frames.
package logger

import (
	"context"
	"log/slog"
	"os"
	"sync"
)

const name = "yukino-mcp"

var (
	once   sync.Once
	logger *slog.Logger
)

// L returns the process-wide structured logger. It writes JSON records to
// stderr and is safe for concurrent use.
func L() *slog.Logger {
	once.Do(func() {
		handler := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
			Level: slog.LevelInfo,
		})
		logger = slog.New(handler).With("name", name)
	})
	return logger
}

// Info logs at info level with the given key/value pairs.
func Info(msg string, args ...any) { L().Info(msg, args...) }

// Warn logs at warn level with the given key/value pairs.
func Warn(msg string, args ...any) { L().Warn(msg, args...) }

// Error logs at error level with the given key/value pairs.
func Error(msg string, args ...any) { L().Error(msg, args...) }

// Debug logs at debug level with the given key/value pairs.
func Debug(msg string, args ...any) { L().Debug(msg, args...) }

// Err is a convenience for logging an error under the "err" key, matching the
// pino errorKey used by the TypeScript build.
func Err(err error) slog.Attr { return slog.Any("err", errString(err)) }

func errString(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}

// WithContext returns the logger; context is accepted for API symmetry with
// slog but the MCP server does not derive per-request loggers.
func WithContext(_ context.Context) *slog.Logger { return L() }
