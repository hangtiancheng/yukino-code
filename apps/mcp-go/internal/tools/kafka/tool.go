// Package kafka uses the same librdkafka engine as the TypeScript MCP server.
package kafka

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"time"

	native "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const description = "Operate an Apache Kafka cluster through librdkafka with full client privileges. Choose an operation: produce, consume, list_topics, describe_topics, describe_cluster, create_topic, delete_topic, create_partitions, watermark_offsets and committed_offsets (-1001 means uncommitted). Raw librdkafka configuration (security.protocol, sasl.*, ssl.*, etc.) is passed through config. Message keys/values are strings decoded with encoding (utf8 default, or base64 for binary); consume returns at most max_messages within timeout_ms. Uses KAFKA_BROKERS (default localhost:9092) or brokers, plus KAFKA_CLIENT_ID and optional SASL settings."

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
	Config            map[string]any    `json:"config,omitempty" jsonschema:"Raw librdkafka client configuration, e.g. {\"security.protocol\":\"SASL_SSL\",\"sasl.mechanisms\":\"SCRAM-SHA-512\"}."`
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
	env := config.Load().Kafka
	brokers := in.Brokers
	if brokers == "" {
		brokers = env.Brokers
	}
	if brokers == "" {
		brokers = "localhost:9092"
	}
	clientID := in.ClientID
	if clientID == "" {
		clientID = env.ClientID
	}
	if in.Encoding == "" {
		in.Encoding = "utf8"
	}
	if in.TimeoutMS == 0 {
		in.TimeoutMS = 15000
	}
	if in.MaxMessages == 0 {
		in.MaxMessages = 50
	}
	conf := buildConfig(brokers, clientID, env, in.Config)
	data, err := runOperation(ctx, conf, in)
	if err != nil {
		return operations.ResultErr(tools.KafkaTool, err), nil, nil
	}
	return operations.Result(map[string]any{"operation": in.Operation, "data": data}), nil, nil
}

func buildConfig(brokers, clientID string, env config.KafkaConfig, extra map[string]any) native.ConfigMap {
	conf := native.ConfigMap{"metadata.broker.list": brokers, "client.id": clientID}
	for key, value := range map[string]string{"security.protocol": env.SecurityProtocol, "sasl.mechanisms": env.SASLMechanism, "sasl.username": env.Username, "sasl.password": env.Password} {
		if value != "" {
			conf[key] = value
		}
	}
	for key, value := range extra {
		// JSON numbers decode as float64; librdkafka accepts their string form.
		if number, ok := value.(float64); ok {
			value = strconv.FormatFloat(number, 'f', -1, 64)
		}
		conf[key] = value
	}
	return conf
}

func runOperation(ctx context.Context, conf native.ConfigMap, in Input) (any, error) {
	switch in.Operation {
	case "produce":
		return opProduce(ctx, conf, in)
	case "consume":
		return opConsume(ctx, conf, in)
	case "committed_offsets":
		return opCommittedOffsets(ctx, conf, in)
	case "create_topic", "delete_topic", "create_partitions":
		return opAdmin(ctx, conf, in)
	case "list_topics", "describe_topics", "describe_cluster", "watermark_offsets":
		client, err := native.NewProducer(&conf)
		if err != nil {
			return nil, err
		}
		defer client.Close()
		var topic *string
		allTopics := in.Operation == "list_topics" || (in.Operation == "describe_topics" && in.Topic == "")
		if in.Topic != "" && in.Operation != "describe_cluster" {
			topic = &in.Topic
		}
		metadata, err := client.GetMetadata(topic, allTopics, in.TimeoutMS)
		if err != nil {
			return nil, err
		}
		switch in.Operation {
		case "list_topics":
			names := make([]string, 0, len(metadata.Topics))
			for name := range metadata.Topics {
				names = append(names, name)
			}
			sort.Strings(names)
			return map[string]any{"topics": names}, nil
		case "describe_topics":
			return map[string]any{"topics": normalizeTopics(metadata)}, nil
		case "describe_cluster":
			brokers := make([]map[string]any, 0, len(metadata.Brokers))
			for _, broker := range metadata.Brokers {
				brokers = append(brokers, map[string]any{"id": broker.ID, "host": broker.Host, "port": broker.Port})
			}
			return map[string]any{"brokers": brokers, "orig_broker_id": metadata.OriginatingBroker.ID, "orig_broker_name": metadata.OriginatingBroker.Host}, nil
		case "watermark_offsets":
			if in.Topic == "" {
				return nil, fmt.Errorf("operation requires \"topic\"")
			}
			parts := in.Partitions
			if len(parts) == 0 {
				for _, part := range metadata.Topics[in.Topic].Partitions {
					parts = append(parts, PartitionRef{Partition: int(part.ID)})
				}
			}
			out := make([]map[string]any, 0, len(parts))
			for _, part := range parts {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				low, high, err := client.QueryWatermarkOffsets(in.Topic, int32(part.Partition), in.TimeoutMS)
				if err != nil {
					return nil, err
				}
				out = append(out, map[string]any{"partition": part.Partition, "low": low, "high": high})
			}
			return map[string]any{"topic": in.Topic, "partitions": out}, nil
		}
	}
	return nil, fmt.Errorf("unknown operation %q", in.Operation)
}

