import { BSON, MongoClient } from "mongodb";
import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import {
  connectionUrlSchema,
  operationError,
  operationResult,
  requireConnection,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";

export const mongodbModule: ToolModule = {
  name: "mongodb",
  register(server) {
    server.registerTool(
      TOOL_NAMES.mongodbTool,
      {
        title: "MongoDB",
        description:
          'Execute any MongoDB database command with full connection privileges: find, insert, update, delete, aggregate, create/drop collections or databases, indexes, users and administration. Supply a raw command document (e.g. {"find":"users","filter":{}}); BSON values use Extended JSON such as {"$oid":"..."}. Set database to admin for administrative commands. Returns the full command response as canonical Extended JSON, preserving BSON types and cursor batches. Uses MONGODB_URL or connection_url; database defaults to MONGODB_DATABASE or the URL\'s database.',
        inputSchema: {
          connection_url: connectionUrlSchema,
          database: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Database override; use admin for server-level commands.",
            ),
          command: z
            .record(z.string(), z.json())
            .refine(
              (value) => Object.keys(value).length > 0,
              "command must not be empty",
            )
            .describe(
              "Raw MongoDB command document, accepting Extended JSON for BSON types. There is no operation allowlist.",
            ),
        },
        annotations: unrestrictedAnnotations,
      },
      async ({ connection_url, database, command }) => {
        try {
          const config = loadConfig().mongodb;
          const url = requireConnection(
            connection_url,
            config.url,
            "MONGODB_URL",
          );
          const client = new MongoClient(url, {
            serverSelectionTimeoutMS: 10_000,
          });
          try {
            await client.connect();
            const result = await client
              .db(database ?? (config.database || undefined))
              .command(BSON.EJSON.deserialize(command, { relaxed: false }));
            return operationResult({
              data: BSON.EJSON.serialize(result, { relaxed: false }),
            });
          } finally {
            await client.close();
          }
        } catch (error) {
          return operationError(TOOL_NAMES.mongodbTool, error);
        }
      },
    );
  },
};
