import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { kafkaModule } from "@/tools/kafka/tool.js";

// Use a disposable Kafka-compatible cluster: this test creates and deletes a topic.
const brokers = process.env["KAFKA_TEST_BROKERS"];
describe.skipIf(!brokers)("Kafka wire integration", () => {
  it("exercises admin operations, binary/tombstone records and bounded offset commits", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    kafkaModule.register(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(a), server.connect(b)]);
    const topic = `mcp-${randomUUID()}`;
    const group = `group-${randomUUID()}`;
    async function call(args: Record<string, unknown>) {
      const result = await client.callTool({
        name: "kafka_tool",
        arguments: { brokers, timeout_ms: 3000, ...args },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
      return z
        .object({
          structuredContent: z.object({
            data: z.record(z.string(), z.unknown()),
          }),
        })
        .parse(result).structuredContent.data;
    }
    try {
      await call({ operation: "create_topic", topic, num_partitions: 2 });
      expect((await call({ operation: "list_topics" }))["topics"]).toContain(
        topic,
      );
      expect(
        (await call({ operation: "describe_topics", topic }))["topics"],
      ).toMatchObject([{ name: topic, partitions: [{ id: 0 }, { id: 1 }] }]);
      expect(
        (await call({ operation: "describe_cluster" }))["brokers"],
      ).not.toHaveLength(0);
      await call({ operation: "create_partitions", topic, num_partitions: 3 });
      await call({
        operation: "produce",
        topic,
        encoding: "base64",
        messages: [
          {
            partition: 1,
            key: "aw==",
            value: "AP8=",
            headers: { trace: "test" },
          },
          { partition: 1, value: null },
        ],
      });
      const consume = {
        operation: "consume",
        group_id: group,
        max_messages: 1,
        auto_commit: true,
        from_beginning: true,
        encoding: "base64",
        assignments: [
          { topic, partition: 0, offset: 0 },
          { topic, partition: 1, offset: 0 },
        ],
      };
      const first = await call(consume);
      expect(first).toMatchObject({
        count: 1,
        messages: [
          {
            partition: 1,
            offset: 0,
            key: "aw==",
            value: "AP8=",
            headers: [
              { trace: { type: "Buffer", data: [116, 101, 115, 116] } },
            ],
          },
        ],
      });
      expect(
        await call({
          operation: "committed_offsets",
          group_id: group,
          topic,
          partitions: [{ partition: 0 }, { partition: 1 }],
        }),
      ).toMatchObject({ offsets: [{ offset: -1001 }, { offset: 1 }] });
      expect(
        await call({ ...consume, assignments: [{ topic, partition: 1 }] }),
      ).toMatchObject({ count: 1, messages: [{ offset: 1, value: null }] });
      expect(
        await call({
          operation: "watermark_offsets",
          topic,
          partitions: [{ partition: 1 }],
        }),
      ).toEqual({ topic, partitions: [{ partition: 1, low: 0, high: 2 }] });
      const start = Date.now();
      expect(
        await call({
          operation: "consume",
          timeout_ms: 150,
          assignments: [
            { topic, partition: 0, offset: 0 },
            { topic, partition: 2, offset: 0 },
          ],
        }),
      ).toMatchObject({ count: 0 });
      expect(Date.now() - start).toBeLessThan(2000);
      // Subscription resumes its own group and commits only the returned prefix.
      const subscribed = await call({
        operation: "consume",
        topics: [topic],
        group_id: `${group}-sub`,
        from_beginning: true,
        max_messages: 1,
        auto_commit: true,
      });
      expect(subscribed).toMatchObject({ count: 1 });
      expect(
        await call({
          operation: "committed_offsets",
          group_id: `${group}-sub`,
          topic,
          partitions: [{ partition: 1 }],
        }),
      ).toMatchObject({ offsets: [{ offset: 1 }] });
      const rejected = await client.callTool({
        name: "kafka_tool",
        arguments: {
          brokers,
          operation: "produce",
          topic,
          messages: [{ partition: 99, value: "x" }],
          timeout_ms: 1000,
        },
      });
      expect(rejected.isError).toBe(true);
    } finally {
      await client.callTool({
        name: "kafka_tool",
        arguments: {
          brokers,
          operation: "delete_topic",
          topic,
          timeout_ms: 3000,
        },
      });
      await Promise.all([client.close(), server.close()]);
    }
  }, 30000);
});
