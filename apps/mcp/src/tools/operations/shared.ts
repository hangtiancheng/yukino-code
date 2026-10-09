import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpToolName } from "@/tools/names.js";

export const connectionUrlSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    "Connection URL override; otherwise uses the configured environment variable.",
  );

export const sqlInputSchema = {
  connection_url: connectionUrlSchema,
  sql: z
    .string()
    .min(1)
    .describe(
      "SQL to execute verbatim, including writes, DDL, administration and multiple statements.",
    ),
  params: z
    .array(z.json())
    .default([])
    .describe(
      "Optional positional parameters ($1, $2 for PostgreSQL; ? for MySQL).",
    ),
};

export const unrestrictedAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function requireConnection(
  override: string | undefined,
  configured: string,
  envName: string,
): string {
  const url = override ?? configured;
  if (!url) {
    throw new Error(
      `Connection is not configured. Set ${envName} or supply connection_url.`,
    );
  }
  return url;
}

/** Normalize driver values once so text and structured MCP results agree. */
export function operationResult(data: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify(data, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error)
      return { name: value.name, message: value.message };
    if (value instanceof Map) return Object.fromEntries(value);
    if (value instanceof Set) return [...value];
    return value;
  });
  const structuredContent: Record<string, unknown> = JSON.parse(text);
  return { content: [{ type: "text", text }], structuredContent };
}

export function operationError(
  name: McpToolName,
  error: unknown,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}
