import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { kafkaModule } from "@/tools/kafka/tool.js";
import { firstText, isolateEnv } from "./helpers.js";

const state = vi.hoisted(() => ({
  metadata: {
    topics: [] as Array<{ name: string; partitions: Array<{ id: number }> }>,
    brokers: [] as Array<{ id: number; host: string; port: number }>,
    orig_broker_id: 1,
    orig_broker_name: "localhost:9092/1",
  },
  watermarks: { lowOffset: 0, highOffset: 0 },
  consumed: [] as Array<Record<string, unknown>>,
  committed: [] as Array<Record<string, unknown>>,
  produced: [] as Array<Record<string, unknown>>,
  adminCalls: [] as Array<Record<string, unknown>>,
  producerConf: null as Record<string, unknown> | null,
  consumerConf: null as Record<string, unknown> | null,
  producerTopicConf: null as Record<string, unknown> | null,
  consumerTopicConf: null as Record<string, unknown> | null,
  connectError: null as unknown,
}));

vi.mock("node-rdkafka", () => {
  class MockProducer {
    constructor(
      conf: Record<string, unknown>,
      topicConf?: Record<string, unknown>,
    ) {
      state.producerConf = conf;
      state.producerTopicConf = topicConf ?? null;
    }
    connect(_opts: unknown, cb: (e: unknown, d: unknown) => void): void {
      cb(state.connectError, state.metadata);
    }
    produce(
      topic: string,
      partition: number | null,
      value: unknown,
      key: unknown,
      timestamp: number | null,
      _opaque: unknown,
      headers: unknown,
    ): void {
      state.produced.push({ topic, partition, value, key, timestamp, headers });
    }
    flush(_timeout: number, cb: (e: unknown) => void): void {
      cb(null);
    }
    disconnect(cb?: (e: unknown, d: unknown) => void): void {
      if (cb) cb(null, {});
    }
    getMetadata(_opts: unknown, cb: (e: unknown, d: unknown) => void): void {
      cb(null, state.metadata);
    }
    queryWatermarkOffsets(
      _topic: string,
      _partition: number,
      _timeout: number,
      cb: (e: unknown, d: unknown) => void,
    ): void {
      cb(null, state.watermarks);
    }
  }

  class MockConsumer {
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    subscribed: unknown;
    assigned: unknown;
    constructor(
      conf: Record<string, unknown>,
      topicConf?: Record<string, unknown>,
    ) {
      state.consumerConf = conf;
      state.consumerTopicConf = topicConf ?? null;
    }
    connect(_opts: unknown, cb: (e: unknown, d: unknown) => void): void {
      cb(state.connectError, state.metadata);
    }
    subscribe(topics: unknown): void {
      this.subscribed = topics;
    }
    assign(assignments: unknown): void {
      this.assigned = assignments;
    }
    on(event: string, handler: (...args: unknown[]) => void): this {
      (this.handlers[event] ??= []).push(handler);
      return this;
    }
    removeListener(event: string, handler: (...args: unknown[]) => void): this {
      const arr = this.handlers[event] ?? [];
      const index = arr.indexOf(handler);
      if (index >= 0) arr.splice(index, 1);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of (this.handlers[event] ?? []).slice())
        handler(...args);
    }
    consume(): void {
      for (const message of state.consumed) this.emit("data", message);
    }
    committed(
      _toppars: unknown,
      _timeout: number,
      cb: (e: unknown, d: unknown) => void,
    ): void {
      cb(null, state.committed);
    }
    disconnect(cb?: (e: unknown, d: unknown) => void): void {
      if (cb) cb(null, {});
    }
  }

  const AdminClient = {
    create(_conf: Record<string, unknown>) {
      return {
        createTopic(topic: unknown, cb: (e: unknown) => void): void {
          state.adminCalls.push({ op: "createTopic", topic });
          cb(null);
        },
        deleteTopic(topic: unknown, cb: (e: unknown) => void): void {
          state.adminCalls.push({ op: "deleteTopic", topic });
          cb(null);
        },
        createPartitions(
          topic: unknown,
          count: unknown,
          cb: (e: unknown) => void,
        ): void {
          state.adminCalls.push({ op: "createPartitions", topic, count });
          cb(null);
        },
        disconnect(): void {
          state.adminCalls.push({ op: "disconnect" });
        },
      };
    },
  };

  return {
    default: {
      Producer: MockProducer,
      KafkaConsumer: MockConsumer,
      AdminClient,
    },
  };
});

