import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import {
  connectionUrlSchema,
  operationError,
  operationResult,
  requireConnection,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";
import type { ToolModule } from "@/tools/types.js";

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const clickhouseModule: ToolModule = {
  name: "clickhouse",
  register(server) {
    server.registerTool(
      TOOL_NAMES.clickhouseTool,
      {
        title: "ClickHouse",
        description:
          "Execute arbitrary ClickHouse SQL over the HTTP interface with the account's full privileges: queries, inserts, DDL, mutations, system and administrative statements. There is no SQL allowlist or read-only mode. SELECT results are returned parsed when the output format is JSON-family (default_format defaults to JSON; override with format, e.g. JSONEachRow, CSV, TSV, Pretty). For INSERT ... FORMAT <fmt>, pass the SQL in sql and the rows in data (or data_base64); the query is sent as a parameter and the data as the body. Parameterized queries use params, mapped to ClickHouse param_<name> settings for {name:Type} placeholders. Extra engine settings (max_execution_time, readonly, etc.) go in settings. Uses CLICKHOUSE_URL (CLICKHOUSE_HTTP_URL fallback) or connection_url; credentials from CLICKHOUSE_USER/CLICKHOUSE_PASSWORD, database from CLICKHOUSE_DATABASE.",
        inputSchema: {
          connection_url: connectionUrlSchema,
          sql: z.string().min(1).describe("SQL statement to execute verbatim."),
          params: z
            .record(z.string(), scalar)
            .default({})
            .describe(
              "Parameterized-query values, sent as param_<name> for {name:Type} placeholders.",
            ),
          settings: z
            .record(z.string(), scalar)
            .default({})
            .describe(
              "ClickHouse settings passed as query parameters, e.g. {max_execution_time: 10, readonly: 1}.",
            ),
          database: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Database override (CLICKHOUSE_DATABASE fallback)."),
          format: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "default_format for results when the SQL has no FORMAT clause. Defaults to JSON.",
            ),
          data: z
            .string()
            .optional()
            .describe(
              "Raw data body for INSERT ... FORMAT <fmt>; the SQL moves to the query parameter.",
            ),
          data_base64: z
            .string()
            .optional()
            .describe("Base64-encoded data body for binary INSERT formats."),
          user: z.string().trim().min(1).optional().describe("User override."),
          password: z.string().optional().describe("Password override."),
          api_key: z
            .string()
            .min(1)
            .optional()
            .describe("Send X-ClickHouse-Key instead of basic auth."),
          headers: z
            .record(z.string(), z.string())
            .default({})
            .describe("Additional HTTP headers."),
          stacktrace: z
            .boolean()
            .default(false)
            .describe("Request a server stack trace on errors."),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .default(30_000)
            .describe("HTTP request timeout in milliseconds."),
        },
        annotations: unrestrictedAnnotations,
      },
      async (input) => {
        try {
          const config = loadConfig().clickhouse;
          const base = requireConnection(
            input.connection_url,
            config.url,
            "CLICKHOUSE_URL",
          ).replace(/\/+$/, "");
          const user = input.user ?? config.username;
          const password = input.password ?? config.password;
          const database = input.database ?? config.database;

          const url = new URL(base);
          const search = url.searchParams;
          if (database) {
            search.set("database", database);
          }
          for (const [key, value] of Object.entries(input.params)) {
            search.set(`param_${key}`, String(value));
          }
          for (const [key, value] of Object.entries(input.settings)) {
            search.set(key, String(value));
          }
          const format = input.format ?? "JSON";
          search.set("default_format", format);
          if (input.stacktrace) {
            search.set("stacktrace", "1");
          }

          const requestHeaders = new Headers();
          // Send credentials through exactly one channel: ClickHouse rejects
          // requests that carry them in both the query string and the
          // Authorization header (AUTHENTICATION_FAILED), so no `user` query
          // parameter is set alongside the basic-auth header.
          if (input.api_key) {
            requestHeaders.set("x-clickhouse-key", input.api_key);
            if (user) {
              requestHeaders.set("x-clickhouse-user", user);
            }
          } else if (user || password) {
            requestHeaders.set(
              "authorization",
              `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
            );
          }
          for (const [key, value] of Object.entries(input.headers)) {
            requestHeaders.set(key, value);
          }

          let body: string | Uint8Array;
          if (input.data !== undefined || input.data_base64 !== undefined) {
            // INSERT-style: query in the URL, data in the body.
            search.set("query", input.sql);
            body =
              input.data_base64 !== undefined
                ? Buffer.from(input.data_base64, "base64")
                : (input.data ?? "");
            if (typeof body === "string") {
              requestHeaders.set("content-type", "text/plain; charset=utf-8");
            }
          } else {
            body = input.sql;
            requestHeaders.set("content-type", "text/plain; charset=utf-8");
          }

          const response = await fetch(url, {
            method: "POST",
            headers: requestHeaders,
            body: typeof body === "string" ? body : new Uint8Array(body),
            signal: AbortSignal.timeout(input.timeout_ms),
          });
          const text = await response.text();

          const isJsonFormat = /^JSON/i.test(format);
          let data: unknown = text;
          if (isJsonFormat && text.trim() !== "") {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }

          const result = operationResult({
            status_code: response.status,
            format,
            data,
          });
          return response.ok ? result : { ...result, isError: true };
        } catch (error) {
          return operationError(TOOL_NAMES.clickhouseTool, error);
        }
      },
    );
  },
};