func opProduce(ctx context.Context, conf native.ConfigMap, in Input) (any, error) {
	if in.Topic == "" {
		return nil, fmt.Errorf("operation requires \"topic\"")
	}
	if len(in.Messages) == 0 {
		return nil, fmt.Errorf("produce requires at least one message")
	}
	conf["delivery.report.only.error"] = false
	producer, err := native.NewProducer(&conf)
	if err != nil {
		return nil, err
	}
	defer producer.Close()
	if _, err := producer.GetMetadata(nil, false, in.TimeoutMS); err != nil {
		return nil, err
	}
	delivery := make(chan native.Event, len(in.Messages))
	for _, input := range in.Messages {
		partition := int32(native.PartitionAny)
		if input.Partition != nil {
			partition = int32(*input.Partition)
		}
		message := &native.Message{TopicPartition: native.TopicPartition{Topic: &in.Topic, Partition: partition}}
		if input.Key != nil {
			message.Key = decode(*input.Key, in.Encoding)
		}
		if input.Value != nil {
			message.Value = decode(*input.Value, in.Encoding)
		}
		if input.Timestamp != nil {
			message.Timestamp = time.UnixMilli(*input.Timestamp)
		}
		for _, key := range operations.SortedKeys(input.Headers) {
			message.Headers = append(message.Headers, native.Header{Key: key, Value: []byte(input.Headers[key])})
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := producer.Produce(message, delivery); err != nil {
			return nil, err
		}
	}
	deadline := time.NewTimer(time.Duration(in.TimeoutMS) * time.Millisecond)
	defer deadline.Stop()
	for count := 0; count < len(in.Messages); {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, fmt.Errorf("Timed out waiting for Kafka delivery reports")
		case event := <-delivery:
			if report, ok := event.(*native.Message); ok {
				if report.TopicPartition.Error != nil {
					return nil, report.TopicPartition.Error
				}
				count++
			}
		}
	}
	return map[string]any{"produced": len(in.Messages)}, nil
}

func opConsume(ctx context.Context, conf native.ConfigMap, in Input) (any, error) {
	useAssign := len(in.Assignments) > 0
	if !useAssign && len(in.Topics) == 0 {
		return nil, fmt.Errorf("consume requires topics or assignments")
	}
	groupID := in.GroupID
	if groupID == "" {
		if value, ok := conf["group.id"].(string); ok {
			groupID = value
		}
	}
	if groupID == "" {
		var id [12]byte
		if _, err := rand.Read(id[:]); err != nil {
			return nil, err
		}
		groupID = "yukino-mcp-" + hex.EncodeToString(id[:])
	}
	conf["group.id"] = groupID
	conf["enable.auto.commit"] = in.AutoCommit
	// Close() polls the native queue while leaving the group. Disable implicit
	// offset storage so those discarded messages cannot advance committed offsets.
	storeOffsets := true
	if value, ok := conf["enable.auto.offset.store"]; ok {
		storeOffsets = fmt.Sprint(value) != "false" && fmt.Sprint(value) != "0"
	}
	conf["enable.auto.offset.store"] = false
	conf["auto.offset.reset"] = "latest"
	if in.FromBeginning {
		conf["auto.offset.reset"] = "earliest"
	}
	consumer, err := native.NewConsumer(&conf)
	if err != nil {
		return nil, err
	}
	defer consumer.Close()
	if _, err := consumer.GetMetadata(nil, false, in.TimeoutMS); err != nil {
		return nil, err
	}
	if useAssign {
		assignments := make([]native.TopicPartition, 0, len(in.Assignments))
		for _, assignment := range in.Assignments {
			offset := native.OffsetStored
			if assignment.Offset != nil {
				offset = native.Offset(*assignment.Offset)
			}
			topic := assignment.Topic
			assignments = append(assignments, native.TopicPartition{Topic: &topic, Partition: int32(assignment.Partition), Offset: offset})
		}
		err = consumer.Assign(assignments)
	} else {
		err = consumer.SubscribeTopics(in.Topics, nil)
	}
	if err != nil {
		return nil, err
	}
	// A single poll loop handles all partitions and only polls as many messages as
	// will be returned. No extra records can be consumed or auto-committed.
	messages := make([]map[string]any, 0, in.MaxMessages)
	deadline := time.Now().Add(time.Duration(in.TimeoutMS) * time.Millisecond)
	for len(messages) < in.MaxMessages {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		wait := min(100, max(1, int(remaining.Milliseconds())))
		switch event := consumer.Poll(wait).(type) {
		case *native.Message:
			if event.TopicPartition.Error != nil {
				return nil, event.TopicPartition.Error
			}
			messages = append(messages, normalizeMessage(event, in.Encoding))
			if storeOffsets {
				if _, err := consumer.StoreMessage(event); err != nil {
					return nil, err
				}
			}
		case native.Error:
			return nil, event
		}
	}
	return map[string]any{"count": len(messages), "group_id": groupID, "messages": messages}, nil
}

