// Package server assembles the yukino-mcp server and registers every tool module.
package server

import (
	"context"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/logger"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/clickhouse"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/createapp"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/docs"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/etcd"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/github"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/grafana"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/kafka"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/milvus"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/minio"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/mongodb"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/mysql"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/postgres"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/prometheus"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/redis"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/version"
)

const serverName = "yukino-mcp"

func instructions() string {
	return "yukino-mcp provides tools for the Yukino CLI. Use " + tools.DocsTool + " to semantically " +
		"search the user's local knowledge base (Markdown/text files under ~/.yukino/docs) " +
		"whenever a question may be covered by project- or team-specific documents, " +
		"runbooks or notes. Use " + tools.CreateApp + " to display a self-contained HTML document as an " +
		"interactive app (charts, dashboards, calculators, visual demos) inline in the " +
		"conversation when the user wants to see or interact with a result rather than " +
		"read text. " +
		"Use " + tools.GitHubTool + " to run any gh CLI command for GitHub repositories, " +
		"issues, pull requests, reviews/merges, Actions, releases and projects. " +
		"Supply args without the leading gh. Use gh api for any REST endpoint and " +
		"gh api graphql for GraphQL queries/mutations; --paginate --slurp for pagination, " +
		"--json/--jq for focused output, stdin for --input - or --body-file -, and cwd " +
		"for local repository operations. Requires gh on PATH, with gh auth login or " +
		"GH_TOKEN/GITHUB_TOKEN. Use --help to discover subcommands and flags. " +
		"Use " + tools.DocsSync + " after changing local knowledge-base files or to await initial indexing. " +
		"Use " + tools.PostgresTool + " and " + tools.MySQLTool + " to execute any SQL (including writes, DDL and " +
		"multiple statements), " + tools.RedisTool + " for arbitrary Redis command batches, " + tools.MongoDBTool + " " +
		"for any MongoDB database command, and " + tools.Prometheus + " for PromQL, alerts, targets " +
		"and any Prometheus HTTP API or administrative endpoint, and " + tools.Grafana + " for Grafana " +
		"dashboards, folders, datasources, proxied datasource queries, annotations, alerting and admin APIs. " +
		"Use " + tools.MinioTool + " for any S3/MinIO object-storage operation, " +
		tools.Clickhouse + " for arbitrary ClickHouse SQL over the HTTP interface, " +
		tools.EtcdTool + " for etcd v3 key-value, lease, auth, cluster and maintenance operations, " +
		tools.MilvusTool + " for Milvus vector-database REST operations, and " +
		tools.KafkaTool + " for Kafka produce/consume and topic, partition, offset and cluster administration. " +
		"Connection URLs may be " +
		"configured in the environment or supplied per call. Public tool names use " +
		"snake_case with at least two words; existing compound names remain unchanged."
}

// Modules returns every tool module in the same order as the TypeScript server.
func Modules() []tools.ToolModule {
	return []tools.ToolModule{
		createapp.Module(),
		docs.Module(),
		github.Module(),
		postgres.Module(),
		mysql.Module(),
		redis.Module(),
		mongodb.Module(),
		prometheus.Module(),
		grafana.Module(),
		minio.Module(),
		clickhouse.Module(),
		etcd.Module(),
		milvus.Module(),
		kafka.Module(),
	}
}

// New returns an MCP server with every tool module registered.
func New() *mcp.Server {
	modules := Modules()
	seen := make(map[string]struct{}, len(modules))
	for _, module := range modules {
		if _, ok := seen[module.Name]; ok {
			panic(fmt.Sprintf("duplicate tool module name: %s", module.Name))
		}
		seen[module.Name] = struct{}{}
	}
	server := mcp.NewServer(&mcp.Implementation{
		Name:    serverName,
		Version: version.Version,
	}, &mcp.ServerOptions{Instructions: instructions()})
	for _, module := range modules {
		module.Register(server)
	}
	return server
}

// InitModules starts each module's optional initializer. A failure is logged and
// does not stop the process.
func InitModules(ctx context.Context) {
	for _, module := range Modules() {
		if module.Init == nil {
			continue
		}
		go func(module tools.ToolModule) {
			if err := module.Init(ctx); err != nil {
				logger.Warn("module init failed", "module", module.Name, logger.Err(err))
			}
		}(module)
	}
}

// ShutdownModules runs each module's optional shutdown hook in registration order.
func ShutdownModules(ctx context.Context) {
	for _, module := range Modules() {
		if module.Shutdown == nil {
			continue
		}
		if err := module.Shutdown(ctx); err != nil {
			logger.Warn("module shutdown failed", "module", module.Name, logger.Err(err))
		}
	}
}
