import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import {
  operationError,
  operationResult,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";
import type { ToolModule } from "@/tools/types.js";

export const milvusModule: ToolModule = {
  name: "milvus",
  register(server) {
    server.registerTool(
      TOOL_NAMES.milvusTool,
      {
        title: "Milvus",
        description:
          "Call any Milvus RESTful API v2 endpoint with full privileges: collections (list/create/describe/drop/has/load/release/rename/alter), entities (insert/upsert/delete/get/query/search/hybrid_search), indexes, partitions, databases, aliases, users/roles/grants, import and jobs. There is no endpoint allowlist. path defaults to /v2/vectordb/collections/list and method to POST; body is the JSON request document. Set database to inject dbName into the body, or include dbName yourself. Authentication uses a Bearer token from MILVUS_TOKEN or MILVUS_USERNAME:MILVUS_PASSWORD (override with token). Responses return {status_code, data}; a non-zero Milvus code or non-2xx status sets isError. Uses MILVUS_URL (MILVUS_ADDRESS fallback) or base_url. The REST API shares the gRPC port (default 19530); health/metrics live on 9091 and can be reached with an absolute base_url.",
        inputSchema: z.object({
          base_url: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Milvus base URL override, e.g. http://localhost:19530."),
          path: z
            .string()
            .min(1)
            .default("/v2/vectordb/collections/list")
            .describe("REST endpoint path or absolute URL."),
          method: z
            .enum(["GET", "POST", "PUT", "DELETE"])
            .default("POST")
            .describe("HTTP method. Milvus v2 uses POST for most operations."),
          body: z
            .record(z.string(), z.json())
            .default({})
            .describe(
              "JSON request document, e.g. {collectionName:'demo', data:[...] }.",
            ),
          database: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Database name injected as dbName in the body (MILVUS_DATABASE fallback).",
            ),
          token: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Bearer token override, formatted as username:password or an API key.",
            ),
          headers: z
            .record(z.string(), z.string())
            .default({})
            .describe("Additional HTTP headers."),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .default(30_000)
            .describe("HTTP request timeout in milliseconds."),
        }),
        annotations: unrestrictedAnnotations,
      },
      async ({
        base_url,
        path,
        method,
        body,
        database,
        token,
        headers,
        timeout_ms,
      }) => {
        try {
          const config = loadConfig().milvus;
          const base = (base_url ?? config.url).replace(/\/+$/, "");
          if (!base && !/^https?:\/\//i.test(path)) {
            throw new Error(
              "Connection is not configured. Set MILVUS_URL (or MILVUS_ADDRESS) or supply base_url.",
            );
          }
          const url = new URL(
            /^https?:\/\//i.test(path)
              ? path
              : `${base}/${path.replace(/^\/+/, "")}`,
          );

          const payload: Record<string, unknown> = { ...body };
          const dbName = database ?? config.database;
          if (dbName && payload["dbName"] === undefined) {
            payload["dbName"] = dbName;
          }

          const requestHeaders = new Headers({
            "content-type": "application/json",
            accept: "application/json",
          });
          const bearer = token ?? config.token;
          if (bearer) {
            requestHeaders.set("authorization", `Bearer ${bearer}`);
          }
          for (const [key, value] of Object.entries(headers)) {
            requestHeaders.set(key, value);
          }

          const response = await fetch(url, {
            method,
            headers: requestHeaders,
            body: method === "GET" ? undefined : JSON.stringify(payload),
            signal: AbortSignal.timeout(timeout_ms),
          });
          const text = await response.text();
          let data: unknown = text;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          const milvusError =
            typeof data === "object" &&
            data !== null &&
            "code" in data &&
            typeof data.code === "number" &&
            (data as { code: number }).code !== 0;
          const result = operationResult({
            status_code: response.status,
            data,
          });
          return !response.ok || milvusError
            ? { ...result, isError: true }
            : result;
        } catch (error) {
          return operationError(TOOL_NAMES.milvusTool, error);
        }
      },
    );
  },
};
