// Package kafka exposes kafka_tool: produce, consume, and administer a cluster
// through IBM Sarama. librdkafka configuration keys that Sarama understands are
// mapped; unknown keys are rejected.
package kafka

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/IBM/sarama"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/xdg-go/scram"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const description = "Operate an Apache Kafka cluster with full client privileges. Choose an operation: produce (send messages), consume (read messages by subscription or explicit partition assignments), list_topics, describe_topics, describe_cluster, create_topic, delete_topic, create_partitions, watermark_offsets (low/high per partition) and committed_offsets (a group's committed positions; -1001 means uncommitted). Message keys/values are strings decoded with encoding (utf8 default, or base64 for binary); consume returns at most max_messages within timeout_ms. Uses KAFKA_BROKERS (default localhost:9092) or brokers, plus KAFKA_CLIENT_ID and optional SASL settings. config accepts security.protocol, sasl.mechanisms, sasl.username, sasl.password, acks, compression.type, enable.auto.commit and auto.offset.reset."

// Message is one record to produce. A null value writes a tombstone.
type Message struct {
	Key       *string           `json:"key,omitempty"`
	Value     *string           `json:"value"`
	Partition *int              `json:"partition,omitempty"`
	Timestamp *int64            `json:"timestamp,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
}

// Assignment pins a consume call to one partition.
type Assignment struct {
	Topic     string `json:"topic"`
	Partition int    `json:"partition"`
	Offset    *int64 `json:"offset,omitempty"`
}

// PartitionRef selects a partition for watermarks or committed offsets.
type PartitionRef struct {
	Topic     string `json:"topic,omitempty"`
	Partition int    `json:"partition"`
	Offset    *int64 `json:"offset,omitempty"`
}

// Input is the kafka_tool argument schema.
type Input struct {
	Brokers           string            `json:"brokers,omitempty" jsonschema:"CSV broker list override, e.g. localhost:9092."`
	ClientID          string            `json:"client_id,omitempty" jsonschema:"Client id override."`
	Config            map[string]any    `json:"config,omitempty" jsonschema:"Sarama-mapped client configuration, e.g. {\"security.protocol\":\"SASL_SSL\",\"sasl.mechanisms\":\"SCRAM-SHA-512\"}."`
	Operation         string            `json:"operation" jsonschema:"produce, consume, list_topics, describe_topics, describe_cluster, create_topic, delete_topic, create_partitions, watermark_offsets, or committed_offsets."`
	Topic             string            `json:"topic,omitempty" jsonschema:"Target topic."`
	Topics            []string          `json:"topics,omitempty" jsonschema:"Topics to subscribe for consume."`
	Messages          []Message         `json:"messages,omitempty" jsonschema:"Messages to produce. A null value writes a tombstone."`
	Assignments       []Assignment      `json:"assignments,omitempty" jsonschema:"Explicit partition assignments for consume."`
	Partitions        []PartitionRef    `json:"partitions,omitempty" jsonschema:"Partition list for watermark_offsets and committed_offsets."`
	GroupID           string            `json:"group_id,omitempty" jsonschema:"Consumer group id."`
	FromBeginning     bool              `json:"from_beginning,omitempty" jsonschema:"Consume from the earliest offset."`
	AutoCommit        bool              `json:"auto_commit,omitempty" jsonschema:"Enable consumer auto-commit."`
	MaxMessages       int               `json:"max_messages,omitempty" jsonschema:"Maximum messages to collect for consume. Defaults to 50."`
	NumPartitions     int               `json:"num_partitions,omitempty" jsonschema:"Partition count for create_topic, or the desired total for create_partitions."`
	ReplicationFactor int               `json:"replication_factor,omitempty" jsonschema:"Replication factor for create_topic."`
	TopicConfig       map[string]string `json:"topic_config,omitempty" jsonschema:"Topic-level config entries for create_topic."`
	Encoding          string            `json:"encoding,omitempty" jsonschema:"Encoding for message keys and values: utf8 or base64. Defaults to utf8."`
	TimeoutMS         int               `json:"timeout_ms,omitempty" jsonschema:"Consume window and per-request timeout in milliseconds. Defaults to 15000."`
}

// Module returns the kafka tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "kafka",
		Register: func(server *mcp.Server) {
			mcp.AddTool(server, &mcp.Tool{
				Name:        tools.KafkaTool,
				Title:       "Kafka",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	cfg := config.Load().Kafka
	brokers := in.Brokers
	if brokers == "" {
		brokers = cfg.Brokers
	}
	if brokers == "" {
		brokers = "localhost:9092"
	}
	clientID := in.ClientID
	if clientID == "" {
		clientID = cfg.ClientID
	}
	if in.Encoding == "" {
		in.Encoding = "utf8"
	}
	if in.Encoding != "utf8" && in.Encoding != "base64" {
		return operations.ResultErr(tools.KafkaTool, fmt.Errorf("encoding must be utf8 or base64")), nil, nil
	}
	if in.TimeoutMS <= 0 {
		in.TimeoutMS = 15_000
	}
	if in.MaxMessages <= 0 {
		in.MaxMessages = 50
	}
	saramaCfg, err := buildConfig(brokers, clientID, cfg, in)
	if err != nil {
		return operations.ResultErr(tools.KafkaTool, err), nil, nil
	}
	data, err := runOperation(ctx, strings.Split(brokers, ","), saramaCfg, in)
	if err != nil {
		return operations.ResultErr(tools.KafkaTool, err), nil, nil
	}
	return operations.Result(map[string]any{"operation": in.Operation, "data": data}), nil, nil
}

func runOperation(ctx context.Context, brokers []string, saramaCfg *sarama.Config, in Input) (any, error) {
	switch in.Operation {
	case "produce":
		return opProduce(ctx, brokers, saramaCfg, in)
	case "consume":
		return opConsume(ctx, brokers, saramaCfg, in)
	case "list_topics":
		return withClient(brokers, saramaCfg, func(client sarama.Client) (any, error) {
			topics, err := client.Topics()
			if err != nil {
				return nil, err
			}
			sort.Strings(topics)
			return map[string]any{"topics": topics}, nil
		})
	case "describe_topics":
		return withAdmin(brokers, saramaCfg, func(admin sarama.ClusterAdmin) (any, error) {
			var names []string
			if in.Topic != "" {
				names = []string{in.Topic}
			}
			meta, err := admin.DescribeTopics(names)
			if err != nil {
				return nil, err
			}
			return map[string]any{"topics": meta}, nil
		})
	case "describe_cluster":
		return withAdmin(brokers, saramaCfg, func(admin sarama.ClusterAdmin) (any, error) {
			brokers, controller, err := admin.DescribeCluster()
			if err != nil {
				return nil, err
			}
			return map[string]any{"brokers": brokers, "controller_id": controller}, nil
		})
	case "create_topic":
		if in.Topic == "" {
			return nil, fmt.Errorf("operation requires \"topic\"")
		}
		partitions := in.NumPartitions
		if partitions <= 0 {
			partitions = 1
		}
		replicas := in.ReplicationFactor
		if replicas <= 0 {
			replicas = 1
		}
		entries := map[string]*string{}
		for key, value := range in.TopicConfig {
			copied := value
			entries[key] = &copied
		}
		return withAdmin(brokers, saramaCfg, func(admin sarama.ClusterAdmin) (any, error) {
			err := admin.CreateTopic(in.Topic, &sarama.TopicDetail{
				NumPartitions:     int32(partitions),
				ReplicationFactor: int16(replicas),
				ConfigEntries:     entries,
			}, false)
			if err != nil {
				return nil, err
			}
			return map[string]any{"created": in.Topic}, nil
		})
	case "delete_topic":
		if in.Topic == "" {
			return nil, fmt.Errorf("operation requires \"topic\"")
		}
		return withAdmin(brokers, saramaCfg, func(admin sarama.ClusterAdmin) (any, error) {
			if err := admin.DeleteTopic(in.Topic); err != nil {
				return nil, err
			}
			return map[string]any{"deleted": in.Topic}, nil
		})
	case "create_partitions":
		if in.Topic == "" {
			return nil, fmt.Errorf("operation requires \"topic\"")
		}
		if in.NumPartitions <= 0 {
			return nil, fmt.Errorf("create_partitions requires \"num_partitions\"")
		}
		return withAdmin(brokers, saramaCfg, func(admin sarama.ClusterAdmin) (any, error) {
			if err := admin.CreatePartitions(in.Topic, int32(in.NumPartitions), nil, false); err != nil {
				return nil, err
			}
			return map[string]any{"topic": in.Topic, "partitions": in.NumPartitions}, nil
		})
	case "watermark_offsets":
		if in.Topic == "" {
			return nil, fmt.Errorf("operation requires \"topic\"")
		}
		return withClient(brokers, saramaCfg, func(client sarama.Client) (any, error) {
			partitions := make([]int32, 0, len(in.Partitions))
			for _, part := range in.Partitions {
				partitions = append(partitions, int32(part.Partition))
			}
			if len(partitions) == 0 {
				parts, err := client.Partitions(in.Topic)
				if err != nil {
					return nil, err
				}
				partitions = parts
			}
			out := make([]map[string]any, 0, len(partitions))
			for _, partition := range partitions {
				low, err := client.GetOffset(in.Topic, partition, sarama.OffsetOldest)
				if err != nil {
					return nil, err
				}
				high, err := client.GetOffset(in.Topic, partition, sarama.OffsetNewest)
				if err != nil {
					return nil, err
				}
				out = append(out, map[string]any{"partition": partition, "low": low, "high": high})
			}
			return map[string]any{"topic": in.Topic, "partitions": out}, nil
		})
	case "committed_offsets":
		if in.GroupID == "" {
			return nil, fmt.Errorf("operation requires \"group_id\"")
		}
		if len(in.Partitions) == 0 {
			return nil, fmt.Errorf("committed_offsets requires partitions")
		}
		request := map[string][]int32{}
		for _, part := range in.Partitions {
			topic := part.Topic
			if topic == "" {
				topic = in.Topic
			}
			request[topic] = append(request[topic], int32(part.Partition))
		}
		return withAdmin(brokers, saramaCfg, func(admin sarama.ClusterAdmin) (any, error) {
			resp, err := admin.ListConsumerGroupOffsets(in.GroupID, request)
			if err != nil {
				return nil, err
			}
			var offsets []map[string]any
			for topic, blocks := range resp.Blocks {
				for partition, block := range blocks {
					offset := block.Offset
					if offset < 0 {
						offset = -1001
					}
					offsets = append(offsets, map[string]any{"topic": topic, "partition": partition, "offset": offset})
				}
			}
			return map[string]any{"group_id": in.GroupID, "offsets": offsets}, nil
		})
	default:
		return nil, fmt.Errorf("unsupported operation %q", in.Operation)
	}
}

func opProduce(ctx context.Context, brokers []string, cfg *sarama.Config, in Input) (any, error) {
	if in.Topic == "" {
		return nil, fmt.Errorf("operation requires \"topic\"")
	}
	if len(in.Messages) == 0 {
		return nil, fmt.Errorf("produce requires at least one message")
	}
	cfg.Producer.Return.Successes = true
	cfg.Producer.RequiredAcks = sarama.WaitForAll
	cfg.Producer.Timeout = time.Duration(in.TimeoutMS) * time.Millisecond
	cfg.Producer.Partitioner = func(topic string) sarama.Partitioner {
		return manualPartitioner{fallback: sarama.NewHashPartitioner(topic)}
	}
	client, err := sarama.NewClient(brokers, cfg)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	producer, err := sarama.NewSyncProducerFromClient(client)
	if err != nil {
		return nil, err
	}
	defer producer.Close()
	for _, message := range in.Messages {
		msg := &sarama.ProducerMessage{Topic: in.Topic}
		if message.Key != nil {
			msg.Key = sarama.ByteEncoder(decode(*message.Key, in.Encoding))
		}
		if message.Value != nil {
			msg.Value = sarama.ByteEncoder(decode(*message.Value, in.Encoding))
		}
		if message.Partition != nil {
			msg.Partition = int32(*message.Partition)
			msg.Metadata = manualPartition
		}
		if message.Timestamp != nil {
			msg.Timestamp = time.UnixMilli(*message.Timestamp)
		}
		for key, value := range message.Headers {
			msg.Headers = append(msg.Headers, sarama.RecordHeader{Key: []byte(key), Value: []byte(value)})
		}
		if _, _, err := producer.SendMessage(msg); err != nil {
			return nil, err
		}
	}
	_ = ctx
	return map[string]any{"produced": len(in.Messages)}, nil
}

const manualPartition = "manual"

type manualPartitioner struct {
	fallback sarama.Partitioner
}

func (p manualPartitioner) Partition(message *sarama.ProducerMessage, numPartitions int32) (int32, error) {
	if message.Metadata == manualPartition {
		return message.Partition, nil
	}
	return p.fallback.Partition(message, numPartitions)
}

func (p manualPartitioner) RequiresConsistency() bool { return true }

func opConsume(ctx context.Context, brokers []string, cfg *sarama.Config, in Input) (any, error) {
	useAssign := len(in.Assignments) > 0
	if !useAssign && len(in.Topics) == 0 {
		return nil, fmt.Errorf("consume requires topics or assignments")
	}
	groupID := in.GroupID
	if groupID == "" && !useAssign {
		groupID = fmt.Sprintf("yukino-mcp-%d", time.Now().UnixNano())
	}
	if in.FromBeginning {
		cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
	} else {
		cfg.Consumer.Offsets.Initial = sarama.OffsetNewest
	}
	cfg.Consumer.Offsets.AutoCommit.Enable = in.AutoCommit
	timeout := time.Duration(in.TimeoutMS) * time.Millisecond
	if useAssign {
		return consumeAssigned(ctx, brokers, cfg, in, timeout)
	}
	return consumeGroup(ctx, brokers, cfg, in, groupID, timeout)
}

func consumeAssigned(ctx context.Context, brokers []string, cfg *sarama.Config, in Input, timeout time.Duration) (any, error) {
	client, err := sarama.NewClient(brokers, cfg)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	consumer, err := sarama.NewConsumerFromClient(client)
	if err != nil {
		return nil, err
	}
	defer consumer.Close()
	collected := make([]map[string]any, 0, in.MaxMessages)
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for _, assignment := range in.Assignments {
		if len(collected) >= in.MaxMessages {
			break
		}
		offset := cfg.Consumer.Offsets.Initial
		if assignment.Offset != nil {
			offset = *assignment.Offset
		}
		partition, err := consumer.ConsumePartition(assignment.Topic, int32(assignment.Partition), offset)
		if err != nil {
			return nil, err
		}
		func() {
			defer partition.Close()
			for len(collected) < in.MaxMessages {
				select {
				case <-ctx.Done():
					return
				case <-deadline.C:
					return
				case err := <-partition.Errors():
					if err != nil {
						return
					}
				case msg, ok := <-partition.Messages():
					if !ok {
						return
					}
					collected = append(collected, normalizeMessage(msg, in.Encoding))
				}
			}
		}()
	}
	return map[string]any{"count": len(collected), "group_id": nil, "messages": collected}, nil
}

func consumeGroup(ctx context.Context, brokers []string, cfg *sarama.Config, in Input, groupID string, timeout time.Duration) (any, error) {
	group, err := sarama.NewConsumerGroup(brokers, groupID, cfg)
	if err != nil {
		return nil, err
	}
	defer group.Close()
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	handler := &groupHandler{max: in.MaxMessages, encoding: in.Encoding, cancel: cancel, autoCommit: in.AutoCommit}
	err = group.Consume(runCtx, in.Topics, handler)
	if err != nil && runCtx.Err() == nil {
		return nil, err
	}
	handler.mu.Lock()
	defer handler.mu.Unlock()
	return map[string]any{"count": len(handler.messages), "group_id": groupID, "messages": handler.messages}, nil
}

type groupHandler struct {
	max        int
	encoding   string
	cancel     context.CancelFunc
	autoCommit bool
	mu         sync.Mutex
	messages   []map[string]any
}

func (h *groupHandler) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (h *groupHandler) Cleanup(sarama.ConsumerGroupSession) error { return nil }

func (h *groupHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for {
		select {
		case <-session.Context().Done():
			return nil
		case msg, ok := <-claim.Messages():
			if !ok {
				return nil
			}
			h.mu.Lock()
			h.messages = append(h.messages, normalizeMessage(msg, h.encoding))
			full := len(h.messages) >= h.max
			h.mu.Unlock()
			if h.autoCommit {
				session.MarkMessage(msg, "")
			}
			if full {
				h.cancel()
				return nil
			}
		}
	}
}

func normalizeMessage(message *sarama.ConsumerMessage, encoding string) map[string]any {
	headers := make([]map[string]string, 0, len(message.Headers))
	for _, header := range message.Headers {
		headers = append(headers, map[string]string{string(header.Key): encode(header.Value, encoding)})
	}
	var key any
	if message.Key != nil {
		key = encode(message.Key, encoding)
	}
	var value any
	if message.Value != nil {
		value = encode(message.Value, encoding)
	}
	return map[string]any{
		"topic":     message.Topic,
		"partition": message.Partition,
		"offset":    message.Offset,
		"timestamp": message.Timestamp.UnixMilli(),
		"size":      len(message.Value),
		"key":       key,
		"value":     value,
		"headers":   headers,
	}
}

func withClient(brokers []string, cfg *sarama.Config, fn func(sarama.Client) (any, error)) (any, error) {
	client, err := sarama.NewClient(brokers, cfg)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	return fn(client)
}

func withAdmin(brokers []string, cfg *sarama.Config, fn func(sarama.ClusterAdmin) (any, error)) (any, error) {
	admin, err := sarama.NewClusterAdmin(brokers, cfg)
	if err != nil {
		return nil, err
	}
	defer admin.Close()
	return fn(admin)
}

func buildConfig(brokers, clientID string, env config.KafkaConfig, in Input) (*sarama.Config, error) {
	cfg := sarama.NewConfig()
	cfg.ClientID = clientID
	cfg.Net.DialTimeout = time.Duration(in.TimeoutMS) * time.Millisecond
	cfg.Net.ReadTimeout = cfg.Net.DialTimeout
	cfg.Net.WriteTimeout = cfg.Net.DialTimeout
	cfg.Metadata.Timeout = cfg.Net.DialTimeout
	values := map[string]any{}
	if env.SecurityProtocol != "" {
		values["security.protocol"] = env.SecurityProtocol
	}
	if env.SASLMechanism != "" {
		values["sasl.mechanisms"] = env.SASLMechanism
	}
	if env.Username != "" {
		values["sasl.username"] = env.Username
	}
	if env.Password != "" {
		values["sasl.password"] = env.Password
	}
	for key, value := range in.Config {
		values[key] = value
	}
	var unknown []string
	for key := range values {
		switch key {
		case "security.protocol", "sasl.mechanisms", "sasl.mechanism", "sasl.username", "sasl.password", "acks", "compression.type", "enable.auto.commit", "auto.offset.reset":
		default:
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, fmt.Errorf("unsupported kafka config keys: %s", strings.Join(unknown, ", "))
	}
	protocol := strings.ToUpper(asString(values["security.protocol"]))
	mechanism := asString(firstPresent(values, "sasl.mechanisms", "sasl.mechanism"))
	username := asString(values["sasl.username"])
	password := asString(values["sasl.password"])
	if username != "" && mechanism == "" {
		mechanism = "PLAIN"
	}
	if username != "" && protocol == "" {
		protocol = "SASL_PLAINTEXT"
	}
	switch protocol {
	case "", "PLAINTEXT":
	case "SSL":
		cfg.Net.TLS.Enable = true
		cfg.Net.TLS.Config = &tls.Config{}
	case "SASL_PLAINTEXT":
		cfg.Net.SASL.Enable = true
	case "SASL_SSL":
		cfg.Net.SASL.Enable = true
		cfg.Net.TLS.Enable = true
		cfg.Net.TLS.Config = &tls.Config{}
	default:
		return nil, fmt.Errorf("unsupported security.protocol %q", protocol)
	}
	if cfg.Net.SASL.Enable {
		cfg.Net.SASL.User = username
		cfg.Net.SASL.Password = password
		switch strings.ToUpper(mechanism) {
		case "", "PLAIN":
			cfg.Net.SASL.Mechanism = sarama.SASLTypePlaintext
		case "SCRAM-SHA-256":
			cfg.Net.SASL.Mechanism = sarama.SASLTypeSCRAMSHA256
			cfg.Net.SASL.SCRAMClientGeneratorFunc = scramGenerator(scram.SHA256)
		case "SCRAM-SHA-512":
			cfg.Net.SASL.Mechanism = sarama.SASLTypeSCRAMSHA512
			cfg.Net.SASL.SCRAMClientGeneratorFunc = scramGenerator(scram.SHA512)
		default:
			return nil, fmt.Errorf("unsupported sasl.mechanisms %q", mechanism)
		}
	}
	if acks, ok := values["acks"]; ok {
		switch strings.ToLower(asString(acks)) {
		case "0":
			cfg.Producer.RequiredAcks = sarama.NoResponse
		case "1":
			cfg.Producer.RequiredAcks = sarama.WaitForLocal
		case "all", "-1":
			cfg.Producer.RequiredAcks = sarama.WaitForAll
		default:
			return nil, fmt.Errorf("unsupported acks %v", acks)
		}
	}
	if compression, ok := values["compression.type"]; ok {
		switch strings.ToLower(asString(compression)) {
		case "", "none":
			cfg.Producer.Compression = sarama.CompressionNone
		case "gzip":
			cfg.Producer.Compression = sarama.CompressionGZIP
		case "snappy":
			cfg.Producer.Compression = sarama.CompressionSnappy
		case "lz4":
			cfg.Producer.Compression = sarama.CompressionLZ4
		case "zstd":
			cfg.Producer.Compression = sarama.CompressionZSTD
		default:
			return nil, fmt.Errorf("unsupported compression.type %v", compression)
		}
	}
	if raw, ok := values["auto.offset.reset"]; ok {
		switch strings.ToLower(asString(raw)) {
		case "earliest", "smallest", "beginning":
			cfg.Consumer.Offsets.Initial = sarama.OffsetOldest
		case "latest", "largest", "end":
			cfg.Consumer.Offsets.Initial = sarama.OffsetNewest
		default:
			return nil, fmt.Errorf("unsupported auto.offset.reset %v", raw)
		}
	}
	_ = brokers
	return cfg, nil
}

func firstPresent(values map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			return value
		}
	}
	return nil
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case nil:
		return ""
	default:
		return fmt.Sprint(typed)
	}
}

func decode(value, encoding string) []byte {
	if encoding == "base64" {
		raw, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return []byte(value)
		}
		return raw
	}
	return []byte(value)
}

func encode(value []byte, encoding string) string {
	if encoding == "base64" {
		return base64.StdEncoding.EncodeToString(value)
	}
	return string(value)
}
