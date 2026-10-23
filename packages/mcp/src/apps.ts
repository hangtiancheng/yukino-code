import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { MCP_APP_URI_PREFIX } from "./constants.js";

export const McpAppSchema = z.object({
  serverName: z.string(),
  toolName: z.string(),
  resourceUri: z.string().startsWith(MCP_APP_URI_PREFIX),
  arguments: z.record(z.string(), z.unknown()),
  result: CallToolResultSchema,
});

export type McpApp = z.infer<typeof McpAppSchema>;

export const McpAppToolResultSchema = z.object({
  toolId: z.string(),
  toolName: z.string(),
  output: z.string(),
  isError: z.boolean(),
  elapsed: z.number(),
  mcpApp: McpAppSchema,
});

export type McpAppToolResult = z.infer<typeof McpAppToolResultSchema>;

export const McpAppRequestSchema = z.discriminatedUnion("method", [
  z.object({
    requestId: z.string(),
    appId: z.string(),
    method: z.literal("read_resource"),
    params: z.object({ uri: z.string() }),
  }),
  z.object({
    requestId: z.string(),
    appId: z.string(),
    method: z.literal("call_tool"),
    params: z.object({
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

export type McpAppRequest = z.infer<typeof McpAppRequestSchema>;
