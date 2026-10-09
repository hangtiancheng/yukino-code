import { createConnection } from "mysql2/promise";

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
            return operationResult({ results, fields });
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