const envKeys = [
  "KAFKA_BROKERS",
  "KAFKA_CLIENT_ID",
  "KAFKA_USERNAME",
  "KAFKA_PASSWORD",
  "KAFKA_SASL_MECHANISM",
  "KAFKA_SECURITY_PROTOCOL",
];
isolateEnv(envKeys);

const resultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

let client: Client;
async function call(args: Record<string, unknown>) {
  return resultSchema.parse(
    await client.callTool({ name: "kafka_tool", arguments: args }),
  );
}

beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  state.metadata = {
    topics: [],
    brokers: [],
    orig_broker_id: 1,
    orig_broker_name: "localhost:9092/1",
  };
  state.watermarks = { lowOffset: 0, highOffset: 0 };
  state.consumed = [];
  state.committed = [];
  state.produced = [];
  state.adminCalls = [];
  state.producerConf = null;
  state.consumerConf = null;
  state.producerTopicConf = null;
  state.consumerTopicConf = null;
  state.connectError = null;
  const server = new McpServer({ name: "test", version: "1" });
  kafkaModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterEach(async () => {
  await client.close();
});

describe("kafka_tool", () => {
  it("produces messages and flushes", async () => {
    const result = await call({
      operation: "produce",
      topic: "events",
      messages: [
        { key: "k1", value: "v1" },
        { value: "v2", partition: 2, headers: { h: "x" } },
      ],
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc["data"] as { produced: number }).produced).toBe(2);
    expect(state.produced).toHaveLength(2);
    expect(state.produced[0]["topic"]).toBe("events");
    expect((state.produced[0]["value"] as Buffer).toString()).toBe("v1");
    expect((state.produced[0]["key"] as Buffer).toString()).toBe("k1");
    expect(state.produced[1]["partition"]).toBe(2);
    expect(state.produced[1]["headers"]).toEqual([{ h: "x" }]);
    // Default brokers/client id are applied.
    expect(state.producerConf?.["metadata.broker.list"]).toBe("localhost:9092");
    expect(state.producerConf?.["client.id"]).toBe("yukino-mcp");
  });

  it("produces base64-encoded binary values", async () => {
    const bytes = Buffer.from([0, 1, 2, 3]);
    await call({
      operation: "produce",
      topic: "bin",
      encoding: "base64",
      messages: [{ value: bytes.toString("base64") }],
    });
    expect((state.produced[0]["value"] as Buffer).equals(bytes)).toBe(true);
  });

  it("mirrors topic-level config entries into the topic conf", async () => {
    await call({
      operation: "produce",
      topic: "events",
      messages: [{ value: "v" }],
      config: { acks: "all", "message.timeout.ms": 1000 },
    });
    expect(state.producerConf?.["acks"]).toBe("all");
    expect(state.producerTopicConf?.["acks"]).toBe("all");
    expect(state.producerTopicConf?.["message.timeout.ms"]).toBe(1000);
  });

  it("consumes by subscription and normalizes messages", async () => {
    state.consumed = [
      {
        topic: "events",
        partition: 0,
        offset: 10,
        timestamp: 1700000000000,
        size: 5,
        key: Buffer.from("k"),
        value: Buffer.from("hello"),
        headers: [],
      },
      {
        topic: "events",
        partition: 1,
        offset: 11,
        size: 0,
        key: null,
        value: null,
      },
    ];
    const result = await call({
      operation: "consume",
      topics: ["events"],
      group_id: "g1",
      max_messages: 2,
      from_beginning: true,
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as Record<string, unknown>;
    const data = sc["data"] as {
      count: number;
      group_id: string;
      messages: Array<Record<string, unknown>>;
    };
    expect(data.count).toBe(2);
    expect(data.group_id).toBe("g1");
    expect(data.messages[0]["value"]).toBe("hello");
    expect(data.messages[0]["key"]).toBe("k");
    expect(data.messages[1]["value"]).toBeNull();
    expect(state.consumerConf?.["group.id"]).toBe("g1");
    expect(state.consumerConf?.["auto.offset.reset"]).toBe("earliest");
    // Topic-level properties must also land in the topic conf: node-rdkafka
    // replaces the default topic config with the second constructor argument,
    // so global-only values such as auto.offset.reset would be ignored.
    expect(state.consumerTopicConf?.["auto.offset.reset"]).toBe("earliest");
    expect(state.consumerTopicConf?.["enable.auto.commit"]).toBe(false);
  });

  it("consumes by explicit assignment without a group", async () => {
    state.consumed = [
      {
        topic: "events",
        partition: 3,
        offset: 100,
        size: 1,
        value: Buffer.from("x"),
      },
    ];
    const result = await call({
      operation: "consume",
      assignments: [{ topic: "events", partition: 3, offset: 100 }],
      max_messages: 1,
    });
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc["data"] as { count: number }).count).toBe(1);
    expect(state.consumerConf?.["group.id"]).toBeUndefined();
  });

  it("lists topics from metadata", async () => {
    state.metadata.topics = [
      { name: "b", partitions: [{ id: 0 }] },
      { name: "a", partitions: [{ id: 0 }] },
    ];
    const result = await call({ operation: "list_topics" });
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc["data"] as { topics: string[] }).topics).toEqual(["a", "b"]);
  });

  it("describes the cluster brokers", async () => {
    state.metadata.brokers = [{ id: 1, host: "localhost", port: 9092 }];
    const result = await call({ operation: "describe_cluster" });
    const sc = result.structuredContent as Record<string, unknown>;
    const data = sc["data"] as { brokers: unknown[]; orig_broker_name: string };
    expect(data.brokers).toHaveLength(1);
    expect(data.orig_broker_name).toBe("localhost:9092/1");
  });

  it("creates a topic through the admin client", async () => {
    const result = await call({
      operation: "create_topic",
      topic: "new-topic",
      num_partitions: 3,
      replication_factor: 1,
      topic_config: { "retention.ms": "86400000" },
    });
    expect(result.isError).toBeUndefined();
    expect(state.adminCalls[0]["op"]).toBe("createTopic");
    expect(
      (state.adminCalls[0]["topic"] as Record<string, unknown>)[
        "num_partitions"
      ],
    ).toBe(3);
    expect(state.adminCalls.some((c) => c["op"] === "disconnect")).toBe(true);
  });

  it("reads watermark offsets across discovered partitions", async () => {
    state.metadata.topics = [
      { name: "events", partitions: [{ id: 0 }, { id: 1 }] },
    ];
    state.watermarks = { lowOffset: 5, highOffset: 50 };
    const result = await call({
      operation: "watermark_offsets",
      topic: "events",
    });
    const sc = result.structuredContent as Record<string, unknown>;
    const data = sc["data"] as { partitions: Array<Record<string, unknown>> };
    expect(data.partitions).toEqual([
      { partition: 0, low: 5, high: 50 },
      { partition: 1, low: 5, high: 50 },
    ]);
  });

  it("reads committed offsets for a group", async () => {
    state.committed = [{ topic: "events", partition: 0, offset: 42 }];
    const result = await call({
      operation: "committed_offsets",
      group_id: "g1",
      partitions: [{ topic: "events", partition: 0 }],
    });
    const sc = result.structuredContent as Record<string, unknown>;
    const data = sc["data"] as { group_id: string; offsets: unknown[] };
    expect(data.group_id).toBe("g1");
    expect(data.offsets).toEqual([
      { topic: "events", partition: 0, offset: 42 },
    ]);
  });

  it("validates required fields per operation", async () => {
    const noTopic = await call({
      operation: "produce",
      messages: [{ value: "x" }],
    });
    expect(noTopic.isError).toBe(true);
    expect(firstText(noTopic)).toContain("topic");

    const noSource = await call({ operation: "consume" });
    expect(noSource.isError).toBe(true);
    expect(firstText(noSource)).toContain("topics or assignments");
  });

  it("propagates SASL configuration from the environment", async () => {
    process.env["KAFKA_BROKERS"] = "broker:9093";
    process.env["KAFKA_SECURITY_PROTOCOL"] = "SASL_SSL";
    process.env["KAFKA_SASL_MECHANISM"] = "SCRAM-SHA-512";
    process.env["KAFKA_USERNAME"] = "user";
    process.env["KAFKA_PASSWORD"] = "pass";
    await call({ operation: "list_topics" });
    expect(state.producerConf?.["metadata.broker.list"]).toBe("broker:9093");
    expect(state.producerConf?.["security.protocol"]).toBe("SASL_SSL");
    expect(state.producerConf?.["sasl.mechanisms"]).toBe("SCRAM-SHA-512");
    expect(state.producerConf?.["sasl.username"]).toBe("user");
    expect(state.producerConf?.["sasl.password"]).toBe("pass");
  });
});
