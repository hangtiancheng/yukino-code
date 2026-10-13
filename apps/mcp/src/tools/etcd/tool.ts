import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import {
  operationError,
  operationResult,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";
import { decodeResponseBytes, encodeRequestBytes } from "./codec.js";

export const etcdModule: ToolModule = {
  name: "etcd",
  register(server) {
    server.registerTool(
      TOOL_NAMES.etcdTool,
      {
        title: "etcd",
        description:
          "Call any etcd v3 JSON-gateway endpoint with full privileges: kv range/put/deleterange/txn/compaction, lease grant/revoke/keepalive/timetolive/leases, auth authenticate/enable/role/user, cluster member add/list/remove/update, and maintenance status/defragment/alarm/hash. There is no endpoint allowlist. Keys, range ends and values are passed as plain UTF-8 strings and base64-encoded for the wire automatically; response keys/values are decoded back to strings (binary values stay base64). Set raw_base64=true to send and receive verbatim base64 instead. path defaults to /v3/kv/range; body is the JSON request document (e.g. {key:'a', range_end:'b'} or {key:'a', value:'v', lease:'0'}). Streaming endpoints (/v3/watch, /v3/maintenance/snapshot) are not supported. Uses ETCD_URL (ETCD_ENDPOINTS fallback) or base_url; pass an auth token via headers.authorization after /v3/auth/authenticate.",
        inputSchema: {
          base_url: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "etcd HTTP(S) base URL override, e.g. http://localhost:2379.",
            ),
          path: z
            .string()
            .min(1)
            .default("/v3/kv/range")
            .describe(
              "Gateway endpoint path or absolute URL, e.g. /v3/kv/put.",
            ),
          method: z
            .enum(["GET", "POST", "PUT", "DELETE"])
            .default("POST")
            .describe(
              "HTTP method. The v3 gateway uses POST for nearly all calls.",
            ),
          body: z
            .record(z.string(), z.json())
            .default({})
            .describe(
              "JSON request document. key/range_end/value strings are base64-encoded automatically unless raw_base64 is set.",
            ),
          headers: z
            .record(z.string(), z.string())
            .default({})
            .describe(
              "Additional HTTP headers, e.g. {authorization: '<token>'}.",
            ),
          raw_base64: z
            .boolean()
            .default(false)
            .describe(
              "Disable automatic base64 encoding/decoding of key/range_end/value fields.",
            ),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .default(30_000)
            .describe("HTTP request timeout in milliseconds."),
        },
        annotations: unrestrictedAnnotations,
      },
      async ({
        base_url,
        path,
        method,
        body,
        headers,
        raw_base64,
        timeout_ms,
      }) => {
        try {
          const base = (base_url ?? loadConfig().etcd.url).replace(/\/+$/, "");
          if (!base && !/^https?:\/\//i.test(path)) {
            throw new Error(
              "Connection is not configured. Set ETCD_URL (or ETCD_ENDPOINTS) or supply base_url.",
            );
          }
          const url = new URL(
            /^https?:\/\//i.test(path)
              ? path
              : `${base}/${path.replace(/^\/+/, "")}`,
          );
          const payload = raw_base64 ? body : encodeRequestBytes(body);
          const requestHeaders = new Headers({
            "content-type": "application/json",
          });
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
          if (!raw_base64) data = decodeResponseBytes(data);
          const result = operationResult({
            status_code: response.status,
            data,
          });
          return response.ok ? result : { ...result, isError: true };
        } catch (error) {
          return operationError(TOOL_NAMES.etcdTool, error);
        }
      },
    );
  },
};
