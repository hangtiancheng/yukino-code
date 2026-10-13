package tools_test

import (
	"context"
	"testing"
	"time"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/clickhouse"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/etcd"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/grafana"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/milvus"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/minio"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/mongodb"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/mysql"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/postgres"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/prometheus"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/redis"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestModuleSchemasRegister(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	modules := []tools.ToolModule{clickhouse.Module(), etcd.Module(), grafana.Module(), milvus.Module(), minio.Module(), mongodb.Module(), mysql.Module(), postgres.Module(), prometheus.Module(), redis.Module()}
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
	if len(listed.Tools) != len(modules) {
		t.Fatalf("got %d tools, want %d", len(listed.Tools), len(modules))
	}
}
