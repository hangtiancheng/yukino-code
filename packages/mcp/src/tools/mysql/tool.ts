import type { FieldPacket } from "mysql2";
import { createConnection } from "mysql2/promise";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import {
  operationError,
  operationResult,
  requireConnection,
  sqlInputSchema,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";
import type { ToolModule } from "@/tools/types.js";

export const mysqlModule: ToolModule = {
  name: "mysql",
  register(server) {
    server.registerTool(
      TOOL_NAMES.mysqlTool,
      {
        title: "MySQL",
        description:
          "Execute arbitrary MySQL SQL with full connection privileges: queries, writes, DDL, transactions, administration and multiple statements. Put a complete transaction in one call. Optional ? parameters are supported. Returns query rows or mutation result headers and field metadata for all statements. Uses MYSQL_URL or connection_url.",
        inputSchema: sqlInputSchema,
        annotations: unrestrictedAnnotations,
      },
      async ({ connection_url, sql, params }) => {
        try {
          const url = requireConnection(
            connection_url,
            loadConfig().mysql.url,
            "MYSQL_URL",
          );
          const client = await createConnection({
            uri: url,
            multipleStatements: true,
            supportBigNumbers: true,
            bigNumberStrings: true,
            connectTimeout: 10_000,
          });
          try {
            const [results, fields] = await client.query(sql, params);
            return operationResult({
              results,
              fields: normalizeFields(fields),
            });
          } finally {
            await client.end();
          }
        } catch (error) {
          return operationError(TOOL_NAMES.mysqlTool, error);
        }
      },
    );
  },
};

// Publish protocol metadata, rather than mysql2's private packet buffers and
// offsets. This representation is shared by the TypeScript and Go servers.
function normalizeFields(fields: unknown): unknown {
  if (fields === undefined || fields === null) {
    return fields;
  }
  if (Array.isArray(fields)) {
    return fields.map(normalizeFields);
  }
  const field = fields as FieldPacket;
  return {
    catalog: field.catalog,
    schema: field.schema,
    name: field.name,
    orgName: field.orgName,
    table: field.table,
    orgTable: field.orgTable,
    characterSet: field.characterSet,
    columnLength: field.columnLength,
    type: field.columnType ?? field.type,
    flags: field.flags,
    decimals: field.decimals,
  };
}
