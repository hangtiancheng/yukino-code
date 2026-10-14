import { randomUUID } from "node:crypto";
import {
  Admin,
  Consumer,
  Producer,
  MessagesStreamModes,
  MessagesStreamFallbackModes,
  IS_CONTROL,
  protocolErrors,
  protocolErrorsCodesById,
  findErrorBy,
} from "@platformatic/kafka";
import type {
  BaseOptions,
  ProducerOptions,
  ConsumerOptions,
  Message,
  MessagesStream,
  ClusterMetadata,
  CommitOptionsPartition,
} from "@platformatic/kafka";
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
type KafkaOptions = BaseOptions &
  Partial<ProducerOptions<Buffer, Buffer | null, Buffer, Buffer>> &
  Partial<ConsumerOptions<Buffer, Buffer, Buffer, Buffer>>;
function buildConfig(
  brokers: string,
  clientId: string,
  extra: Record<string, unknown>,
  timeout: number,
): KafkaOptions {
  const legacy = Object.keys(extra).find((key) => key.includes("."));
  if (legacy)
    throw new Error(
      `Unsupported legacy Kafka config key "${legacy}"; use @platformatic/kafka client options.`,
    );
  const kafka = loadConfig().kafka;
  const protocol = kafka.securityProtocol?.toUpperCase();
  if (
    protocol &&
    !["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"].includes(protocol)
  )
    throw new Error(`Unsupported Kafka security protocol "${protocol}"`);
  const bootstrapBrokers = brokers.split(",").map((value) => value.trim());
  const conf: KafkaOptions = {
    clientId,
    bootstrapBrokers,
    timeout,
    requestTimeout: timeout,
    connectTimeout: timeout,
    retries: 0,
    strict: true,
  };
  if (bootstrapBrokers.some((broker) => broker === ""))
    throw new Error("Kafka brokers must not contain empty entries");
  if (protocol === "SSL" || protocol === "SASL_SSL") {
    conf.tls = {};
    conf.tlsServerName = true;
  }
  if (kafka.username || kafka.saslMechanism || protocol?.startsWith("SASL_")) {
    conf.sasl = {
      mechanism: (kafka.saslMechanism || "PLAIN") as NonNullable<
        BaseOptions["sasl"]
      >["mechanism"],
      username: kafka.username,
      password: kafka.password,
    };
  }
  return Object.assign(conf, extra);
}
function toBuffer(
  value: string | null | undefined,
  encoding: Encoding,
): Buffer | undefined {
  return value == null ? undefined : Buffer.from(value, encoding);
}
function decodeBuffer(
  value: Buffer | null | undefined,
  encoding: Encoding,
): string | null {
  return value == null ? null : value.toString(encoding);
}
function jsonInteger(value: bigint): number | string {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}
function normalizeMessage(
  message: Pick<Message, "topic" | "partition" | "offset" | "timestamp"> & {
    key?: Buffer;
    value?: Buffer;
    headerEntries: Array<[Buffer, Buffer]>;
  },
  encoding: Encoding,
): Record<string, unknown> {
  return {
    topic: message.topic,
    partition: message.partition,
    offset: jsonInteger(message.offset),
    timestamp: jsonInteger(message.timestamp),
    size: message.value?.length ?? 0,
    key: decodeBuffer(message.key, encoding),
    value: decodeBuffer(message.value, encoding),
    headers: message.headerEntries.map(([key, value]) => ({
      [key.toString()]: value,
    })),
  };
}
function requireString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`operation requires "${field}"`);
  return value;
}
function protocolError(code: number): void {
  if (code !== 0)
    throw new Error(
      protocolErrors[protocolErrorsCodesById[code]]?.message ??
        `Kafka protocol error ${code}`,
    );
}
async function withAdmin<T>(
  conf: KafkaOptions,
  fn: (admin: Admin) => Promise<T>,
): Promise<T> {
  const admin = new Admin(conf);
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}
function normalizeTopics(metadata: ClusterMetadata) {
  return [...metadata.topics]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, topic]) => ({
      name,
      partitions: topic.partitions.map((part, id) => ({
        id,
        leader: part.leader,
        replicas: part.replicas,
        isrs: part.isr,
      })),
    }));
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

