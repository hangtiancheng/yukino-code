// Package config loads the MCP server's JSON/JSONC configuration at startup.
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/tidwall/jsonc"
)

const DefaultPath = ".config.jsonc"

type EmbeddingConfig struct {
	Model   string `json:"model"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
}
type EmbeddingConfigResult struct {
	OK     bool
	Config EmbeddingConfig
	Reason string
}
type RedisConfig struct {
	URL string `json:"url"`
}
type IndexConfig struct {
	DBPath string `json:"db_path"`
}
type GitHubConfig struct {
	Token    string `json:"token"`
	BaseURL  string `json:"base_url"`
	Hostname string `json:"hostname"`
}
type MinioConfig struct {
	Endpoint     string `json:"endpoint"`
	AccessKey    string `json:"access_key"`
	SecretKey    string `json:"secret_key"`
	Region       string `json:"region"`
	SessionToken string `json:"session_token"`
}
type ClickhouseConfig struct {
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database"`
}
type EtcdConfig struct {
	URL string `json:"url"`
}
type MilvusConfig struct {
	URL      string `json:"url"`
	Token    string `json:"token"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database"`
}
type GrafanaConfig struct {
	BaseURL  string `json:"base_url"`
	Token    string `json:"token"`
	Username string `json:"username"`
	Password string `json:"password"`
}
type TLSConfig struct {
	CAFile             string `json:"ca_file"`
	CertFile           string `json:"cert_file"`
	KeyFile            string `json:"key_file"`
	ServerName         string `json:"server_name"`
	InsecureSkipVerify bool   `json:"insecure_skip_verify"`
}
type KafkaConfig struct {
	Brokers          string     `json:"brokers"`
	ClientID         string     `json:"client_id"`
	Username         string     `json:"username"`
	Password         string     `json:"password"`
	SASLMechanism    string     `json:"sasl_mechanism"`
	SecurityProtocol string     `json:"security_protocol"`
	TLS              *TLSConfig `json:"tls"`
}
type PrometheusConfig struct {
	BaseURL  string `json:"base_url"`
	Token    string `json:"token"`
	Username string `json:"username"`
	Password string `json:"password"`
}
type PostgresConfig struct {
	URL string `json:"url"`
}

// MySQLConfig contains protocol connection options, never a URL or DSN.
type MySQLConfig struct {
	Host           string            `json:"host"`
	Port           int               `json:"port"`
	Socket         string            `json:"socket"`
	Username       string            `json:"username"`
	Password       string            `json:"password"`
	Database       string            `json:"database"`
	TimeoutMS      int               `json:"timeout_ms"`
	ReadTimeoutMS  int               `json:"read_timeout_ms"`
	WriteTimeoutMS int               `json:"write_timeout_ms"`
	Charset        string            `json:"charset"`
	Collation      string            `json:"collation"`
	Timezone       string            `json:"timezone"`
	TLS            *TLSConfig        `json:"tls"`
	Session        map[string]string `json:"session"`
}
type MongoDBConfig struct {
	URL      string `json:"url"`
	Database string `json:"database"`
}
type AppConfig struct {
	Embedding  EmbeddingConfigResult `json:"-"`
	Index      IndexConfig           `json:"index"`
	Redis      RedisConfig           `json:"redis"`
	GitHub     GitHubConfig          `json:"github"`
	Postgres   PostgresConfig        `json:"postgres"`
	MySQL      MySQLConfig           `json:"mysql"`
	MongoDB    MongoDBConfig         `json:"mongodb"`
	Prometheus PrometheusConfig      `json:"prometheus"`
	Grafana    GrafanaConfig         `json:"grafana"`
	Minio      MinioConfig           `json:"minio"`
	Clickhouse ClickhouseConfig      `json:"clickhouse"`
	Etcd       EtcdConfig            `json:"etcd"`
	Milvus     MilvusConfig          `json:"milvus"`
	Kafka      KafkaConfig           `json:"kafka"`
	DocsDir    string                `json:"docs_dir"`
	Host       string                `json:"host"`
	Port       int                   `json:"port"`
	Transport  string                `json:"transport"`
}

var current atomic.Pointer[AppConfig]

func init() { Set(Defaults()) }
func Defaults() AppConfig {
	home, _ := os.UserHomeDir()
	return AppConfig{
		Embedding: resolveEmbedding(EmbeddingConfig{}, "openai"),
		Index:     IndexConfig{DBPath: filepath.Join(home, ".yukino", "index.sqlite")},
		DocsDir:   filepath.Join(home, ".yukino", "docs"),
		Redis:     RedisConfig{URL: "redis://localhost:6379"},
		Minio:     MinioConfig{Region: "us-east-1"},
		Kafka:     KafkaConfig{ClientID: "yukino-mcp"},
		MySQL:     MySQLConfig{Host: "localhost", Port: 3306, TimeoutMS: 10000, Collation: "utf8mb4_unicode_ci"},
		Host:      "127.0.0.1", Port: 3300, Transport: "stdio",
	}
}

