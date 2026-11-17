// Client for the Claude Code VSCode extension's embedded MCP server. After
// connecting we announce ourselves with `ide_connected` (the extension routes
// Cmd+Option+K to the CLI whose pid matches the active terminal) and listen
// for `at_mentioned` notifications carrying file path + 0-based line range.
package vscode

import (
	"context"
	"encoding/json"
	"os"
	"sync/atomic"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/yukino-js/yukino/yukino/internal/version"
)

// IdeAtMention mirrors the reference IdeAtMention; lines are 1-based.
type IdeAtMention struct {
	FilePath string
	// 1-based
	LineStart *int
	// 1-based
	LineEnd *int
}

// IdeConnection mirrors the reference IdeConnection.
type IdeConnection struct {
	IdeName string
	Close   func() error
}

// ConnectToIdeOptions mirrors the reference connectToIde options; the context
// stands in for the AbortSignal.
type ConnectToIdeOptions struct {
	Cwd           string
	OnAtMentioned func(IdeAtMention)
	OnDisconnect  func()
}

// InIdeTerminal reports whether we plausibly run inside an IDE terminal.
func InIdeTerminal() bool {
	_, ssePortSet := os.LookupEnv(ClaudeCodeSSEPortEnvVar)
	return ssePortSet || os.Getenv(TermProgramEnvVar) == TermProgramVscode
}

// parseAtMention validates at_mentioned params like the reference zod schema:
// filePath is a required string; lineStart/lineEnd are optional numbers (null
// is rejected).
func parseAtMention(params json.RawMessage) (IdeAtMention, bool) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(params, &raw); err != nil {
		return IdeAtMention{}, false
	}
	filePathRaw, ok := raw["filePath"]
	if !ok {
		return IdeAtMention{}, false
	}
	var filePath string
	if err := json.Unmarshal(filePathRaw, &filePath); err != nil {
		return IdeAtMention{}, false
	}
	mention := IdeAtMention{FilePath: filePath}
	for _, field := range []struct {
		key string
		out **int
	}{
		{"lineStart", &mention.LineStart},
		{"lineEnd", &mention.LineEnd},
	} {
		value, present := raw[field.key]
		if !present {
			continue
		}
		if string(value) == "null" {
			return IdeAtMention{}, false
		}
		var number float64
		if err := json.Unmarshal(value, &number); err != nil {
			return IdeAtMention{}, false
		}
		// Extension sends 0-based lines; expose 1-based like editors display.
		converted := int(number) + 1
		*field.out = &converted
	}
	return mention, true
}

// ConnectToIde discovers the IDE extension, connects its MCP server and wires
// the at_mentioned/ide_connected exchange. It returns (nil, nil) when no IDE
// is present or the context is aborted, mirroring the reference's null return.
func ConnectToIde(ctx context.Context, opts ConnectToIdeOptions) (*IdeConnection, error) {
	// Only poll when we're plausibly inside an IDE terminal — the extension
	// may still be activating right after the window opens.
	var deadline time.Time
	if InIdeTerminal() {
		deadline = time.Now().Add(IdeDetectTimeout)
	}

	if ctx.Err() != nil {
		return nil, nil
	}
	ide := DetectIde(opts.Cwd)
	for ide == nil && time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, nil
		case <-time.After(IdeDetectPollInterval):
		}
		ide = DetectIde(opts.Cwd)
	}
	if ide == nil || ctx.Err() != nil {
		return nil, nil
	}

	headers := map[string]string{}
	if ide.AuthToken != "" {
		headers[IdeAuthHeader] = ide.AuthToken
	}
	transport := &WebSocketTransport{URL: ide.URL, Headers: headers}
	transport.OnNotification = func(method string, params json.RawMessage) bool {
		if method != "at_mentioned" {
			return false
		}
		if mention, ok := parseAtMention(params); ok && opts.OnAtMentioned != nil {
			opts.OnAtMentioned(mention)
		}
		return true
	}

	client := mcp.NewClient(&mcp.Implementation{Name: "yukino", Version: version.Version}, nil)
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		if ctx.Err() == nil {
			log.Error(map[string]any{"err": err, "url": ide.URL}, "failed to connect to IDE extension")
		}
		return nil, nil
	}
	if ctx.Err() != nil {
		_ = session.Close()
		return nil, nil
	}

	// The SDK exposes the close signal through Wait; manual closes suppress the
	// disconnect callback like the reference clears client.onclose first.
	var manualClose atomic.Bool
	if opts.OnDisconnect != nil {
		go func() {
			_ = session.Wait()
			if !manualClose.Load() {
				opts.OnDisconnect()
			}
		}()
	}

	if err := transport.Notify(IdeConnectedMethod, map[string]any{"pid": os.Getpid()}); err != nil {
		log.Error(map[string]any{"err": err}, "failed to send ide_connected notification")
	}

	return &IdeConnection{
		IdeName: ide.IdeName,
		Close: func() error {
			manualClose.Store(true)
			return session.Close()
		},
	}, nil
}
