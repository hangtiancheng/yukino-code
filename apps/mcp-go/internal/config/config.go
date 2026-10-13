// Package config resolves the MCP server configuration from the environment.
//
// It is a faithful port of apps/mcp/src/shared/config.ts: every backend tool
// reads its connection details from environment variables, with per-call
// overrides supplied through tool arguments. Empty/whitespace-only values are
// dropped before resolution so that defaults and fallbacks apply, matching the
// zod schema behaviour of the TypeScript build.
package config

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// EmbeddingConfig holds the resolved OpenAI-compatible embedding provider.
type EmbeddingConfig struct {
	Model   string
	BaseURL string
	APIKey  string
}

// EmbeddingConfigResult is a discriminated result: either OK with a Config, or
// not OK with a human-readable Reason explaining what is missing.
type EmbeddingConfigResult struct {
	OK     bool
	Config EmbeddingConfig
	Reason string
}

// RedisConfig holds the Redis connection URL.
type RedisConfig struct{ URL string }

// IndexConfig holds the SQLite vector-index path.
type IndexConfig struct{ DBPath string }

// GitHubConfig holds gh CLI authentication details.
type GitHubConfig struct {
	Token    string
	BaseURL  string
	Hostname string
}

// MinioConfig holds S3/MinIO endpoint and credentials.
type MinioConfig struct {
	Endpoint     string
	AccessKey    string
	SecretKey    string
	Region       string
	SessionToken string
}

// ClickhouseConfig holds the ClickHouse HTTP interface details.
type ClickhouseConfig struct {
	URL      string
	Username string
	Password string
	Database string
}

// EtcdConfig holds the etcd v3 JSON-gateway base URL.
type EtcdConfig struct{ URL string }

// MilvusConfig holds the Milvus RESTful API details.
type MilvusConfig struct {
	URL      string
	Token    string
	Database string
}

// GrafanaConfig holds the Grafana base URL and credentials.
type GrafanaConfig struct {
	BaseURL  string
	Token    string
	Username string
	Password string
}

// KafkaConfig holds the Kafka broker list and SASL settings.
type KafkaConfig struct {
	Brokers          string
	ClientID         string
	Username         string
	Password         string
	SASLMechanism    string
	SecurityProtocol string
}

// PrometheusConfig holds the Prometheus base URL and credentials.
type PrometheusConfig struct {
	BaseURL  string
	Token    string
	Username string
	Password string
}

// PostgresConfig holds the PostgreSQL connection URL.
type PostgresConfig struct{ URL string }

// MySQLConfig holds the MySQL connection URL.
type MySQLConfig struct{ URL string }

// MongoDBConfig holds the MongoDB connection URL and default database.
type MongoDBConfig struct {
	URL      string
	Database string
}

// AppConfig is the fully resolved configuration tree.
type AppConfig struct {
	Embedding  EmbeddingConfigResult
	Index      IndexConfig
	Redis      RedisConfig
	GitHub     GitHubConfig
	Postgres   PostgresConfig
	MySQL      MySQLConfig
	MongoDB    MongoDBConfig
	Prometheus PrometheusConfig
	Grafana    GrafanaConfig
	Minio      MinioConfig
	Clickhouse ClickhouseConfig
	Etcd       EtcdConfig
	Milvus     MilvusConfig
	Kafka      KafkaConfig
	DocsDir    string
	Host       string
	Port       int
}

var httpSchemeRE = regexp.MustCompile(`(?i)^https?://`)

// Load resolves the configuration from the current process environment.
func Load() AppConfig { return LoadFrom(envMap(os.Environ())) }

