// Package tools defines the MCP tool modules exposed by the server.
package tools

// Tool names are maintained explicitly here, mirroring src/tools/names.ts.
// Public tool names use snake_case with at least two words; existing compound
// names remain unchanged.
const (
	CreateApp    = "create_app"
	DocsTool     = "docs_tool"
	DocsSync     = "docs_sync"
	PostgresTool = "postgres_tool"
	MySQLTool    = "mysql_tool"
	RedisTool    = "redis_tool"
	MongoDBTool  = "mongodb_tool"
	Prometheus   = "prometheus_tool"
	Grafana      = "grafana_tool"
	MinioTool    = "minio_tool"
	Clickhouse   = "clickhouse_tool"
	EtcdTool     = "etcd_tool"
	MilvusTool   = "milvus_tool"
	KafkaTool    = "kafka_tool"
	GitHubTool   = "github_tool"
)
