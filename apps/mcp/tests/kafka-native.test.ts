import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Kafka from "node-rdkafka";
import { describe, expect, it } from "vitest";

import { kafkaModule } from "@/tools/kafka/tool.js";

async function withTool(run: (client: Client) => Promise<void>) {
  const server = new McpServer({ name: "test", version: "1" });
  kafkaModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("Kafka with librdkafka's mock broker", () => {
  it("surfaces delivery rejection after a successful flush", async () => {
    await withTool(async (client) => {
      const result = await client.callTool({
        name: "kafka_tool",
        arguments: {
          operation: "produce",
          topic: "events",
          messages: [{ value: "x", partition: 999 }],
          config: { "test.mock.num.brokers": 1, "message.timeout.ms": 300 },
          timeout_ms: 2000,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("unknown partition");
    });
  });

  it("reads explicit assignments without a user-supplied group", async () => {
    const mockConfig: Kafka.ProducerGlobalConfig & {
      "test.mock.num.brokers": number;
    } = { "test.mock.num.brokers": 1 };
    const producer = new Kafka.Producer(mockConfig, {});
    try {
      const metadata = await new Promise<Kafka.Metadata>((resolve, reject) =>
        producer.connect({}, (err, data) =>
          err ? reject(err) : resolve(data),
        ),
      );
      producer.produce("events", 0, Buffer.from("first"));
      producer.produce("events", 0, Buffer.from("second"));
      await new Promise<void>((resolve, reject) =>
        producer.flush(2000, (err) => (err ? reject(err) : resolve())),
      );
      const brokers = metadata.brokers
        .map((broker) => `${broker.host}:${broker.port}`)
        .join(",");
      await withTool(async (client) => {
        const result = await client.callTool({
          name: "kafka_tool",
          arguments: {
            operation: "consume",
            brokers,
            config: { "auto.commit.interval.ms": 0 },
            assignments: [{ topic: "events", partition: 0, offset: 0 }],
            max_messages: 1,
            timeout_ms: 2000,
          },
        });
        expect(result.isError).toBeUndefined();
        expect(
          (
            (result.structuredContent as Record<string, unknown>)?.["data"] as {
              messages: Array<{ value: string }>;
            }
          ).messages.map((message) => message.value),
        ).toEqual(["first"]);
      });
    } finally {
      await new Promise<void>((resolve) =>
        producer.disconnect(() => resolve()),
      );
    }
  }, 10_000);
});