// Set installs an immutable snapshot before modules are initialized.
func Set(cfg AppConfig) { current.Store(&cfg) }
func Load() AppConfig   { return *current.Load() }
func LoadFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read configuration %q: %w", path, err)
	}
	cfg, err := Parse(data)
	if err != nil {
		return fmt.Errorf("configuration %q: %w", path, err)
	}
	Set(cfg)
	return nil
}

// Parse accepts JSON and JSONC and rejects unknown fields, including legacy DSNs.
func Parse(data []byte) (AppConfig, error) {
	data = jsonc.ToJSON(data)
	if !bytes.HasPrefix(bytes.TrimSpace(data), []byte("{")) {
		return AppConfig{}, fmt.Errorf("configuration must be a JSON object")
	}
	file := struct {
		AppConfig
		Embedding struct {
			EmbeddingConfig
			Protocol string `json:"protocol"`
		} `json:"embedding"`
	}{AppConfig: Defaults()}
	file.Embedding.Protocol = "openai"
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return AppConfig{}, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return AppConfig{}, fmt.Errorf("configuration must contain exactly one JSON object")
	}
	cfg := file.AppConfig
	if cfg.Port < 1 || cfg.Port > 65535 {
		return AppConfig{}, fmt.Errorf("port must be between 1 and 65535")
	}
	if cfg.Transport != "stdio" && cfg.Transport != "http" {
		return AppConfig{}, fmt.Errorf("transport must be stdio or http")
	}
	var sections map[string]json.RawMessage
	_ = json.Unmarshal(data, &sections)
	if raw, ok := sections["mysql"]; ok {
		var credentials map[string]json.RawMessage
		_ = json.Unmarshal(raw, &credentials)
		password, hasPassword := credentials["password"]
		if strings.TrimSpace(cfg.MySQL.Username) == "" || !hasPassword || bytes.Equal(bytes.TrimSpace(password), []byte("null")) {
			return AppConfig{}, fmt.Errorf("mysql requires username and password (use an empty password string if needed)")
		}
	}
	if cfg.MySQL.Port < 1 || cfg.MySQL.Port > 65535 {
		return AppConfig{}, fmt.Errorf("mysql.port must be between 1 and 65535")
	}
	if cfg.MySQL.TimeoutMS <= 0 || cfg.MySQL.ReadTimeoutMS < 0 || cfg.MySQL.WriteTimeoutMS < 0 {
		return AppConfig{}, fmt.Errorf("mysql timeout_ms must be positive; read_timeout_ms and write_timeout_ms must be nonnegative")
	}
	if cfg.MySQL.Socket == "" && strings.TrimSpace(cfg.MySQL.Host) == "" {
		return AppConfig{}, fmt.Errorf("mysql.host or mysql.socket is required")
	}
	cfg.Embedding = resolveEmbedding(file.Embedding.EmbeddingConfig, file.Embedding.Protocol)
	cfg.GitHub.BaseURL = strings.TrimRight(cfg.GitHub.BaseURL, "/")
	cfg.Grafana.BaseURL = strings.TrimRight(cfg.Grafana.BaseURL, "/")
	cfg.Prometheus.BaseURL = strings.TrimRight(cfg.Prometheus.BaseURL, "/")
	cfg.Minio.Endpoint = strings.TrimRight(cfg.Minio.Endpoint, "/")
	cfg.Clickhouse.URL = strings.TrimRight(cfg.Clickhouse.URL, "/")
	cfg.Etcd.URL = normalizeEtcdURL(cfg.Etcd.URL)
	cfg.Milvus.URL = strings.TrimRight(cfg.Milvus.URL, "/")
	if cfg.Milvus.Token == "" && (cfg.Milvus.Username != "" || cfg.Milvus.Password != "") {
		cfg.Milvus.Token = cfg.Milvus.Username + ":" + cfg.Milvus.Password
	}
	return cfg, nil
}
func resolveEmbedding(cfg EmbeddingConfig, protocol string) EmbeddingConfigResult {
	if protocol != "openai" {
		return EmbeddingConfigResult{Reason: fmt.Sprintf("unsupported embedding.protocol %q (only openai is supported)", protocol)}
	}
	var missing []string
	if strings.TrimSpace(cfg.Model) == "" {
		missing = append(missing, "embedding.model")
	}
	if strings.TrimSpace(cfg.BaseURL) == "" {
		missing = append(missing, "embedding.base_url")
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		missing = append(missing, "embedding.api_key")
	}
	if len(missing) > 0 {
		return EmbeddingConfigResult{Reason: "missing configuration fields: " + strings.Join(missing, ", ")}
	}
	return EmbeddingConfigResult{OK: true, Config: cfg}
}
func normalizeEtcdURL(raw string) string {
	first, _, _ := strings.Cut(raw, ",")
	first = strings.TrimSpace(first)
	if first == "" {
		return ""
	}
	if !strings.HasPrefix(strings.ToLower(first), "http://") && !strings.HasPrefix(strings.ToLower(first), "https://") {
		first = "http://" + first
	}
	return strings.TrimRight(first, "/")
}
