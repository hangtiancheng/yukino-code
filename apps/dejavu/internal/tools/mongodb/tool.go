// Package mongodb exposes the mongodb_tool: arbitrary MongoDB database
// commands with full connection privileges.
package mongodb

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/operations"
)

const serverSelectionTimeout = 10 * time.Second

const description = "Execute any MongoDB database command with full connection privileges: find, insert, update, delete, aggregate, create/drop collections or databases, indexes, users and administration. Supply a raw command document (e.g. {\"find\":\"users\",\"filter\":{}}); BSON values use Extended JSON such as {\"$oid\":\"...\"}. Set database to admin for administrative commands. Returns the full command response as canonical Extended JSON, preserving BSON types and cursor batches. Uses mongodb.url or connection_url; database defaults to mongodb.database or the URL's database."

// Input is the mongodb_tool argument schema. Command is kept as raw JSON so
// that the command document's key order (the command name must be first) is
// preserved through to BSON.
type Input struct {
	ConnectionURL string          `json:"connection_url,omitempty"`
	Database      string          `json:"database,omitempty"`
	Command       json.RawMessage `json:"command"`
}

// inputSchema is hand-written because the inferred schema for json.RawMessage
// would be an array of bytes, whereas the command must be an object.
var inputSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"connection_url": map[string]any{
			"type":        "string",
			"description": operations.ConnectionURLDescription,
		},
		"database": map[string]any{
			"type":        "string",
			"description": "Database override; use admin for server-level commands.",
		},
		"command": map[string]any{
			"type":                 "object",
			"description":          "Raw MongoDB command document, accepting Extended JSON for BSON types. There is no operation allowlist.",
			"additionalProperties": true,
		},
	},
	"required": []string{"command"},
}

// Module returns the mongodb tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "mongodb",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.MongoDBTool,
				Title:       "MongoDB",
				Description: description,
				InputSchema: inputSchema,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, req *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	cfg := config.Load().MongoDB
	rawURL, err := operations.RequireConnection(in.ConnectionURL, cfg.URL, "mongodb.url")
	if err != nil {
		return operations.ResultErr(tools.MongoDBTool, err), nil, nil
	}
	if len(in.Command) == 0 || strings.TrimSpace(string(in.Command)) == "" {
		return operations.ResultErr(tools.MongoDBTool, errors.New("command must not be empty")), nil, nil
	}

	clientOpts := options.Client().ApplyURI(rawURL).SetServerSelectionTimeout(serverSelectionTimeout)
	client, err := mongo.Connect(clientOpts)
	if err != nil {
		return operations.ResultErr(tools.MongoDBTool, err), nil, nil
	}
	defer func() { _ = client.Disconnect(context.Background()) }()

	dbName := in.Database
	if dbName == "" {
		dbName = cfg.Database
	}
	if dbName == "" {
		dbName = databaseFromURL(rawURL)
	}

	command, err := parseCommand(req, in.Command)
	if err != nil {
		return operations.ResultErr(tools.MongoDBTool, err), nil, nil
	}

	result := client.Database(dbName).RunCommand(ctx, command)
	if err := result.Err(); err != nil {
		return operations.ResultErr(tools.MongoDBTool, err), nil, nil
	}
	var response bson.D
	if err := result.Decode(&response); err != nil {
		return operations.ResultErr(tools.MongoDBTool, err), nil, nil
	}
	extJSON, err := bson.MarshalExtJSON(response, true, false)
	if err != nil {
		return operations.ResultErr(tools.MongoDBTool, err), nil, nil
	}
	var data any
	if err := json.Unmarshal(extJSON, &data); err != nil {
		return operations.ResultErr(tools.MongoDBTool, err), nil, nil
	}
	return operations.Result(map[string]any{"data": data}), nil, nil
}

func parseCommand(req *mcp.CallToolRequest, fallback json.RawMessage) (bson.D, error) {
	// AddTool validates through a map and re-marshals arguments, which may
	// reorder the command fields. MongoDB requires the command name first.
	if req != nil && req.Params != nil {
		var original Input
		if err := json.Unmarshal(req.Params.Arguments, &original); err != nil {
			return nil, err
		}
		fallback = original.Command
	}
	var command bson.D
	err := bson.UnmarshalExtJSON(fallback, false, &command)
	return command, err
}

// databaseFromURL extracts the database name from a mongodb:// connection
// string path, defaulting to "test" (the MongoDB driver default) when absent.
func databaseFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "test"
	}
	name := strings.TrimPrefix(u.Path, "/")
	if idx := strings.IndexByte(name, '?'); idx >= 0 {
		name = name[:idx]
	}
	if name == "" {
		return "test"
	}
	return name
}
