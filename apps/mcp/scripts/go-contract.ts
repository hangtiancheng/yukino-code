import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Go uses structured MySQL credentials in its configuration file. All other
// tool argument shapes remain shared with the TypeScript server.
export function goInputSchema(tool: Pick<Tool, "name" | "inputSchema">) {
  const schema = structuredClone(tool.inputSchema);
  if (tool.name === "mysql_tool" && schema.properties) {
    delete schema.properties["connection_url"];
  }
  if (tool.name === "kafka_tool" && schema.properties?.["config"]) {
    schema.properties["config"] = {
      ...schema.properties["config"],
      description:
        "franz-go client options: requestTimeout, connectTimeout, retries (integer), retryDelay, acks (-1/0/1), compression, groupId, maxWaitTime, maxBytes, maxBytesPerPartition, autocreateTopics, nested tls (ca_file/cert_file/key_file/server_name/insecure_skip_verify) and sasl (mechanism/username/password/token). Legacy librdkafka keys are rejected.",
    };
  }
  return JSON.parse(
    JSON.stringify(schema)
      .replaceAll("configured environment variable", "JSON configuration")
      .replaceAll("CLICKHOUSE_DATABASE", "clickhouse.database")
      .replaceAll("MILVUS_DATABASE", "milvus.database"),
  ) as Tool["inputSchema"];
}
