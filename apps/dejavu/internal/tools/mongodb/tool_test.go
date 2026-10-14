package mongodb

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestCommandOrderThroughSDK(t *testing.T) {
	ctx := context.Background()
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "command", InputSchema: inputSchema}, func(ctx context.Context, req *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
		command, err := parseCommand(req, in.Command)
		if err != nil {
			return nil, nil, err
		}
		if len(command) != 2 || command[0].Key != "find" || command[1].Key != "filter" {
			t.Errorf("command order changed: %v", command)
		}
		return &mcp.CallToolResult{}, nil, nil
	})
	ct, st := mcp.NewInMemoryTransports()
	ss, err := server.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	result, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "command", Arguments: json.RawMessage(`{"command":{"find":"users","filter":{}}}`)})
	if err != nil || result.IsError {
		t.Fatalf("call failed: %v, %+v", err, result)
	}
}