func opCommittedOffsets(ctx context.Context, conf native.ConfigMap, in Input) (any, error) {
	if in.GroupID == "" {
		return nil, fmt.Errorf("operation requires \"group_id\"")
	}
	if len(in.Partitions) == 0 {
		return nil, fmt.Errorf("committed_offsets requires partitions")
	}
	conf["group.id"] = in.GroupID
	consumer, err := native.NewConsumer(&conf)
	if err != nil {
		return nil, err
	}
	defer consumer.Close()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	refs := make([]native.TopicPartition, 0, len(in.Partitions))
	for _, part := range in.Partitions {
		topic := part.Topic
		if topic == "" {
			topic = in.Topic
		}
		refs = append(refs, native.TopicPartition{Topic: &topic, Partition: int32(part.Partition)})
	}
	committed, err := consumer.Committed(refs, in.TimeoutMS)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(committed))
	for _, part := range committed {
		if part.Error != nil {
			return nil, part.Error
		}
		out = append(out, map[string]any{"topic": *part.Topic, "partition": part.Partition, "offset": int64(part.Offset)})
	}
	return map[string]any{"group_id": in.GroupID, "offsets": out}, nil
}

func opAdmin(ctx context.Context, conf native.ConfigMap, in Input) (any, error) {
	if in.Topic == "" {
		return nil, fmt.Errorf("operation requires \"topic\"")
	}
	admin, err := native.NewAdminClient(&conf)
	if err != nil {
		return nil, err
	}
	defer admin.Close()
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(in.TimeoutMS)*time.Millisecond)
	defer cancel()
	var results []native.TopicResult
	switch in.Operation {
	case "create_topic":
		partitions, replicas := in.NumPartitions, in.ReplicationFactor
		if partitions == 0 {
			partitions = 1
		}
		if replicas == 0 {
			replicas = 1
		}
		results, err = admin.CreateTopics(callCtx, []native.TopicSpecification{{Topic: in.Topic, NumPartitions: partitions, ReplicationFactor: replicas, Config: in.TopicConfig}})
	case "delete_topic":
		results, err = admin.DeleteTopics(callCtx, []string{in.Topic})
	case "create_partitions":
		if in.NumPartitions == 0 {
			return nil, fmt.Errorf("create_partitions requires \"num_partitions\"")
		}
		results, err = admin.CreatePartitions(callCtx, []native.PartitionsSpecification{{Topic: in.Topic, IncreaseTo: in.NumPartitions}})
	}
	if err != nil {
		return nil, err
	}
	for _, result := range results {
		if result.Error.Code() != native.ErrNoError {
			return nil, result.Error
		}
	}
	switch in.Operation {
	case "create_topic":
		return map[string]any{"created": in.Topic}, nil
	case "delete_topic":
		return map[string]any{"deleted": in.Topic}, nil
	default:
		return map[string]any{"topic": in.Topic, "partitions": in.NumPartitions}, nil
	}
}

func normalizeTopics(metadata *native.Metadata) []map[string]any {
	names := make([]string, 0, len(metadata.Topics))
	for name := range metadata.Topics {
		names = append(names, name)
	}
	sort.Strings(names)
	topics := make([]map[string]any, 0, len(names))
	for _, name := range names {
		topic := metadata.Topics[name]
		partitions := make([]map[string]any, 0, len(topic.Partitions))
		for _, part := range topic.Partitions {
			normalized := map[string]any{"id": part.ID, "leader": part.Leader, "replicas": part.Replicas, "isrs": part.Isrs}
			partitions = append(partitions, normalized)
		}
		normalized := map[string]any{"name": name, "partitions": partitions}
		topics = append(topics, normalized)
	}
	return topics
}

func normalizeMessage(message *native.Message, encoding string) map[string]any {
	headers := make([]map[string]any, 0, len(message.Headers))
	for _, header := range message.Headers {
		data := make([]int, len(header.Value))
		for i, b := range header.Value {
			data[i] = int(b)
		}
		headers = append(headers, map[string]any{header.Key: map[string]any{"type": "Buffer", "data": data}})
	}
	var key, value any
	if message.Key != nil {
		key = encode(message.Key, encoding)
	}
	if message.Value != nil {
		value = encode(message.Value, encoding)
	}
	timestamp := int64(-1)
	if message.TimestampType != native.TimestampNotAvailable {
		timestamp = message.Timestamp.UnixMilli()
	}
	return map[string]any{"topic": *message.TopicPartition.Topic, "partition": message.TopicPartition.Partition, "offset": int64(message.TopicPartition.Offset), "timestamp": timestamp, "size": len(message.Value), "key": key, "value": value, "headers": headers}
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
