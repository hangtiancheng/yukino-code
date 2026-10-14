import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { kafkaModule } from "@/tools/kafka/tool.js";
import { firstText, isolateEnv } from "./helpers.js";

const state = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  sent: [] as Record<string, unknown>[],
  consumed: [] as Record<string, unknown>[],
  commits: [] as Record<string, unknown>[],
  adminCalls: [] as Record<string, unknown>[],
  closed: 0,
  error: null as Error | null,
  streamError: null as Error | null,
  metadata: {
    id: "cluster",
    controllerId: 1,
    brokers: new Map([[1, { host: "localhost", port: 9092 }]]),
    topics: new Map<
      string,
      {
        id: string;
        partitions: Array<{
          leader: number;
          leaderEpoch: number;
          replicas: number[];
          isr: number[];
        }>;
      }
    >(),
  },
  offsets: [] as Array<{ partitionIndex: number; committedOffset: bigint }>,
}));
vi.mock("@platformatic/kafka", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@platformatic/kafka")>();
  const { Readable } = await import("node:stream");
  class Base {
    constructor(options: Record<string, unknown>) {
      state.options.push(options);
    }
    async close() {
      state.closed++;
    }
    async metadata() {
      if (state.error) throw state.error;
      return state.metadata;
    }
  }
  class Producer extends Base {
    override async metadata() {
      if (state.error) throw state.error;
      return {
        ...state.metadata,
        topics: new Map([
          [
            "events",
            {
              id: "events",
              partitions: Array.from({ length: 3 }, () => ({
                leader: 1,
                leaderEpoch: 0,
                replicas: [1],
                isr: [1],
              })),
            },
          ],
        ]),
      };
    }
    async send(options: { messages: Record<string, unknown>[] }) {
      state.sent.push(...options.messages);
      if (state.error) throw state.error;
      return {};
    }
  }
  class Consumer extends Base {
    async consume(options: Record<string, unknown>) {
      state.adminCalls.push({ op: "consume", ...options });
      if (state.error) throw state.error;
      const records = state.consumed.slice();
      return new Readable({
        objectMode: true,
        highWaterMark: 1,
        read() {
          if (state.streamError) {
            this.destroy(state.streamError);
            return;
          }
          if (records.length) this.push(records.shift());
        },
      });
    }
    async commit(options: Record<string, unknown>) {
      state.commits.push(options);
    }
  }
  class Admin extends Base {
    async listTopics() {
      if (state.error) throw state.error;
      return [...state.metadata.topics.keys()];
    }
    async createTopics(options: Record<string, unknown>) {
      state.adminCalls.push({ op: "createTopics", ...options });
      if (state.error) throw state.error;
    }
    async deleteTopics(options: Record<string, unknown>) {
      state.adminCalls.push({ op: "deleteTopics", ...options });
    }
    async createPartitions(options: Record<string, unknown>) {
      state.adminCalls.push({ op: "createPartitions", ...options });
    }
    async listOffsets(options: {
      topics: Array<{
        name: string;
        partitions: Array<{ partitionIndex: number; timestamp: bigint }>;
      }>;
    }) {
      return options.topics.map((t) => ({
        name: t.name,
        partitions: t.partitions.map((p) => ({
          partitionIndex: p.partitionIndex,
          offset: p.timestamp === -2n ? 5n : 50n,
        })),
      }));
    }
    async listConsumerGroupOffsets(options: {
      groups: Array<{ groupId: string }>;
    }) {
      return [
        {
          groupId: options.groups[0].groupId,
          topics: [{ name: "events", partitions: state.offsets }],
        },
      ];
    }
  }
  return { ...actual, Producer, Consumer, Admin };
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
let client: Client;
let server: McpServer;
const resultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
async function call(args: Record<string, unknown>) {
  return resultSchema.parse(
    await client.callTool({ name: "kafka_tool", arguments: args }),
  );
}
function data(result: Awaited<ReturnType<typeof call>>) {
  return result.structuredContent?.["data"] as Record<string, unknown>;
}
beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  state.options = [];
  state.sent = [];
  state.consumed = [];
  state.commits = [];
  state.adminCalls = [];
  state.closed = 0;
  state.error = null;
  state.streamError = null;
  state.offsets = [];
  state.metadata.topics.clear();
  server = new McpServer({ name: "test", version: "1" });
  kafkaModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});
