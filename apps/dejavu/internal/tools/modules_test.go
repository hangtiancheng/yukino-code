package tools_test

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/clickhouse"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/createapp"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/docs"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/etcd"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/github"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/grafana"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/kafka"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/milvus"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/minio"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/mongodb"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/mysql"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/postgres"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/prometheus"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools/redis"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestModuleSchemasRegister(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	modules := []tools.ToolModule{createapp.Module(), docs.Module(), github.Module(), kafka.Module(), clickhouse.Module(), etcd.Module(), grafana.Module(), milvus.Module(), minio.Module(), mongodb.Module(), mysql.Module(), postgres.Module(), prometheus.Module(), redis.Module()}
	for _, module := range modules {
		module.Register(server)
	}
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
	listed, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Tools) != 15 {
		t.Fatalf("got %d tools, want 15", len(listed.Tools))
	}
	raw, err := os.ReadFile("contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	var contracts map[string]map[string]any
	if err := json.Unmarshal(raw, &contracts); err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		serialized, _ := json.Marshal(tool)
		var actual map[string]any
		_ = json.Unmarshal(serialized, &actual)
		for _, key := range []string{"inputSchema", "annotations", "_meta"} {
			if !reflect.DeepEqual(actual[key], contracts[tool.Name][key]) {
				t.Errorf("%s %s differs from TS contract", tool.Name, key)
			}
		}
	}
	for _, test := range []struct {
		name  string
		args  map[string]any
		valid bool
	}{
		{tools.CreateApp, map[string]any{"html": "<p>中文</p>", "title": strings.Repeat("中", 60)}, true},
		{tools.CreateApp, map[string]any{"html": "<p/>", "title": strings.Repeat("😀", 121)}, false},
		{tools.CreateApp, map[string]any{"html": "<p/>", "title": ""}, false},
		{tools.KafkaTool, map[string]any{"operation": "invalid"}, false},
		{tools.Prometheus, map[string]any{"path": "/", "method": "CONNECT"}, false},
		{tools.DocsTool, map[string]any{"query": "hello", "top_k": 11}, false},
		{tools.MySQLTool, map[string]any{"sql": "SELECT 1", "connection_url": " \ufeff "}, false},
	} {
		result, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: test.name, Arguments: test.args})
		if err != nil || result.IsError == test.valid {
			t.Errorf("%s arguments %#v: err=%v result=%+v", test.name, test.args, err, result)
		}
	}
}

func TestTSDefaultsTrimAndUnknownKeys(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	type input struct {
		Connection string `json:"connection_url"`
		SQL        string `json:"sql"`
		Params     []any  `json:"params"`
		Unknown    string `json:"unknown"`
	}
	var received input
	tools.AddTool(server, &mcp.Tool{Name: tools.PostgresTool}, func(_ context.Context, _ *mcp.CallToolRequest, in input) (*mcp.CallToolResult, any, error) {
		received = in
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, nil, nil
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
	result, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: tools.PostgresTool, Arguments: map[string]any{"connection_url": "\ufeff postgres://localhost/db \ufeff", "sql": "SELECT 1", "unknown": "strip"}})
	if err != nil || result.IsError || received.Connection != "postgres://localhost/db" || received.Params == nil || received.Unknown != "" {
		t.Fatalf("Zod semantics: %#v err=%v result=%+v", received, err, result)
	}
}
