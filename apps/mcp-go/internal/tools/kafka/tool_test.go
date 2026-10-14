package kafka

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"crypto/tls"
	"encoding/pem"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/twmb/franz-go/pkg/kfake"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
		raw, _ := json.Marshal(res)
		t.Fatalf("%s failed: %v, %s", in.Operation, err, raw)
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

func TestFranzAssignedConsumeLimitOffsetsAndEmptyPartition(t *testing.T) {
	cluster, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.SeedTopics(2, "parity", "empty"), kfake.SeedTopics(1, "one"))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	brokers, partition, first := strings.Join(cluster.ListenAddrs(), ","), 1, "first"
	kafkaCall(t, Input{Brokers: brokers, Operation: "produce", Topic: "parity", Messages: []Message{
		{Partition: &partition, Value: &first, Headers: map[string]string{"trace": "test"}},
		{Partition: &partition, Value: nil},
	}})
	zero := int64(0)
	in := Input{Brokers: brokers, Operation: "consume", AutoCommit: true, MaxMessages: 1, FromBeginning: true,
		Assignments: []Assignment{{Topic: "parity", Partition: 0, Offset: &zero}, {Topic: "parity", Partition: 1, Offset: &zero}},
		Config:      map[string]any{"groupId": "parity-assigned", "maxWaitTime": float64(10)},
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

func TestFranzConsumeDeadlineAcrossEmptyPartitions(t *testing.T) {
	cluster, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.SeedTopics(2, "parity", "empty"), kfake.SeedTopics(1, "one"))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	start := time.Now()
	data := kafkaCall(t, Input{Brokers: strings.Join(cluster.ListenAddrs(), ","), Operation: "consume", TimeoutMS: 150, MaxMessages: 10,
		Assignments: []Assignment{{Topic: "empty", Partition: 0}, {Topic: "empty", Partition: 1}},
	})
	if data["count"] != float64(0) || time.Since(start) > 2*time.Second {
		t.Fatalf("deadline: %v, %#v", time.Since(start), data)
	}
}

func TestFranzDeliveryFailureIsAnError(t *testing.T) {
	cluster, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.SeedTopics(2, "parity", "empty"), kfake.SeedTopics(1, "one"))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	partition, value := 8, "value"
	res, _, err := handle(context.Background(), nil, Input{Brokers: strings.Join(cluster.ListenAddrs(), ","), Operation: "produce", Topic: "one", TimeoutMS: 1000, Messages: []Message{{Partition: &partition, Value: &value}}})
	if err != nil || !res.IsError {
		t.Fatalf("delivery failure reported success: %v, %+v", err, res)
	}
}

func TestFranzAdminAndSubscriptionResume(t *testing.T) {
	cluster, err := kfake.NewCluster(kfake.NumBrokers(1))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	brokers := strings.Join(cluster.ListenAddrs(), ",")
	call := func(in Input) map[string]any { in.Brokers = brokers; return kafkaCall(t, in) }
	call(Input{Operation: "create_topic", Topic: "events", NumPartitions: 1, TopicConfig: map[string]string{"retention.ms": "86400000"}})
	call(Input{Operation: "create_partitions", Topic: "events", NumPartitions: 2})
	listed := call(Input{Operation: "list_topics"})["topics"].([]any)
	if len(listed) != 1 || listed[0] != "events" {
		t.Fatalf("topics: %#v", listed)
	}
	described := call(Input{Operation: "describe_topics", Topic: "events"})["topics"].([]any)
	if len(described[0].(map[string]any)["partitions"].([]any)) != 2 {
		t.Fatalf("partitions: %#v", described)
	}
	if len(call(Input{Operation: "describe_cluster"})["brokers"].([]any)) != 1 {
		t.Fatal("missing broker metadata")
	}
	partition, value := 1, "first"
	call(Input{Operation: "produce", Topic: "events", Messages: []Message{{Partition: &partition, Value: &value}, {Partition: &partition, Value: nil}}})
	in := Input{Operation: "consume", Topics: []string{"events"}, GroupID: "subscription", FromBeginning: true, AutoCommit: true, MaxMessages: 1, TimeoutMS: 8000}
	first := call(in)
	if first["count"] != float64(1) {
		t.Fatalf("subscription: %#v", first)
	}
	committed := call(Input{Operation: "committed_offsets", GroupID: "subscription", Topic: "events", Partitions: []PartitionRef{{Partition: 1}}})
	if committed["offsets"].([]any)[0].(map[string]any)["offset"] != float64(1) {
		t.Fatalf("overcommitted: %#v", committed)
	}
	secondData := call(in)
	if secondData["count"] != float64(1) {
		t.Fatalf("resume count: %#v", secondData)
	}
	second := secondData["messages"].([]any)[0].(map[string]any)
	if second["offset"] != float64(1) || second["value"] != nil {
		t.Fatalf("resume: %#v", second)
	}
	call(Input{Operation: "delete_topic", Topic: "events"})
}

func TestFranzSASLAndVerifiedTLSFromJSON(t *testing.T) {
	certServer := httptest.NewTLSServer(nil)
	certificate := certServer.TLS.Certificates[0]
	certServer.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	for _, mechanism := range []string{"PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"} {
		t.Run(mechanism, func(t *testing.T) {
			cluster, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.EnableSASL(), kfake.Superuser(mechanism, "user", "pass"), kfake.TLS(&tls.Config{Certificates: []tls.Certificate{certificate}}), kfake.SeedTopics(1, "secure"))
			if err != nil {
				t.Fatal(err)
			}
			defer cluster.Close()
			previous := config.Load()
			t.Cleanup(func() { config.Set(previous) })
			raw, _ := json.Marshal(map[string]any{"kafka": map[string]any{"brokers": strings.Join(cluster.ListenAddrs(), ","), "security_protocol": "SASL_SSL", "sasl_mechanism": mechanism, "username": "user", "password": "pass", "tls": map[string]any{"ca_file": ca}}})
			cfg, err := config.Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			config.Set(cfg)
			if topics := kafkaCall(t, Input{Operation: "list_topics"})["topics"].([]any); len(topics) != 1 || topics[0] != "secure" {
				t.Fatalf("secure metadata: %#v", topics)
			}
			cfg.Kafka.Password = "wrong"
			config.Set(cfg)
			res, _, err := handle(context.Background(), nil, Input{Operation: "list_topics", TimeoutMS: 500})
			if err != nil || !res.IsError {
				t.Fatalf("invalid credentials accepted: %+v %v", res, err)
			}
		})
	}
}
func TestFranzRejectsInvalidClientOptions(t *testing.T) {
	for _, options := range []map[string]any{{"security.protocol": "SSL"}, {"acks": 2}, {"compression": "invalid"}, {"sasl": map[string]any{"mechanism": "invalid"}}, {"tls": map[string]any{"cert_file": "missing"}}} {
		if _, _, err := buildConfig(config.Defaults().Kafka, options, 1000); err == nil {
			t.Fatalf("accepted invalid options: %#v", options)
		}
	}
}