afterEach(async () => {
  await Promise.all([client.close(), server.close()]);
});
describe("kafka_tool", () => {
  it("produces binary values, tombstones, headers and timestamps", async () => {
    const result = await call({
      operation: "produce",
      topic: "events",
      encoding: "base64",
      messages: [
        {
          key: "aw==",
          value: "AP8=",
          partition: 2,
          timestamp: 1700000000000,
          headers: { trace: "test" },
        },
        { value: null },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(data(result)).toEqual({ produced: 2 });
    expect(state.sent[0]).toMatchObject({
      topic: "events",
      partition: 2,
      timestamp: 1700000000000n,
      key: Buffer.from("k"),
      value: Buffer.from([0, 255]),
    });
    expect(state.sent[0]["headers"]).toEqual(
      new Map([[Buffer.from("trace"), Buffer.from("test")]]),
    );
    expect(state.sent[1]["value"]).toBeNull();
    expect(state.options[0]).toMatchObject({
      clientId: "yukino-mcp",
      bootstrapBrokers: ["localhost:9092"],
    });
    expect(state.closed).toBe(1);
  });
  it("reports send rejection and closes the producer", async () => {
    state.error = new Error("unknown partition");
    const result = await call({
      operation: "produce",
      topic: "events",
      messages: [{ value: "x" }],
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("unknown partition");
    expect(state.closed).toBe(1);
  });
  it("uses nested client options and rejects legacy keys", async () => {
    await call({
      operation: "produce",
      topic: "events",
      messages: [{ value: "x" }],
      config: {
        acks: -1,
        compression: "gzip",
        sasl: { mechanism: "PLAIN", username: "user", password: "pass" },
        tls: {},
      },
    });
    expect(state.options[0]).toMatchObject({
      acks: -1,
      compression: "gzip",
      sasl: { mechanism: "PLAIN", username: "user", password: "pass" },
      tls: {},
    });
    const result = await call({
      operation: "list_topics",
      config: { "security.protocol": "SSL" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("legacy Kafka config");
  });
  it("commits only returned records after a bounded consume", async () => {
    state.consumed = [0, 1, 2].map((offset) => ({
      topic: "events",
      partition: 0,
      offset: BigInt(offset),
      timestamp: 1700000000000n,
      leaderEpoch: 1,
      key: Buffer.from("k"),
      value: Buffer.from("hello"),
      headerEntries: [[Buffer.from("h"), Buffer.from("x")]],
    }));
    const result = await call({
      operation: "consume",
      topics: ["events"],
      group_id: "g1",
      from_beginning: true,
      auto_commit: true,
      max_messages: 1,
    });
    expect(result.isError).toBeUndefined();
    expect(data(result)["count"]).toBe(1);
    expect(
      (data(result)["messages"] as Record<string, unknown>[])[0],
    ).toMatchObject({
      offset: 0,
      timestamp: 1700000000000,
      size: 5,
      value: "hello",
      headers: [{ h: { type: "Buffer", data: [120] } }],
    });
    expect(state.options[0]).toMatchObject({
      groupId: "g1",
      autocommit: false,
    });
    expect(state.adminCalls[0]).toMatchObject({
      mode: "committed",
      fallbackMode: "earliest",
    });
    expect(state.commits).toEqual([
      {
        offsets: [
          { topic: "events", partition: 0, offset: 1n, leaderEpoch: 1 },
        ],
      },
    ]);
    expect(state.closed).toBe(1);
  });
  it("does not commit when auto_commit is disabled and retains null payloads", async () => {
    state.consumed = [
      {
        topic: "events",
        partition: 0,
        offset: 2n,
        timestamp: 1n,
        leaderEpoch: 0,
        headerEntries: [],
      },
    ];
    const result = await call({
      operation: "consume",
      topics: ["events"],
      max_messages: 1,
      config: { groupId: "configured" },
    });
    expect(data(result)).toMatchObject({
      count: 1,
      group_id: "configured",
      messages: [{ key: null, value: null }],
    });
    expect(state.commits).toEqual([]);
  });
  it("bounds empty reads and reports stream errors", async () => {
    const result = await call({
      operation: "consume",
      topics: ["events"],
      timeout_ms: 10,
    });
    expect(data(result)["count"]).toBe(0);
    state.streamError = new Error("Topic authorization failed");
    const failed = await call({ operation: "consume", topics: ["events"] });
    expect(failed.isError).toBe(true);
    expect(firstText(failed)).toContain("Topic authorization failed");
    expect(state.closed).toBe(2);
  });
  it("lists and describes topics and the cluster", async () => {
    const part = { leader: 1, leaderEpoch: 0, replicas: [1], isr: [1] };
    state.metadata.topics.set("b", { id: "b", partitions: [part] });
    state.metadata.topics.set("a", { id: "a", partitions: [part] });
    expect(data(await call({ operation: "list_topics" }))).toEqual({
      topics: ["a", "b"],
    });
    expect(data(await call({ operation: "describe_topics" }))).toMatchObject({
      topics: [
        { name: "a", partitions: [{ id: 0, leader: 1, isrs: [1] }] },
        { name: "b" },
      ],
    });
    expect(data(await call({ operation: "describe_cluster" }))).toEqual({
      brokers: [{ id: 1, host: "localhost", port: 9092 }],
      controller_id: 1,
      cluster_id: "cluster",
    });
  });
  it("creates, deletes and grows topics with the new admin API", async () => {
    expect(
      (
        await call({
          operation: "create_topic",
          topic: "new",
          num_partitions: 3,
          replication_factor: 1,
          topic_config: { "retention.ms": "86400000" },
        })
      ).isError,
    ).toBeUndefined();
    expect(state.adminCalls[0]).toEqual({
      op: "createTopics",
      topics: ["new"],
      partitions: 3,
      replicas: 1,
      configs: [{ name: "retention.ms", value: "86400000" }],
    });
    await call({
      operation: "create_partitions",
      topic: "new",
      num_partitions: 4,
    });
    expect(state.adminCalls[1]).toMatchObject({
      op: "createPartitions",
      topics: [{ name: "new", count: 4 }],
    });
    await call({ operation: "delete_topic", topic: "new" });
    expect(state.adminCalls[2]).toEqual({
      op: "deleteTopics",
      topics: ["new"],
    });
    expect(state.closed).toBe(3);
  });
  it("normalizes watermarks and committed/uncommitted offsets", async () => {
    state.metadata.topics.set("events", {
      id: "events",
      partitions: [{ leader: 1, leaderEpoch: 0, replicas: [1], isr: [1] }],
    });
    expect(
      data(await call({ operation: "watermark_offsets", topic: "events" })),
    ).toEqual({
      topic: "events",
      partitions: [{ partition: 0, low: 5, high: 50 }],
    });
    state.offsets = [
      { partitionIndex: 0, committedOffset: 42n },
      { partitionIndex: 1, committedOffset: -1n },
    ];
    expect(
      data(
        await call({
          operation: "committed_offsets",
          group_id: "g1",
          topic: "events",
          partitions: [{ partition: 0 }, { partition: 1 }],
        }),
      ),
    ).toEqual({
      group_id: "g1",
      offsets: [
        { topic: "events", partition: 0, offset: 42 },
        { topic: "events", partition: 1, offset: -1001 },
      ],
    });
  });
  it("preserves large Kafka offsets as decimal strings", async () => {
    state.offsets = [{ partitionIndex: 0, committedOffset: 9007199254740993n }];
    expect(
      data(
        await call({
          operation: "committed_offsets",
          group_id: "g1",
          topic: "events",
          partitions: [{ partition: 0 }],
        }),
      )["offsets"],
    ).toEqual([{ topic: "events", partition: 0, offset: "9007199254740993" }]);
  });
  it("closes admin clients on connection failures", async () => {
    state.error = new Error("cannot connect");
    expect((await call({ operation: "list_topics" })).isError).toBe(true);
    expect(state.closed).toBe(1);
  });
  it("validates required fields", async () => {
    for (const args of [
      { operation: "produce", messages: [{ value: "x" }] },
      { operation: "consume" },
      { operation: "committed_offsets", group_id: "g1" },
      { operation: "create_partitions", topic: "events" },
    ])
      expect((await call(args)).isError).toBe(true);
  });
  it("maps environment security settings to TLS and SASL", async () => {
    Object.assign(process.env, {
      KAFKA_BROKERS: "one:9093, two:9093",
      KAFKA_SECURITY_PROTOCOL: "SASL_SSL",
      KAFKA_SASL_MECHANISM: "SCRAM-SHA-512",
      KAFKA_USERNAME: "user",
      KAFKA_PASSWORD: "pass",
    });
    await call({ operation: "list_topics" });
    expect(state.options[0]).toMatchObject({
      bootstrapBrokers: ["one:9093", "two:9093"],
      tls: {},
      tlsServerName: true,
      sasl: { mechanism: "SCRAM-SHA-512", username: "user", password: "pass" },
    });
  });
});
