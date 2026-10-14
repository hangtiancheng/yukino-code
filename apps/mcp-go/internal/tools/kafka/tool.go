// Package kafka implements Kafka operations with the pure Go franz-go client.
package kafka

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

const description = "Operate Kafka through franz-go: produce, consume, list_topics, describe_topics, describe_cluster, create_topic, delete_topic, create_partitions, watermark_offsets and committed_offsets (-1001 means uncommitted). Uses the kafka object in JSON configuration or per-call brokers/client_id/config. Config accepts documented Kafka client options, including nested tls and sasl objects. Consume returns at most max_messages within timeout_ms and only commits returned records when auto_commit is enabled."

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
	Config            map[string]any    `json:"config,omitempty" jsonschema:"Kafka client options: requestTimeout, connectTimeout, retries, retryDelay, acks, compression, groupId, maxWaitTime, maxBytes, maxBytesPerPartition, tls and sasl."`
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

func Module() tools.ToolModule {
	return tools.ToolModule{Name: "kafka", Register: func(server *mcp.Server) {
		tools.AddTool(server, &mcp.Tool{Name: tools.KafkaTool, Title: "Kafka", Description: description}, handle)
	}}
}
func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	if in.Encoding == "" {
		in.Encoding = "utf8"
	}
	if in.TimeoutMS == 0 {
		in.TimeoutMS = 15000
	}
	if in.MaxMessages == 0 {
		in.MaxMessages = 50
	}
	cfg := config.Load().Kafka
	if in.Brokers != "" {
		cfg.Brokers = in.Brokers
	}
	if in.ClientID != "" {
		cfg.ClientID = in.ClientID
	}
	opts, extra, err := buildConfig(cfg, in.Config, in.TimeoutMS)
	if err == nil {
		if in.GroupID == "" {
			in.GroupID = extra.GroupID
		}
		var data any
		data, err = runOperation(ctx, opts, in)
		if err == nil {
			return operations.Result(map[string]any{"operation": in.Operation, "data": data}), nil, nil
		}
	}
	return operations.ResultErr(tools.KafkaTool, err), nil, nil
}
func runOperation(ctx context.Context, opts []kgo.Opt, in Input) (any, error) {
	if in.Operation == "consume" {
		return opConsume(ctx, opts, in)
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(in.TimeoutMS)*time.Millisecond)
	defer cancel()
	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	admin := kadm.NewClient(client)
	admin.SetTimeoutMillis(int32(in.TimeoutMS))
	switch in.Operation {
	case "produce":
		if in.Topic == "" {
			return nil, fmt.Errorf("produce requires topic")
		}
		if len(in.Messages) == 0 {
			return nil, fmt.Errorf("produce requires at least one message")
		}
		records := make([]*kgo.Record, 0, len(in.Messages))
		for _, message := range in.Messages {
			record := &kgo.Record{Topic: in.Topic, Partition: -1}
			if message.Partition != nil {
				record.Partition = int32(*message.Partition)
			}
			if message.Key != nil {
				record.Key = decode(*message.Key, in.Encoding)
			}
			if message.Value != nil {
				record.Value = decode(*message.Value, in.Encoding)
			}
			if message.Timestamp != nil {
				record.Timestamp = time.UnixMilli(*message.Timestamp)
			}
			for _, key := range operations.SortedKeys(message.Headers) {
				record.Headers = append(record.Headers, kgo.RecordHeader{Key: key, Value: []byte(message.Headers[key])})
			}
			records = append(records, record)
		}
		if err := client.ProduceSync(ctx, records...).FirstErr(); err != nil {
			return nil, err
		}
		return map[string]any{"produced": len(records)}, nil
	case "committed_offsets":
		if in.GroupID == "" {
			return nil, fmt.Errorf("committed_offsets requires group_id")
		}
		if len(in.Partitions) == 0 {
			return nil, fmt.Errorf("committed_offsets requires partitions")
		}
		offsets, err := fetchOffsets(ctx, admin, in.GroupID)
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(in.Partitions))
		for _, part := range in.Partitions {
			topic := part.Topic
			if topic == "" {
				topic = in.Topic
			}
			if topic == "" {
				return nil, fmt.Errorf("committed_offsets requires a topic for each partition")
			}
			offset, ok := offsets.Lookup(topic, int32(part.Partition))
			if offset.Err != nil {
				return nil, offset.Err
			}
			at := int64(-1001)
			if ok && offset.At >= 0 {
				at = offset.At
			}
			out = append(out, map[string]any{"topic": topic, "partition": part.Partition, "offset": at})
		}
		return map[string]any{"group_id": in.GroupID, "offsets": out}, nil
	case "create_topic", "delete_topic", "create_partitions":
		if in.Topic == "" {
			return nil, fmt.Errorf("operation requires topic")
		}
		switch in.Operation {
		case "create_topic":
			conf := make(map[string]*string, len(in.TopicConfig))
			for key, value := range in.TopicConfig {
				conf[key] = &value
			}
			results, err := admin.CreateTopics(ctx, int32(max(1, in.NumPartitions)), int16(max(1, in.ReplicationFactor)), conf, in.Topic)
			if err != nil {
				return nil, err
			}
			if err := results.Error(); err != nil {
				return nil, err
			}
			return map[string]any{"created": in.Topic}, nil
		case "delete_topic":
			results, err := admin.DeleteTopics(ctx, in.Topic)
			if err != nil {
				return nil, err
			}
			if err := results.Error(); err != nil {
				return nil, err
			}
			return map[string]any{"deleted": in.Topic}, nil
		default:
			if in.NumPartitions == 0 {
				return nil, fmt.Errorf("create_partitions requires num_partitions")
			}
			results, err := admin.UpdatePartitions(ctx, in.NumPartitions, in.Topic)
			if err != nil {
				return nil, err
			}
			if err := results.Error(); err != nil {
				return nil, err
			}
			return map[string]any{"topic": in.Topic, "partitions": in.NumPartitions}, nil
		}
	case "watermark_offsets":
		if in.Topic == "" {
			return nil, fmt.Errorf("watermark_offsets requires topic")
		}
		low, err := admin.ListStartOffsets(ctx, in.Topic)
		if err != nil {
			return nil, err
		}
		high, err := admin.ListEndOffsets(ctx, in.Topic)
		if err != nil {
			return nil, err
		}
		if err := low.Error(); err != nil {
			return nil, err
		}
		if err := high.Error(); err != nil {
			return nil, err
		}
		parts := in.Partitions
		if len(parts) == 0 {
			for _, offset := range low.Offsets().Sorted() {
				parts = append(parts, PartitionRef{Partition: int(offset.Partition)})
			}
		}
		out := make([]map[string]any, 0, len(parts))
		for _, part := range parts {
			lo, lok := low.Lookup(in.Topic, int32(part.Partition))
			hi, hik := high.Lookup(in.Topic, int32(part.Partition))
			if !lok || !hik {
				return nil, fmt.Errorf("unknown partition %s/%d", in.Topic, part.Partition)
			}
			out = append(out, map[string]any{"partition": part.Partition, "low": lo.Offset, "high": hi.Offset})
		}
		return map[string]any{"topic": in.Topic, "partitions": out}, nil
	case "list_topics", "describe_topics", "describe_cluster":
		var metadata kadm.Metadata
		if in.Operation == "describe_cluster" {
			metadata, err = admin.BrokerMetadata(ctx)
		} else if in.Topic != "" {
			metadata, err = admin.Metadata(ctx, in.Topic)
		} else {
			metadata, err = admin.Metadata(ctx)
		}
		if err != nil {
			return nil, err
		}
		if in.Operation == "list_topics" {
			return map[string]any{"topics": metadata.Topics.Names()}, nil
		}
		if in.Operation == "describe_cluster" {
			brokers := make([]map[string]any, 0, len(metadata.Brokers))
			for _, broker := range metadata.Brokers {
				brokers = append(brokers, map[string]any{"id": broker.NodeID, "host": broker.Host, "port": broker.Port})
			}
			return map[string]any{"brokers": brokers, "controller_id": metadata.Controller, "cluster_id": metadata.Cluster}, nil
		}
		topics := make([]map[string]any, 0, len(metadata.Topics))
		for _, topic := range metadata.Topics.Sorted() {
			if topic.Err != nil {
				return nil, topic.Err
			}
			partitions := make([]map[string]any, 0, len(topic.Partitions))
			for _, part := range topic.Partitions.Sorted() {
				if part.Err != nil {
					return nil, part.Err
				}
				partitions = append(partitions, map[string]any{"id": part.Partition, "leader": part.Leader, "replicas": part.Replicas, "isrs": part.ISR})
			}
			topics = append(topics, map[string]any{"name": topic.Topic, "partitions": partitions})
		}
		return map[string]any{"topics": topics}, nil
	default:
		return nil, fmt.Errorf("unknown operation %q", in.Operation)
	}
}
func opConsume(ctx context.Context, opts []kgo.Opt, in Input) (any, error) {
	assigned := len(in.Assignments) > 0
	if !assigned && len(in.Topics) == 0 {
		return nil, fmt.Errorf("consume requires topics or assignments")
	}
	group := in.GroupID
	if group == "" {
		var id [12]byte
		if _, err := rand.Read(id[:]); err != nil {
			return nil, err
		}
		group = "yukino-mcp-" + hex.EncodeToString(id[:])
	}
	reset := kgo.NewOffset().AtEnd()
	if in.FromBeginning {
		reset = kgo.NewOffset().AtStart()
	}
	opts = append(opts, kgo.ConsumeResetOffset(reset))
	if !assigned {
		opts = append(opts, kgo.ConsumerGroup(group), kgo.DisableAutoCommit(), kgo.ConsumeTopics(in.Topics...))
	}
	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	admin := kadm.NewClient(client)
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(in.TimeoutMS)*time.Millisecond)
	defer cancel()
	if assigned {
		var stored kadm.OffsetResponses
		needStored := false
		for _, assignment := range in.Assignments {
			if assignment.Offset == nil {
				needStored = true
			}
		}
		if needStored {
			stored, err = fetchOffsets(callCtx, admin, group)
			if err != nil {
				return nil, err
			}
		}
		partitions := make(map[string]map[int32]kgo.Offset)
		for _, assignment := range in.Assignments {
			offset := reset
			if assignment.Offset != nil {
				offset = kgo.NewOffset().At(*assignment.Offset)
			} else if commit, ok := stored.Lookup(assignment.Topic, int32(assignment.Partition)); ok {
				if commit.Err != nil {
					return nil, commit.Err
				}
				if commit.At >= 0 {
					offset = kgo.NewOffset().At(commit.At)
				}
			}
			if partitions[assignment.Topic] == nil {
				partitions[assignment.Topic] = make(map[int32]kgo.Offset)
			}
			partitions[assignment.Topic][int32(assignment.Partition)] = offset
		}
		client.AddConsumePartitions(partitions)
	}
	records := make([]*kgo.Record, 0, in.MaxMessages)
	for len(records) < in.MaxMessages {
		fetched := client.PollRecords(callCtx, in.MaxMessages-len(records))
		for _, fetchErr := range fetched.Errors() {
			if errors.Is(fetchErr.Err, context.DeadlineExceeded) && ctx.Err() == nil && callCtx.Err() != nil {
				continue
			}
			return nil, fetchErr.Err
		}
		records = append(records, fetched.Records()...)
		if callCtx.Err() != nil {
			break
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Commit only returned records, using a fresh request window after a quiet read.
	if in.AutoCommit && len(records) > 0 {
		commitCtx, commitCancel := context.WithTimeout(ctx, time.Duration(in.TimeoutMS)*time.Millisecond)
		defer commitCancel()
		if assigned {
			offsets := make(kadm.Offsets)
			for _, record := range records {
				offsets.Add(kadm.Offset{Topic: record.Topic, Partition: record.Partition, At: record.Offset + 1, LeaderEpoch: record.LeaderEpoch})
			}
			result, err := admin.CommitOffsets(commitCtx, group, offsets)
			if err != nil {
				return nil, err
			}
			if err := result.Error(); err != nil {
				return nil, err
			}
		} else if err := client.CommitRecords(commitCtx, records...); err != nil {
			return nil, err
		}
	}
	messages := make([]map[string]any, 0, len(records))
	for _, record := range records {
		messages = append(messages, normalizeMessage(record, in.Encoding))
	}
	return map[string]any{"count": len(messages), "group_id": group, "messages": messages}, nil
}
func normalizeMessage(record *kgo.Record, encoding string) map[string]any {
	headers := make([]map[string]any, 0, len(record.Headers))
	for _, header := range record.Headers {
		data := make([]int, len(header.Value))
		for i, b := range header.Value {
			data[i] = int(b)
		}
		headers = append(headers, map[string]any{header.Key: map[string]any{"type": "Buffer", "data": data}})
	}
	var key, value any
	if record.Key != nil {
		key = encode(record.Key, encoding)
	}
	if record.Value != nil {
		value = encode(record.Value, encoding)
	}
	return map[string]any{"topic": record.Topic, "partition": record.Partition, "offset": record.Offset, "timestamp": record.Timestamp.UnixMilli(), "size": len(record.Value), "key": key, "value": value, "headers": headers}
}

func fetchOffsets(ctx context.Context, admin *kadm.Client, group string) (kadm.OffsetResponses, error) {
	offsets, err := admin.FetchOffsets(ctx, group)
	if errors.Is(err, kerr.GroupIDNotFound) {
		return nil, nil
	}
	return offsets, err
}
func decode(value, encoding string) []byte {
	if encoding == "base64" {
		return operations.DecodeBase64(value)
	}
	return []byte(value)
}
func encode(value []byte, encoding string) string {
	if encoding == "base64" {
		return base64.StdEncoding.EncodeToString(value)
	}
	return operations.DecodeUTF8(value)
}
