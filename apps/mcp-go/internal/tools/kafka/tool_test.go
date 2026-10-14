package kafka

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	native "github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

func kafkaCall(t *testing.T, in Input) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if in.TimeoutMS == 0 {
		in.TimeoutMS = 3000
	}
	res, _, err := handle(ctx, nil, in)
	if err != nil || res.IsError {
		t.Fatalf("%s failed: %v, %+v", in.Operation, err, res)
	}
	raw, _ := json.Marshal(res.StructuredContent)
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

func TestNativeAssignedConsumeLimitOffsetsAndEmptyPartition(t *testing.T) {
	cluster, err := native.NewMockCluster(1)
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	if err := cluster.CreateTopic("parity", 2, 1); err != nil {
		t.Fatal(err)
	}
	brokers, partition, first := cluster.BootstrapServers(), 1, "first"
	kafkaCall(t, Input{Brokers: brokers, Operation: "produce", Topic: "parity", Messages: []Message{
		{Partition: &partition, Value: &first, Headers: map[string]string{"trace": "test"}},
		{Partition: &partition, Value: nil},
	}})
	zero := int64(0)
	in := Input{Brokers: brokers, Operation: "consume", AutoCommit: true, MaxMessages: 1, FromBeginning: true,
		Assignments: []Assignment{{Topic: "parity", Partition: 0, Offset: &zero}, {Topic: "parity", Partition: 1, Offset: &zero}},
		Config:      map[string]any{"group.id": "parity-assigned", "auto.commit.interval.ms": float64(0), "fetch.wait.max.ms": float64(10)},
	}
	data := kafkaCall(t, in)
	if data["count"] != float64(1) || data["group_id"] != "parity-assigned" {
		t.Fatalf("consume: %#v", data)
	}
	message := data["messages"].([]any)[0].(map[string]any)
	if message["value"] != "first" || message["partition"] != float64(1) {
		t.Fatalf("message: %#v", message)
	}
	header := message["headers"].([]any)[0].(map[string]any)["trace"].(map[string]any)
	if header["type"] != "Buffer" || len(header["data"].([]any)) != 4 {
		t.Fatalf("headers: %#v", header)
	}
	committed := kafkaCall(t, Input{Brokers: brokers, Operation: "committed_offsets", GroupID: "parity-assigned", Topic: "parity", Partitions: []PartitionRef{{Partition: 0}, {Partition: 1}}})
	offsets := committed["offsets"].([]any)
	if offsets[0].(map[string]any)["offset"] != float64(-1001) || offsets[1].(map[string]any)["offset"] != float64(1) {
		t.Fatalf("committed: %#v", committed)
	}
	in.Assignments = []Assignment{{Topic: "parity", Partition: 1}}
	second := kafkaCall(t, in)["messages"].([]any)[0].(map[string]any)
	if second["offset"] != float64(1) || second["value"] != nil {
		t.Fatalf("tombstone: %#v", second)
	}
	watermarks := kafkaCall(t, Input{Brokers: brokers, Operation: "watermark_offsets", Topic: "parity", Partitions: []PartitionRef{{Partition: 1}}})
	wm := watermarks["partitions"].([]any)[0].(map[string]any)
	if wm["low"] != float64(0) || wm["high"] != float64(2) {
		t.Fatalf("watermarks: %#v", watermarks)
	}
}

func TestNativeConsumeDeadlineAcrossEmptyPartitions(t *testing.T) {
	cluster, err := native.NewMockCluster(1)
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	if err := cluster.CreateTopic("empty", 2, 1); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	data := kafkaCall(t, Input{Brokers: cluster.BootstrapServers(), Operation: "consume", TimeoutMS: 150, MaxMessages: 10,
		Assignments: []Assignment{{Topic: "empty", Partition: 0}, {Topic: "empty", Partition: 1}},
	})
	if data["count"] != float64(0) || time.Since(start) > 2*time.Second {
		t.Fatalf("deadline: %v, %#v", time.Since(start), data)
	}
}

func TestNativeDeliveryFailureIsAnError(t *testing.T) {
	cluster, err := native.NewMockCluster(1)
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	if err := cluster.CreateTopic("one", 1, 1); err != nil {
		t.Fatal(err)
	}
	partition, value := 8, "value"
	res, _, err := handle(context.Background(), nil, Input{Brokers: cluster.BootstrapServers(), Operation: "produce", Topic: "one", TimeoutMS: 1000, Messages: []Message{{Partition: &partition, Value: &value}}})
	if err != nil || !res.IsError {
		t.Fatalf("delivery failure reported success: %v, %+v", err, res)
	}
}
