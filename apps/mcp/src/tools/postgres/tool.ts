import { Client, type QueryResult } from "pg";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import {
  operationError,
  operationResult,
  requireConnection,
  sqlInputSchema,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";

export const postgresModule: ToolModule = {
  name: "postgres",
  register(server) {
    server.registerTool(
      TOOL_NAMES.postgresTool,
      {
        title: "PostgreSQL",
        description:
          "Execute arbitrary PostgreSQL SQL with full connection privileges: queries, writes, DDL, transactions and administrative statements. Multiple statements are supported when params is empty; put a complete transaction in one call. Returns every statement's rows, row count, command and field metadata. Uses POSTGRES_URL (POSTGRESQL_URL/DATABASE_URL fallback) or connection_url.",
        inputSchema: sqlInputSchema,
        annotations: unrestrictedAnnotations,
      },
      async ({ connection_url, sql, params }) => {
        try {
          const url = requireConnection(
            connection_url,
            loadConfig().postgres.url,
            "POSTGRES_URL",
          );
          const client = new Client({
            connectionString: url,
            connectionTimeoutMillis: 10_000,
          });
          client.on("error", () => undefined);
          try {
            await client.connect();
            const result = await client.query(sql, params);
            const results: QueryResult[] = Array.isArray(result)
              ? result
              : [result];
            return operationResult({
              results: results.map((item) => ({
                command: item.command,
                row_count: item.rowCount,
                rows: item.rows,
                fields: item.fields.map((field) => ({
                  name: field.name,
                  data_type_id: field.dataTypeID,
                })),
              })),
            });
          } finally {
            await client.end();
          }
        } catch (error) {
          return operationError(TOOL_NAMES.postgresTool, error);
        }
      },
    );
  },
};