// LoadFrom resolves the configuration from an explicit environment map. It is
// used by tests and mirrors loadConfig(env) in the TypeScript build.
func LoadFrom(env map[string]string) AppConfig {
	env = dropEmptyValues(env)

	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	docsDir := filepath.Join(home, ".yukino", "docs")
	if v, ok := env["YUKINO_DOCS_DIR"]; ok {
		docsDir = v
	}
	dbPath := filepath.Join(home, ".yukino", "index.sqlite")
	if v, ok := env["YUKINO_INDEX_DB"]; ok {
		dbPath = v
	}

	milvusToken := ""
	if v, ok := env["MILVUS_TOKEN"]; ok {
		milvusToken = v
	} else if env["MILVUS_USERNAME"] != "" || env["MILVUS_PASSWORD"] != "" {
		milvusToken = env["MILVUS_USERNAME"] + ":" + env["MILVUS_PASSWORD"]
	}

	return AppConfig{
		Embedding: resolveEmbedding(env),
		Index:     IndexConfig{DBPath: dbPath},
		Redis:     RedisConfig{URL: coalesceOr(env, "redis://localhost:6379", "REDIS_URL")},
		DocsDir:   docsDir,
		GitHub: GitHubConfig{
			Token:    strings.Trim(coalesce(env, "GITHUB_TOKEN", "GH_TOKEN"), " \t\n\r"),
			BaseURL:  stripTrailingSlashes(env["GITHUB_BASE_URL"]),
			Hostname: env["GH_HOST"],
		},
		Postgres: PostgresConfig{URL: coalesce(env, "POSTGRES_URL", "POSTGRESQL_URL", "DATABASE_URL")},
		MySQL:    MySQLConfig{URL: env["MYSQL_URL"]},
		MongoDB: MongoDBConfig{
			URL:      env["MONGODB_URL"],
			Database: env["MONGODB_DATABASE"],
		},
		Prometheus: PrometheusConfig{
			BaseURL:  stripTrailingSlashes(coalesce(env, "PROMETHEUS_BASE_URL", "PROMETHEUS_URL")),
			Token:    env["PROMETHEUS_TOKEN"],
			Username: env["PROMETHEUS_USERNAME"],
			Password: env["PROMETHEUS_PASSWORD"],
		},
		Grafana: GrafanaConfig{
			BaseURL:  stripTrailingSlashes(coalesce(env, "GRAFANA_BASE_URL", "GRAFANA_URL")),
			Token:    coalesce(env, "GRAFANA_TOKEN", "GRAFANA_API_KEY"),
			Username: env["GRAFANA_USERNAME"],
			Password: env["GRAFANA_PASSWORD"],
		},
		Minio: MinioConfig{
			Endpoint:     stripTrailingSlashes(coalesce(env, "MINIO_URL", "S3_ENDPOINT")),
			AccessKey:    coalesce(env, "MINIO_ACCESS_KEY", "AWS_ACCESS_KEY_ID"),
			SecretKey:    coalesce(env, "MINIO_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"),
			Region:       coalesceOr(env, "us-east-1", "MINIO_REGION", "AWS_REGION", "AWS_DEFAULT_REGION"),
			SessionToken: coalesce(env, "MINIO_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
		},
		Clickhouse: ClickhouseConfig{
			URL:      stripTrailingSlashes(coalesce(env, "CLICKHOUSE_URL", "CLICKHOUSE_HTTP_URL")),
			Username: env["CLICKHOUSE_USER"],
			Password: env["CLICKHOUSE_PASSWORD"],
			Database: env["CLICKHOUSE_DATABASE"],
		},
		Etcd: EtcdConfig{URL: normalizeEtcdURL(coalesce(env, "ETCD_URL", "ETCD_ENDPOINTS"))},
		Milvus: MilvusConfig{
			URL:      stripTrailingSlashes(coalesce(env, "MILVUS_URL", "MILVUS_ADDRESS")),
			Token:    milvusToken,
			Database: env["MILVUS_DATABASE"],
		},
		Kafka: KafkaConfig{
			Brokers:          env["KAFKA_BROKERS"],
			ClientID:         coalesceOr(env, "yukino-mcp", "KAFKA_CLIENT_ID"),
			Username:         env["KAFKA_USERNAME"],
			Password:         env["KAFKA_PASSWORD"],
			SASLMechanism:    env["KAFKA_SASL_MECHANISM"],
			SecurityProtocol: env["KAFKA_SECURITY_PROTOCOL"],
		},
		Host: coalesceOr(env, "127.0.0.1", "HOST"),
		Port: parsePort(env["PORT"]),
	}
}

func resolveEmbedding(env map[string]string) EmbeddingConfigResult {
	protocol := coalesceOr(env, "openai", "EMBEDDING_PROTOCOL")
	if protocol != "openai" {
		return EmbeddingConfigResult{
			OK:     false,
			Reason: `unsupported EMBEDDING_PROTOCOL "` + protocol + `" (only "openai" is supported)`,
		}
	}
	var missing []string
	model := env["EMBEDDING_MODEL"]
	baseURL := env["EMBEDDING_BASE_URL"]
	apiKey := coalesce(env, "EMBEDDING_API_KEY", "OPENAI_API_KEY")
	if model == "" {
		missing = append(missing, "EMBEDDING_MODEL")
	}
	if baseURL == "" {
		missing = append(missing, "EMBEDDING_BASE_URL")
	}
	if apiKey == "" {
		missing = append(missing, "EMBEDDING_API_KEY (or OPENAI_API_KEY)")
	}
	if len(missing) > 0 {
		return EmbeddingConfigResult{
			OK:     false,
			Reason: "missing environment variables: " + strings.Join(missing, ", "),
		}
	}
	return EmbeddingConfigResult{
		OK:     true,
		Config: EmbeddingConfig{Model: model, BaseURL: baseURL, APIKey: apiKey},
	}
}

func envMap(pairs []string) map[string]string {
	out := make(map[string]string, len(pairs))
	for _, pair := range pairs {
		if k, v, ok := strings.Cut(pair, "="); ok {
			out[k] = v
		}
	}
	return out
}

// dropEmptyValues removes entries whose value is empty or whitespace-only, so
// that defaults and ?? fallbacks apply exactly as in the zod-parsed env.
func dropEmptyValues(env map[string]string) map[string]string {
	out := make(map[string]string, len(env))
	for k, v := range env {
		if strings.TrimSpace(v) != "" {
			out[k] = v
		}
	}
	return out
}

// coalesce returns the value of the first key present in env, or "".
func coalesce(env map[string]string, keys ...string) string {
	for _, k := range keys {
		if v, ok := env[k]; ok {
			return v
		}
	}
	return ""
}

// coalesceOr returns the value of the first key present in env, or def when
// none are present. It models the TypeScript `A ?? B ?? def` chains.
func coalesceOr(env map[string]string, def string, keys ...string) string {
	for _, k := range keys {
		if v, ok := env[k]; ok {
			return v
		}
	}
	return def
}

func stripTrailingSlashes(value string) string { return strings.TrimRight(value, "/") }

func normalizeEtcdURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if httpSchemeRE.MatchString(trimmed) {
		return stripTrailingSlashes(trimmed)
	}
	first := ""
	if idx := strings.Index(trimmed, ","); idx >= 0 {
		first = strings.TrimSpace(trimmed[:idx])
	} else {
		first = strings.TrimSpace(trimmed)
	}
	if first == "" {
		return ""
	}
	return stripTrailingSlashes("http://" + first)
}

func parsePort(raw string) int {
	if raw == "" {
		return 3300
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return 3300
	}
	return n
}
