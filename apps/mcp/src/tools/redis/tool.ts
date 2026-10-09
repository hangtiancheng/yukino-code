import { createClient } from "redis";
import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import {
  connectionUrlSchema,
  operationResult,
  requireConnection,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";

// EXEC can succeed as a command while individual queued commands return errors.
function hasReplyError(reply: unknown): boolean {
  return (
    reply instanceof Error ||
    (Array.isArray(reply) && reply.some(hasReplyError))
  );
}

export const redisModule: ToolModule = {
  name: "redis",
  register(server) {
    server.registerTool(
      TOOL_NAMES.redisTool,
      {
        title: "Redis",
        description:
          'Execute any Redis command with full connection privileges, including reads, writes, Lua scripts, configuration and destructive commands. Supply an ordered commands array of argument arrays, e.g. [["SET","key","value"],["GET","key"]]. All commands run sequentially on one dedicated connection so SELECT, MULTI/EXEC and state changes work within a call. Stops at the first failed command and retains completed replies. Uses REDIS_URL or connection_url; independent of the docs connection.',
        inputSchema: {
          connection_url: connectionUrlSchema,
          commands: z
            .array(z.array(z.string()).min(1))
            .min(1)
            .describe(
              "Redis commands as argument arrays. Arguments are sent verbatim, without shell parsing or command filtering.",
            ),
        },
        annotations: unrestrictedAnnotations,
      },
      async ({ connection_url, commands }) => {
        const results: unknown[] = [];
        try {
          const url = requireConnection(
            connection_url,
            loadConfig().redis.url,
            "REDIS_URL",
          );
          const client = createClient({
            url,
            socket: { connectTimeout: 10_000, reconnectStrategy: false },
          });
          // EventEmitter requires an error listener; errors are returned by the
          // pending connect/sendCommand promise, never printed to stdio.
          client.on("error", () => undefined);
          try {
            await client.connect();
            for (const command of commands) {
              const reply = await client.sendCommand(command);
              results.push(reply);
              if (hasReplyError(reply)) {
                return {
                  ...operationResult({
                    results,
                    failed_command_index: results.length - 1,
                  }),
                  isError: true,
                };
              }
            }
            return operationResult({ results });
          } finally {
            if (client.isOpen) client.destroy();
          }
        } catch (error) {
          return {
            ...operationResult({
              error: `${TOOL_NAMES.redisTool} failed: ${error instanceof Error ? error.message : String(error)}`,
              results,
              failed_command_index: results.length,
            }),
            isError: true,
          };
        }
      },
    );
  },
};
