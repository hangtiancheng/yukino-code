// Package redis exposes the redis_tool: arbitrary Redis command batches on one
// dedicated connection.
package redis

import (
	"context"
	"fmt"
	"time"

	goredis "github.com/redis/go-redis/v9"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const connectTimeout = 10 * time.Second

const description = "Execute any Redis command with full connection privileges, including reads, writes, Lua scripts, configuration and destructive commands. Supply an ordered commands array of argument arrays, e.g. [[\"SET\",\"key\",\"value\"],[\"GET\",\"key\"]]. All commands run sequentially on one dedicated connection so SELECT, MULTI/EXEC and state changes work within a call. Stops at the first failed command and retains completed replies. Uses REDIS_URL or connection_url; independent of the docs connection."

// Input is the redis_tool argument schema.
type Input struct {
	ConnectionURL string     `json:"connection_url,omitempty" jsonschema:"Connection URL override; otherwise uses the configured environment variable."`
	Commands      [][]string `json:"commands" jsonschema:"Redis commands as argument arrays. Arguments are sent verbatim, without shell parsing or command filtering."`
}

// Module returns the redis tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "redis",
		Register: func(server *mcp.Server) {
			mcp.AddTool(server, &mcp.Tool{
				Name:        tools.RedisTool,
				Title:       "Redis",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	rawURL, err := operations.RequireConnection(in.ConnectionURL, config.Load().Redis.URL, "REDIS_URL")
	if err != nil {
		return operations.ResultErr(tools.RedisTool, err), nil, nil
	}
	opts, err := goredis.ParseURL(rawURL)
	if err != nil {
		return operations.ResultErr(tools.RedisTool, err), nil, nil
	}
	opts.DialTimeout = connectTimeout
	// In go-redis, zero selects the default retries. Retrying arbitrary writes
	// after a connection failure can execute them twice.
	opts.MaxRetries = -1

	client := goredis.NewClient(opts)
	defer client.Close()
	conn := client.Conn()
	defer conn.Close()

	results := make([]any, 0, len(in.Commands))
	fail := func(err error) (*mcp.CallToolResult, any, error) {
		data := map[string]any{
			"error":                fmt.Sprintf("%s failed: %s", tools.RedisTool, err.Error()),
			"results":              results,
			"failed_command_index": len(results),
		}
		return operations.WithError(operations.Result(data)), nil, nil
	}

	connectCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	if err := conn.Ping(connectCtx).Err(); err != nil {
		return fail(err)
	}

	for _, command := range in.Commands {
		args := make([]any, len(command))
		for i, arg := range command {
			args[i] = arg
		}
		cmd := conn.Do(ctx, args...)
		// A nil bulk reply (e.g. GET of a missing key) is a successful Redis
		// result, represented as null in the TypeScript tool.
		if cmd.Err() != nil && cmd.Err() != goredis.Nil {
			results = append(results, map[string]any{"name": "Error", "message": cmd.Err().Error()})
			data := map[string]any{
				"results":              results,
				"failed_command_index": len(results) - 1,
			}
			return operations.WithError(operations.Result(data)), nil, nil
		}
		results = append(results, cmd.Val())
	}
	return operations.Result(map[string]any{"results": results}), nil, nil
}