async function opProduce(input: OpInput, conf: KafkaOptions): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  if (!input.messages?.length)
    throw new Error("produce requires at least one message");
  const producer = new Producer<Buffer, Buffer | null, Buffer, Buffer>(conf);
  try {
    if (input.messages.some((message) => message.partition !== undefined)) {
      const metadata = await producer.metadata({
        topics: [topic],
        autocreateTopics: conf.autocreateTopics,
      });
      const count =
        metadata.topics.get(topic)?.partitionsCount ??
        metadata.topics.get(topic)?.partitions.length ??
        0;
      for (const message of input.messages) {
        if (message.partition !== undefined && message.partition >= count)
          throw new Error(
            `Unknown Kafka partition ${topic}/${message.partition}`,
          );
      }
    }
    await producer.send({
      messages: input.messages.map((message) => ({
        topic,
        partition: message.partition,
        key: toBuffer(message.key, input.encoding),
        value: toBuffer(message.value, input.encoding) ?? null,
        timestamp:
          message.timestamp === undefined
            ? undefined
            : BigInt(message.timestamp),
        headers: message.headers
          ? new Map(
              Object.entries(message.headers).map(([key, value]) => [
                Buffer.from(key),
                Buffer.from(value),
              ]),
            )
          : undefined,
      })),
    });
    return { produced: input.messages.length };
  } finally {
    await producer.close(true);
  }
}
function collectMessages(
  stream: MessagesStream<Buffer, Buffer, Buffer, Buffer>,
  max: number,
  timeout: number,
): Promise<Message[]> {
  return new Promise((resolve, reject) => {
    const messages: Message[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.pause();
      if (error) reject(error);
      else resolve(messages);
    };
    const timer = setTimeout(() => finish(), Math.max(0, timeout));
    stream.on("error", (error) => finish(error));
    stream.on("end", () => finish());
    stream.on("data", (message) => {
      if (settled) return;
      messages.push(message);
      if (messages.length >= max) finish();
    });
  });
}
async function opConsume(input: OpInput, conf: KafkaOptions): Promise<unknown> {
  if (input.assignments?.length) return opAssignedConsume(input, conf);
  if (!input.topics?.length)
    throw new Error("consume requires topics or assignments");
  const groupId =
    input.group_id ?? conf.groupId ?? `yukino-mcp-${randomUUID()}`;
  const consumer = new Consumer<Buffer, Buffer, Buffer, Buffer>({
    ...conf,
    groupId,
    autocommit: false,
    highWaterMark: 1,
    maxWaitTime: Math.min(100, input.timeout_ms),
  });
  const deadline = Date.now() + input.timeout_ms;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stream = await Promise.race([
      consumer.consume({
        topics: input.topics,
        autocommit: false,
        mode: MessagesStreamModes.COMMITTED,
        fallbackMode: input.from_beginning
          ? MessagesStreamFallbackModes.EARLIEST
          : MessagesStreamFallbackModes.LATEST,
      }),
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error("Kafka consume setup timed out")),
          input.timeout_ms,
        );
      }),
    ]);
    clearTimeout(startupTimer);
    const messages = await collectMessages(
      stream,
      input.max_messages,
      deadline - Date.now(),
    );
    if (input.auto_commit && messages.length) {
      const offsets = new Map<string, CommitOptionsPartition>();
      for (const message of messages)
        offsets.set(`${message.topic}:${message.partition}`, {
          topic: message.topic,
          partition: message.partition,
          offset: message.offset + 1n,
          leaderEpoch: message.leaderEpoch,
        });
      await consumer.commit({ offsets: [...offsets.values()] });
    }
    return {
      count: messages.length,
      group_id: groupId,
      messages: messages.map((message) =>
        normalizeMessage(message, input.encoding),
      ),
    };
  } finally {
    clearTimeout(startupTimer);
    await consumer.close(true);
  }
}
// Direct Fetch requests preserve explicit assignments without joining a group.
async function opAssignedConsume(
  input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  const assignments = input.assignments!;
  const groupId =
    input.group_id ?? conf.groupId ?? `yukino-mcp-${randomUUID()}`;
  const consumer = new Consumer<Buffer, Buffer, Buffer, Buffer>({
    ...conf,
    groupId,
    autocommit: false,
  });
  const admin = new Admin(conf);
  const deadline = Date.now() + input.timeout_ms;
  try {
    const topics = [...new Set(assignments.map((a) => a.topic))];
    const metadata = await admin.metadata({ topics });
    const fallback = await admin.listOffsets({
      topics: topics.map((name) => ({
        name,
        partitions: assignments
          .filter((a) => a.topic === name)
          .map((a) => ({
            partitionIndex: a.partition,
            timestamp: input.from_beginning ? -2n : -1n,
          })),
      })),
    });
    const stored = assignments.some((a) => a.offset === undefined)
      ? await groupOffsets(admin, {
          groups: [
            {
              groupId,
              topics: topics.map((name) => ({
                name,
                partitionIndexes: assignments
                  .filter((a) => a.topic === name)
                  .map((a) => a.partition),
              })),
            },
          ],
        })
      : [];
    const positions = assignments.map((a) => {
      const topic = metadata.topics.get(a.topic);
      const partition = topic?.partitions[a.partition];
      if (!topic || !partition)
        throw new Error(`Unknown Kafka partition ${a.topic}/${a.partition}`);
      const committed = stored[0]?.topics
        .find((t) => t.name === a.topic)
        ?.partitions.find(
          (p) => p.partitionIndex === a.partition,
        )?.committedOffset;
      const fallbackOffset = fallback
        .find((t) => t.name === a.topic)
        ?.partitions.find((p) => p.partitionIndex === a.partition)?.offset;
      const offset =
        a.offset !== undefined
          ? BigInt(a.offset)
          : committed !== undefined && committed >= 0n
            ? committed
            : fallbackOffset;
      if (offset === undefined)
        throw new Error(`Missing Kafka offset ${a.topic}/${a.partition}`);
      return {
        ...a,
        id: topic.id,
        leader: partition.leader,
        epoch: partition.leaderEpoch,
        offset,
      };
    });
    const messages: Record<string, unknown>[] = [];
    const commits = new Map<
      string,
      {
        name: string;
        partitionOffsets: Array<{ partition: number; offset: bigint }>;
      }
    >();
    while (messages.length < input.max_messages && Date.now() < deadline) {
      for (const position of positions) {
        if (messages.length >= input.max_messages || Date.now() >= deadline)
          break;
        const response = await consumer.fetch({
          node: position.leader,
          maxWaitTime: Math.min(100, Math.max(1, deadline - Date.now())),
          minBytes: 1,
          maxBytes: 1048576,
          topics: [
            {
              topicId: position.id,
              partitions: [
                {
                  partition: position.partition,
                  currentLeaderEpoch: position.epoch,
                  fetchOffset: position.offset,
                  lastFetchedEpoch: -1,
                  partitionMaxBytes: 1048576,
                },
              ],
            },
          ],
        });
        protocolError(response.errorCode);
        for (const topic of response.responses)
          for (const part of topic.partitions) {
            protocolError(part.errorCode);
            for (const batch of part.records ?? []) {
              if (batch.attributes & IS_CONTROL) continue;
              for (const record of batch.records) {
                const offset = batch.firstOffset + BigInt(record.offsetDelta);
                if (offset < position.offset) continue;
                messages.push(
                  normalizeMessage(
                    {
                      topic: position.topic,
                      partition: position.partition,
                      offset,
                      timestamp: batch.firstTimestamp + record.timestampDelta,
                      key: record.key ?? undefined,
                      value: record.value ?? undefined,
                      headerEntries: record.headers.map(([key, value]) => [
                        key ?? Buffer.alloc(0),
                        value ?? Buffer.alloc(0),
                      ]),
                    },
                    input.encoding,
                  ),
                );
                position.offset = offset + 1n;
                if (!commits.has(position.topic))
                  commits.set(position.topic, {
                    name: position.topic,
                    partitionOffsets: [],
                  });
                const offsets = commits.get(position.topic)!.partitionOffsets;
                const commit = offsets.find(
                  (p) => p.partition === position.partition,
                );
                if (commit) commit.offset = position.offset;
                else
                  offsets.push({
                    partition: position.partition,
                    offset: position.offset,
                  });
                if (messages.length >= input.max_messages) break;
              }
              if (messages.length >= input.max_messages) break;
            }
          }
      }
    }
    if (input.auto_commit && commits.size)
      await admin.alterConsumerGroupOffsets({
        groupId,
        topics: [...commits.values()],
      });
    return { count: messages.length, group_id: groupId, messages };
  } finally {
    await Promise.all([consumer.close(true), admin.close()]);
  }
}
async function opListTopics(
  _input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  return withAdmin(conf, async (admin) => ({
    topics: (await admin.listTopics({ includeInternals: true })).sort(),
  }));
}
async function opDescribeTopics(
  input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  return withAdmin(conf, async (admin) => ({
    topics: normalizeTopics(
      await admin.metadata({ topics: input.topic ? [input.topic] : undefined }),
    ),
  }));
}
async function opDescribeCluster(
  _input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  return withAdmin(conf, async (admin) => {
    const metadata = await admin.metadata({ topics: [] });
    return {
      brokers: [...metadata.brokers].map(([id, broker]) => ({
        id,
        host: broker.host,
        port: broker.port,
      })),
      controller_id: metadata.controllerId,
      cluster_id: metadata.id,
    };
  });
}
async function opCreateTopic(
  input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  return withAdmin(conf, async (admin) => {
    await admin.createTopics({
      topics: [topic],
      partitions: input.num_partitions ?? 1,
      replicas: input.replication_factor ?? 1,
      configs: Object.entries(input.topic_config ?? {}).map(
        ([name, value]) => ({ name, value }),
      ),
    });
    return { created: topic };
  });
}
async function opDeleteTopic(
  input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  return withAdmin(conf, async (admin) => {
    await admin.deleteTopics({ topics: [topic] });
    return { deleted: topic };
  });
}
async function opCreatePartitions(
  input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  if (!input.num_partitions)
    throw new Error('create_partitions requires "num_partitions"');
  return withAdmin(conf, async (admin) => {
    await admin.createPartitions({
      topics: [{ name: topic, count: input.num_partitions!, assignments: [] }],
    });
    return { topic, partitions: input.num_partitions };
  });
}
async function opWatermarkOffsets(
  input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  const topic = requireString(input.topic, "topic");
  return withAdmin(conf, async (admin) => {
    const metadata = await admin.metadata({ topics: [topic] });
    const ids = input.partitions?.length
      ? input.partitions.map((p) => p.partition)
      : (metadata.topics.get(topic)?.partitions.map((_, id) => id) ?? []);
    const query = (timestamp: bigint) =>
      admin.listOffsets({
        topics: [
          {
            name: topic,
            partitions: ids.map((partitionIndex) => ({
              partitionIndex,
              timestamp,
            })),
          },
        ],
      });
    const [low, high] = await Promise.all([query(-2n), query(-1n)]);
    return {
      topic,
      partitions: ids.map((partition) => {
        const lo = low[0]?.partitions.find(
          (p) => p.partitionIndex === partition,
        )?.offset;
        const hi = high[0]?.partitions.find(
          (p) => p.partitionIndex === partition,
        )?.offset;
        if (lo === undefined || hi === undefined)
          throw new Error(`Missing Kafka watermark ${topic}/${partition}`);
        return { partition, low: jsonInteger(lo), high: jsonInteger(hi) };
      }),
    };
  });
}
async function opCommittedOffsets(
  input: OpInput,
  conf: KafkaOptions,
): Promise<unknown> {
  const groupId = requireString(input.group_id, "group_id");
  if (!input.partitions?.length)
    throw new Error("committed_offsets requires partitions");
  const topics = new Map<string, number[]>();
  const refs = input.partitions.map((part) => ({
    ...part,
    topic: requireString(part.topic ?? input.topic, "topic"),
  }));
  for (const part of refs) {
    if (!topics.has(part.topic)) topics.set(part.topic, []);
    topics.get(part.topic)!.push(part.partition);
  }
  return withAdmin(conf, async (admin) => {
    const groups = await groupOffsets(admin, {
      groups: [
        {
          groupId,
          topics: [...topics].map(([name, partitionIndexes]) => ({
            name,
            partitionIndexes,
          })),
        },
      ],
    });
    return {
      group_id: groupId,
      offsets: refs.map((part) => {
        const offset = groups[0]?.topics
          .find((t) => t.name === part.topic)
          ?.partitions.find(
            (p) => p.partitionIndex === part.partition,
          )?.committedOffset;
        return {
          topic: part.topic,
          partition: part.partition,
          offset:
            offset === undefined || offset < 0n ? -1001 : jsonInteger(offset),
        };
      }),
    };
  });
}
async function groupOffsets(
  admin: Admin,
  options: Parameters<Admin["listConsumerGroupOffsets"]>[0],
) {
  try {
    return await admin.listConsumerGroupOffsets(options);
  } catch (error) {
    if (
      error instanceof Error &&
      findErrorBy(error, "apiId", "GROUP_ID_NOT_FOUND")
    )
      return [];
    throw error;
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
          "Operate an Apache Kafka cluster through @platformatic/kafka with full client privileges. Choose an operation: produce (send messages), consume (read messages by subscription or explicit partition assignments), list_topics, describe_topics, describe_cluster, create_topic, delete_topic, create_partitions, watermark_offsets (low/high per partition) and committed_offsets (a group's committed positions; -1001 means uncommitted). There is no operation allowlist beyond these; @platformatic/kafka client options (requestTimeout, retries, acks, compression, nested tls/sasl, etc.) are passed through config. Message keys/values are strings decoded with encoding (utf8 default, or base64 for binary); consume returns at most max_messages within timeout_ms. Uses KAFKA_BROKERS (default localhost:9092) or brokers, plus KAFKA_CLIENT_ID and optional KAFKA_USERNAME/KAFKA_PASSWORD/KAFKA_SASL_MECHANISM/KAFKA_SECURITY_PROTOCOL.",
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
            .record(z.string(), z.unknown())
            .default({})
            .describe(
              "@platformatic/kafka client options, e.g. {requestTimeout:5000,sasl:{mechanism:'SCRAM-SHA-512',username:'user',password:'pass'},tls:{}}. Legacy librdkafka keys are not accepted.",
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
              "Fallback to the earliest offset when the group has no committed position.",
            ),
          auto_commit: z
            .boolean()
            .default(false)
            .describe("Commit only the records returned by this consume call."),
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
          const conf = buildConfig(
            brokers,
            clientId,
            raw.config,
            raw.timeout_ms,
          );
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
