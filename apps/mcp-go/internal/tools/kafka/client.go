package kafka

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/oauth"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"github.com/twmb/franz-go/pkg/sasl/scram"
)

type clientOptions struct {
	RequestTimeout       int               `json:"requestTimeout"`
	ConnectTimeout       int               `json:"connectTimeout"`
	Retries              *int              `json:"retries"`
	RetryDelay           int               `json:"retryDelay"`
	Acks                 *int              `json:"acks"`
	Compression          string            `json:"compression"`
	GroupID              string            `json:"groupId"`
	MaxWaitTime          int               `json:"maxWaitTime"`
	MaxBytes             int32             `json:"maxBytes"`
	MaxBytesPerPartition int32             `json:"maxBytesPerPartition"`
	AutocreateTopics     bool              `json:"autocreateTopics"`
	TLS                  *config.TLSConfig `json:"tls"`
	SASL                 *struct {
		Mechanism string `json:"mechanism"`
		Username  string `json:"username"`
		Password  string `json:"password"`
		Token     string `json:"token"`
	} `json:"sasl"`
}

func buildConfig(cfg config.KafkaConfig, values map[string]any, timeoutMS int) ([]kgo.Opt, clientOptions, error) {
	var extra clientOptions
	raw, err := json.Marshal(values)
	if err != nil {
		return nil, extra, err
	}
	if values != nil {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&extra); err != nil {
			return nil, extra, fmt.Errorf("Kafka config: %w", err)
		}
	}
	if cfg.Brokers == "" {
		cfg.Brokers = "localhost:9092"
	}
	brokers := strings.Split(cfg.Brokers, ",")
	for i := range brokers {
		brokers[i] = strings.TrimSpace(brokers[i])
		if brokers[i] == "" {
			return nil, extra, fmt.Errorf("Kafka brokers must not contain empty entries")
		}
	}
	requestTimeout := time.Duration(timeoutMS) * time.Millisecond
	if extra.RequestTimeout > 0 {
		requestTimeout = time.Duration(extra.RequestTimeout) * time.Millisecond
	}
	opts := []kgo.Opt{kgo.SeedBrokers(brokers...), kgo.ClientID(cfg.ClientID), kgo.RequestTimeoutOverhead(requestTimeout), kgo.RetryTimeout(requestTimeout), kgo.RecordDeliveryTimeout(max(time.Second, requestTimeout)), kgo.RecordPartitioner(explicitPartitioner{})}
	if extra.ConnectTimeout > 0 {
		opts = append(opts, kgo.DialTimeout(time.Duration(extra.ConnectTimeout)*time.Millisecond))
	}
	if extra.Retries != nil {
		opts = append(opts, kgo.RequestRetries(*extra.Retries), kgo.RecordRetries(*extra.Retries))
	}
	if extra.RetryDelay > 0 {
		opts = append(opts, kgo.RetryBackoffFn(func(int) time.Duration { return time.Duration(extra.RetryDelay) * time.Millisecond }))
	}
	if extra.MaxWaitTime > 0 {
		opts = append(opts, kgo.FetchMaxWait(time.Duration(extra.MaxWaitTime)*time.Millisecond))
	}
	if extra.MaxBytes > 0 {
		opts = append(opts, kgo.FetchMaxBytes(extra.MaxBytes))
	}
	if extra.MaxBytesPerPartition > 0 {
		opts = append(opts, kgo.FetchMaxPartitionBytes(extra.MaxBytesPerPartition))
	}
	if extra.AutocreateTopics {
		opts = append(opts, kgo.AllowAutoTopicCreation())
	}
	if extra.Acks != nil {
		opts = append(opts, kgo.DisableIdempotentWrite())
		switch *extra.Acks {
		case -1:
			opts = append(opts, kgo.RequiredAcks(kgo.AllISRAcks()))
		case 0:
			opts = append(opts, kgo.RequiredAcks(kgo.NoAck()))
		case 1:
			opts = append(opts, kgo.RequiredAcks(kgo.LeaderAck()))
		default:
			return nil, extra, fmt.Errorf("Kafka config.acks must be -1, 0 or 1")
		}
	}
	if extra.Compression != "" {
		codecs := map[string]kgo.CompressionCodec{"none": kgo.NoCompression(), "gzip": kgo.GzipCompression(), "snappy": kgo.SnappyCompression(), "lz4": kgo.Lz4Compression(), "zstd": kgo.ZstdCompression()}
		codec, ok := codecs[extra.Compression]
		if !ok {
			return nil, extra, fmt.Errorf("unsupported Kafka compression %q", extra.Compression)
		}
		opts = append(opts, kgo.ProducerBatchCompression(codec))
	}
	protocol := strings.ToUpper(cfg.SecurityProtocol)
	if protocol != "" && protocol != "PLAINTEXT" && protocol != "SSL" && protocol != "SASL_PLAINTEXT" && protocol != "SASL_SSL" {
		return nil, extra, fmt.Errorf("unsupported Kafka security_protocol %q", protocol)
	}
	tlsOptions := cfg.TLS
	if extra.TLS != nil {
		tlsOptions = extra.TLS
	}
	if tlsOptions == nil && (protocol == "SSL" || protocol == "SASL_SSL") {
		tlsOptions = &config.TLSConfig{}
	}
	tlsConfig, err := config.TLS(tlsOptions, "")
	if err != nil {
		return nil, extra, err
	}
	if tlsConfig != nil {
		opts = append(opts, kgo.DialTLSConfig(tlsConfig))
	}
	mechanism, username, password, token := cfg.SASLMechanism, cfg.Username, cfg.Password, ""
	if extra.SASL != nil {
		mechanism, username, password, token = extra.SASL.Mechanism, extra.SASL.Username, extra.SASL.Password, extra.SASL.Token
	}
	if mechanism == "" && (username != "" || protocol == "SASL_SSL" || protocol == "SASL_PLAINTEXT") {
		mechanism = "PLAIN"
	}
	switch strings.ToUpper(mechanism) {
	case "":
	case "PLAIN":
		opts = append(opts, kgo.SASL(plain.Auth{User: username, Pass: password}.AsMechanism()))
	case "SCRAM-SHA-256":
		opts = append(opts, kgo.SASL(scram.Auth{User: username, Pass: password}.AsSha256Mechanism()))
	case "SCRAM-SHA-512":
		opts = append(opts, kgo.SASL(scram.Auth{User: username, Pass: password}.AsSha512Mechanism()))
	case "OAUTHBEARER":
		opts = append(opts, kgo.SASL(oauth.Auth{Token: token}.AsMechanism()))
	default:
		return nil, extra, fmt.Errorf("unsupported Kafka SASL mechanism %q", mechanism)
	}
	return opts, extra, nil
}

// Honor explicit partitions while retaining keyed/default partitioning.
type explicitPartitioner struct{}

func (explicitPartitioner) ForTopic(topic string) kgo.TopicPartitioner {
	return explicitTopicPartitioner{kgo.StickyKeyPartitioner(nil).ForTopic(topic)}
}

type explicitTopicPartitioner struct{ fallback kgo.TopicPartitioner }

func (p explicitTopicPartitioner) RequiresConsistency(r *kgo.Record) bool {
	return r.Partition >= 0 || p.fallback.RequiresConsistency(r)
}
func (p explicitTopicPartitioner) Partition(r *kgo.Record, n int) int {
	if r.Partition >= 0 {
		return int(r.Partition)
	}
	return p.fallback.Partition(r, n)
}
