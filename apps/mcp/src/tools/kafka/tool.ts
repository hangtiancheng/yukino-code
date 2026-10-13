import Kafka from "node-rdkafka";
import type {
  ConsumerGlobalConfig,
  GlobalConfig,
  IAdminClient,
  LibrdKafkaError,
  Message,
  MessageHeader,
  Metadata,
  MetadataOptions,
  ProducerGlobalConfig,
  TopicPartitionOffset,
  WatermarkOffsets,
} from "node-rdkafka";
import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import {
  operationError,
  operationResult,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";

type Encoding = "utf8" | "base64";
type Connectable = Kafka.Producer | Kafka.KafkaConsumer;
type ConfigRecord = Record<string, string | number | boolean>;

function buildConfig(
  brokers: string,
  clientId: string,
  extra: ConfigRecord,
): GlobalConfig {
  const kafka = loadConfig().kafka;
  const conf: ConfigRecord = {
    "metadata.broker.list": brokers,
    "client.id": clientId,
  };
  if (kafka.securityProtocol)
    conf["security.protocol"] = kafka.securityProtocol;
  if (kafka.saslMechanism) conf["sasl.mechanisms"] = kafka.saslMechanism;
  if (kafka.username) conf["sasl.username"] = kafka.username;
  if (kafka.password) conf["sasl.password"] = kafka.password;
  Object.assign(conf, extra);
  return conf as unknown as GlobalConfig;
}

function connectClient(client: Connectable): Promise<Metadata> {
  return new Promise((resolve, reject) => {
    client.connect({}, (err: LibrdKafkaError, data: Metadata) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function disconnectClient(client: Connectable): Promise<void> {
  return new Promise((resolve) => {
    try {
      client.disconnect(() => resolve());
    } catch {
      resolve();
    }
  });
}

function getMetadata(
  client: Connectable,
  options: MetadataOptions,
): Promise<Metadata> {
  return new Promise((resolve, reject) => {
    client.getMetadata(options, (err: LibrdKafkaError, data: Metadata) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function queryWatermarks(
  client: Connectable,
  topic: string,
  partition: number,
  timeout: number,
): Promise<WatermarkOffsets> {
  return new Promise((resolve, reject) => {
    client.queryWatermarkOffsets(
      topic,
      partition,
      timeout,
      (err: LibrdKafkaError, offsets: WatermarkOffsets) => {
        if (err) reject(err);
        else resolve(offsets);
      },
    );
  });
}

function flushProducer(
  producer: Kafka.Producer,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    producer.flush(timeout, (err: LibrdKafkaError) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function withClient<T>(
  conf: GlobalConfig,
  fn: (client: Kafka.Producer) => Promise<T>,
): Promise<T> {
  const client = new Kafka.Producer(conf as ProducerGlobalConfig, {});
  await connectClient(client);
  try {
    return await fn(client);
  } finally {
    await disconnectClient(client);
  }
}

function toBuffer(
  value: string | null | undefined,
  encoding: Encoding,
): Buffer | null {
  if (value === null || value === undefined) return null;
  return encoding === "base64"
    ? Buffer.from(value, "base64")
    : Buffer.from(value, "utf8");
}

function decodeBuffer(
  value: Buffer | string | null | undefined,
  encoding: Encoding,
): string | null {
  if (value === null || value === undefined) return null;
  const buf = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");
}

function toHeaders(headers: Record<string, string>): MessageHeader[] {
  return Object.entries(headers).map(([key, value]) => ({ [key]: value }));
}

function normalizeMessage(
  message: Message,
  encoding: Encoding,
): Record<string, unknown> {
  return {
    topic: message.topic,
    partition: message.partition,
    offset: message.offset,
    timestamp: message.timestamp,
    size: message.size,
    key: decodeBuffer(message.key, encoding),
    value: decodeBuffer(message.value, encoding),
    headers: message.headers ?? [],
  };
}

function requireString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`operation requires "${field}"`);
  return value;
}

interface OpInput {
  topic?: string;
  topics?: string[];
  messages?: Array<{
    key?: string | null;
    value: string | null;
    partition?: number;
    timestamp?: number;
    headers?: Record<string, string>;
  }>;
  assignments?: Array<{ topic: string; partition: number; offset?: number }>;
  partitions?: Array<{ topic?: string; partition: number; offset?: number }>;
  group_id?: string;
  from_beginning: boolean;
  auto_commit: boolean;
  max_messages: number;
  num_partitions?: number;
  replication_factor?: number;
  topic_config?: Record<string, string>;
  encoding: Encoding;
  timeout_ms: number;
}

async function opProduce(input: OpInput, conf: GlobalConfig): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  const messages = input.messages ?? [];
  if (messages.length === 0)
    throw new Error("produce requires at least one message");
  const producer = new Kafka.Producer(conf as ProducerGlobalConfig, {});
  await connectClient(producer);
  try {
    let produced = 0;
    for (const message of messages) {
      producer.produce(
        topic,
        message.partition ?? null,
        toBuffer(message.value, input.encoding),
        message.key === undefined
          ? null
          : toBuffer(message.key, input.encoding),
        message.timestamp ?? null,
        undefined,
        message.headers ? toHeaders(message.headers) : undefined,
      );
      produced += 1;
    }
    await flushProducer(producer, input.timeout_ms);
    return { produced };
  } finally {
    await disconnectClient(producer);
  }
}

function collectMessages(
  consumer: Kafka.KafkaConsumer,
  out: Record<string, unknown>[],
  max: number,
  timeoutMs: number,
  encoding: Encoding,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const onData = (message: Message): void => {
      out.push(normalizeMessage(message, encoding));
      if (out.length >= max) finish();
    };
    const onError = (): void => undefined;
    const timer = setTimeout(finish, timeoutMs);
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      consumer.removeListener("data", onData);
      consumer.removeListener("event.error", onError);
      resolve();
    }
    consumer.on("data", onData);
    consumer.on("event.error", onError);
    consumer.consume();
  });
}

async function opConsume(input: OpInput, conf: GlobalConfig): Promise<unknown> {
  const useAssign =
    Array.isArray(input.assignments) && input.assignments.length > 0;
  if (!useAssign && (!input.topics || input.topics.length === 0)) {
    throw new Error("consume requires topics or assignments");
  }
  const groupId =
    input.group_id ??
    (useAssign
      ? undefined
      : `yukino-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const consumerConf: ConfigRecord = {
    ...(conf as unknown as ConfigRecord),
    "enable.auto.commit": input.auto_commit,
    "auto.offset.reset": input.from_beginning ? "earliest" : "latest",
  };
  if (groupId) consumerConf["group.id"] = groupId;
  const consumer = new Kafka.KafkaConsumer(
    consumerConf as unknown as ConsumerGlobalConfig,
    {},
  );
  await connectClient(consumer);
  const collected: Record<string, unknown>[] = [];
  try {
    if (useAssign) {
      consumer.assign(
        (input.assignments ?? []).map((a) => ({
          topic: a.topic,
          partition: a.partition,
          ...(a.offset !== undefined ? { offset: a.offset } : {}),
        })),
      );
    } else {
      consumer.subscribe(input.topics ?? []);
    }
    await collectMessages(
      consumer,
      collected,
      input.max_messages,
      input.timeout_ms,
      input.encoding,
    );
    return {
      count: collected.length,
      group_id: groupId ?? null,
      messages: collected.slice(0, input.max_messages),
    };
  } finally {
    await disconnectClient(consumer);
  }
}

async function opListTopics(
  input: OpInput,
  conf: GlobalConfig,
): Promise<unknown> {
  return withClient(conf, async (client) => {
    const metadata = await getMetadata(client, {
      allTopics: true,
      timeout: input.timeout_ms,
    });
    return { topics: metadata.topics.map((t) => t.name).sort() };
  });
}

async function opDescribeTopics(
  input: OpInput,
  conf: GlobalConfig,
): Promise<unknown> {
  return withClient(conf, async (client) => {
    const options: MetadataOptions = input.topic
      ? { topic: input.topic, timeout: input.timeout_ms }
      : { allTopics: true, timeout: input.timeout_ms };
    const metadata = await getMetadata(client, options);
    return { topics: metadata.topics };
  });
}

async function opDescribeCluster(
  input: OpInput,
  conf: GlobalConfig,
): Promise<unknown> {
  return withClient(conf, async (client) => {
    const metadata = await getMetadata(client, {
      allTopics: false,
      timeout: input.timeout_ms,
    });
    return {
      brokers: metadata.brokers,
      orig_broker_id: metadata.orig_broker_id,
      orig_broker_name: metadata.orig_broker_name,
    };
  });
}

async function withAdmin<T>(
  conf: GlobalConfig,
  fn: (admin: IAdminClient) => Promise<T>,
): Promise<T> {
  const admin = Kafka.AdminClient.create(conf);
  try {
    return await fn(admin);
  } finally {
    admin.disconnect();
  }
}

async function opCreateTopic(
  input: OpInput,
  conf: GlobalConfig,
): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  return withAdmin(conf, (admin) => {
    return new Promise((resolve, reject) => {
      admin.createTopic(
        {
          topic,
          num_partitions: input.num_partitions ?? 1,
          replication_factor: input.replication_factor ?? 1,
          ...(input.topic_config ? { config: input.topic_config } : {}),
        },
        (err: LibrdKafkaError) => {
          if (err) reject(err);
          else resolve({ created: topic });
        },
      );
    });
  });
}

async function opDeleteTopic(
  input: OpInput,
  conf: GlobalConfig,
): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  return withAdmin(conf, (admin) => {
    return new Promise((resolve, reject) => {
      admin.deleteTopic(topic, (err: LibrdKafkaError) => {
        if (err) reject(err);
        else resolve({ deleted: topic });
      });
    });
  });
}

async function opCreatePartitions(
  input: OpInput,
  conf: GlobalConfig,
): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  if (!input.num_partitions)
    throw new Error('create_partitions requires "num_partitions"');
  return withAdmin(conf, (admin) => {
    return new Promise((resolve, reject) => {
      admin.createPartitions(
        topic,
        input.num_partitions as number,
        (err: LibrdKafkaError) => {
          if (err) reject(err);
          else resolve({ topic, partitions: input.num_partitions });
        },
      );
    });
  });
}

async function opWatermarkOffsets(
  input: OpInput,
  conf: GlobalConfig,
): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  return withClient(conf, async (client) => {
    let partitions = input.partitions?.map((p) => p.partition);
    if (!partitions || partitions.length === 0) {
      const metadata = await getMetadata(client, {
        topic,
        timeout: input.timeout_ms,
      });
      const found = metadata.topics.find((t) => t.name === topic);
      partitions = found ? found.partitions.map((p) => p.id) : [];
    }
    const out: Array<Record<string, unknown>> = [];
    for (const partition of partitions) {
      const wm = await queryWatermarks(
        client,
        topic,
        partition,
        input.timeout_ms,
      );
      out.push({ partition, low: wm.lowOffset, high: wm.highOffset });
    }
    return { topic, partitions: out };
  });
}

async function opCommittedOffsets(
  input: OpInput,
  conf: GlobalConfig,
): Promise<unknown> {
  const groupId = requireString(input.group_id, "group_id");
  const toppars: TopicPartitionOffset[] = (input.partitions ?? []).map((p) => ({
    topic: p.topic ?? input.topic ?? "",
    partition: p.partition,
    offset: p.offset ?? -1,
  }));
  if (toppars.length === 0)
    throw new Error("committed_offsets requires partitions");
  const consumerConf = {
    ...(conf as unknown as ConfigRecord),
    "group.id": groupId,
  } as unknown as ConsumerGlobalConfig;
  const consumer = new Kafka.KafkaConsumer(consumerConf, {});
  await connectClient(consumer);
  try {
    const offsets = await new Promise<TopicPartitionOffset[]>(
      (resolve, reject) => {
        consumer.committed(
          toppars.map(({ topic, partition }) => ({ topic, partition })),
          input.timeout_ms,
          (err: LibrdKafkaError, data: TopicPartitionOffset[]) => {
            if (err) reject(err);
            else resolve(data);
          },
        );
      },
    );
    return { group_id: groupId, offsets };
  } finally {
    await disconnectClient(consumer);
  }
}

const OPERATIONS = {
  produce: opProduce,
  consume: opConsume,
  list_topics: opListTopics,
  describe_topics: opDescribeTopics,
  describe_cluster: opDescribeCluster,
  create_topic: opCreateTopic,
  delete_topic: opDeleteTopic,
  create_partitions: opCreatePartitions,
  watermark_offsets: opWatermarkOffsets,
  committed_offsets: opCommittedOffsets,
} as const;

export const kafkaModule: ToolModule = {
  name: "kafka",
  register(server) {
    server.registerTool(
      TOOL_NAMES.kafkaTool,
      {
        title: "Kafka",
        description:
          "Operate an Apache Kafka cluster through librdkafka (node-rdkafka) with full client privileges. Choose an operation: produce (send messages), consume (read messages by subscription or explicit partition assignments), list_topics, describe_topics, describe_cluster, create_topic, delete_topic, create_partitions, watermark_offsets (low/high per partition) and committed_offsets (a group's committed positions). There is no operation allowlist beyond these; raw librdkafka configuration (security.protocol, sasl.*, ssl.*, etc.) is passed through config. Message keys/values are strings decoded with encoding (utf8 default, or base64 for binary); consume returns at most max_messages within timeout_ms. Uses KAFKA_BROKERS (default localhost:9092) or brokers, plus KAFKA_CLIENT_ID and optional KAFKA_USERNAME/KAFKA_PASSWORD/KAFKA_SASL_MECHANISM/KAFKA_SECURITY_PROTOCOL.",
        inputSchema: {
          brokers: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("CSV broker list override, e.g. localhost:9092."),
          client_id: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Client id override."),
          config: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .default({})
            .describe(
              "Raw librdkafka global configuration passthrough, e.g. {'security.protocol':'SASL_SSL','sasl.mechanisms':'SCRAM-SHA-512'}.",
            ),
          operation: z.enum([
            "produce",
            "consume",
            "list_topics",
            "describe_topics",
            "describe_cluster",
            "create_topic",
            "delete_topic",
            "create_partitions",
            "watermark_offsets",
            "committed_offsets",
          ]),
          topic: z.string().trim().min(1).optional().describe("Target topic."),
          topics: z
            .array(z.string().trim().min(1))
            .optional()
            .describe("Topics to subscribe for consume."),
          messages: z
            .array(
              z.object({
                key: z.string().nullable().optional(),
                value: z.string().nullable(),
                partition: z.number().int().nonnegative().optional(),
                timestamp: z.number().int().optional(),
                headers: z.record(z.string(), z.string()).optional(),
              }),
            )
            .optional()
            .describe("Messages to produce. A null value writes a tombstone."),
          assignments: z
            .array(
              z.object({
                topic: z.string().trim().min(1),
                partition: z.number().int().nonnegative(),
                offset: z.number().int().nonnegative().optional(),
              }),
            )
            .optional()
            .describe(
              "Explicit partition assignments for consume (bypasses group subscription).",
            ),
          partitions: z
            .array(
              z.object({
                topic: z.string().trim().min(1).optional(),
                partition: z.number().int().nonnegative(),
                offset: z.number().int().nonnegative().optional(),
              }),
            )
            .optional()
            .describe(
              "Partition list for watermark_offsets and committed_offsets.",
            ),
          group_id: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Consumer group id."),
          from_beginning: z
            .boolean()
            .default(false)
            .describe(
              "consume from earliest offset (auto.offset.reset=earliest).",
            ),
          auto_commit: z
            .boolean()
            .default(false)
            .describe("Enable consumer auto-commit."),
          max_messages: z
            .number()
            .int()
            .positive()
            .default(50)
            .describe("Maximum messages to collect for consume."),
          num_partitions: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Partition count for create_topic / desired total for create_partitions.",
            ),
          replication_factor: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Replication factor for create_topic."),
          topic_config: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "Topic-level config entries for create_topic, e.g. {'retention.ms':'86400000'}.",
            ),
          encoding: z
            .enum(["utf8", "base64"])
            .default("utf8")
            .describe("Encoding for message keys/values."),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .default(15_000)
            .describe(
              "Consume window and per-request timeout in milliseconds.",
            ),
        },
        annotations: unrestrictedAnnotations,
      },
      async (raw) => {
        try {
          const kafka = loadConfig().kafka;
          const brokers = raw.brokers ?? (kafka.brokers || "localhost:9092");
          const clientId = raw.client_id ?? kafka.clientId;
          const conf = buildConfig(brokers, clientId, raw.config);
          const input: OpInput = {
            topic: raw.topic,
            topics: raw.topics,
            messages: raw.messages,
            assignments: raw.assignments,
            partitions: raw.partitions,
            group_id: raw.group_id,
            from_beginning: raw.from_beginning,
            auto_commit: raw.auto_commit,
            max_messages: raw.max_messages,
            num_partitions: raw.num_partitions,
            replication_factor: raw.replication_factor,
            topic_config: raw.topic_config,
            encoding: raw.encoding,
            timeout_ms: raw.timeout_ms,
          };
          const handler = OPERATIONS[raw.operation];
          const data = await handler(input, conf);
          return operationResult({ operation: raw.operation, data });
        } catch (error) {
          return operationError(TOOL_NAMES.kafkaTool, error);
        }
      },
    );
  },
};
