import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import {
  operationError,
  operationResult,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";

const parameter = z.union([z.string(), z.number(), z.boolean()]);

export const prometheusModule: ToolModule = {
  name: "prometheus",
  register(server) {
    server.registerTool(
      TOOL_NAMES.prometheusTool,
      {
        title: "Prometheus",
        description:
          "Call any Prometheus HTTP endpoint and method. Defaults to /api/v1/alerts; use /api/v1/query or query_range for PromQL, /api/v1/targets, rules, labels, label/{name}/values, series or metadata for inspection, and admin/tsdb endpoints or /-/reload for administration. params encodes query parameters (arrays repeat the key, e.g. match[]); body accepts raw form text or JSON. Returns full JSON responses including labels/annotations, or text for non-JSON endpoints. No endpoint/method restrictions. Uses PROMETHEUS_BASE_URL (PROMETHEUS_URL fallback) or base_url; supports bearer/basic authentication and custom headers.",
        inputSchema: {
          base_url: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Prometheus server base URL override, including an optional reverse-proxy prefix.",
            ),
          path: z
            .string()
            .min(1)
            .default("/api/v1/alerts")
            .describe("HTTP endpoint path or absolute URL."),
          method: z
            .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
            .default("GET"),
          params: z
            .record(z.string(), z.union([parameter, z.array(parameter)]))
            .default({})
            .describe(
              "Query parameters, e.g. {query: 'up', time: 1700000000} or {'match[]': ['up', 'process_cpu_seconds_total']}.",
            ),
          body: z
            .json()
            .optional()
            .describe(
              "JSON body, or a string sent verbatim for form-encoded requests. Set content-type through headers when using raw text.",
            ),
          headers: z
            .record(z.string(), z.string())
            .default({})
            .describe(
              "Additional HTTP headers; override configured authentication if needed.",
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
      async ({ base_url, path, method, params, body, headers, timeout_ms }) => {
        try {
          const config = loadConfig().prometheus;
          const base = base_url ?? config.baseUrl;
          if (!base && !/^https?:\/\//i.test(path)) {
            throw new Error(
              "Connection is not configured. Set PROMETHEUS_BASE_URL or supply base_url.",
            );
          }
          const url = new URL(
            /^https?:\/\//i.test(path)
              ? path
              : `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
          );
          for (const [key, value] of Object.entries(params)) {
            for (const entry of Array.isArray(value) ? value : [value]) {
              url.searchParams.append(key, String(entry));
            }
          }
          const requestHeaders = new Headers();
          if (config.token)
            requestHeaders.set("authorization", `Bearer ${config.token}`);
          else if (config.username || config.password) {
            requestHeaders.set(
              "authorization",
              `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
            );
          }
          if (body !== undefined && typeof body !== "string")
            requestHeaders.set("content-type", "application/json");
          for (const [key, value] of Object.entries(headers))
            requestHeaders.set(key, value);
          const response = await fetch(url, {
            method,
            headers: requestHeaders,
            ...(body === undefined
              ? {}
              : {
                  body: typeof body === "string" ? body : JSON.stringify(body),
                }),
            signal: AbortSignal.timeout(timeout_ms),
          });
          const text = await response.text();
          let data: unknown = text;
          try {
            data = JSON.parse(text);
          } catch {
            /* Management/metrics endpoints may return text or an empty body. */
          }
          const apiError =
            typeof data === "object" &&
            data !== null &&
            "status" in data &&
            data.status === "error";
          const result = operationResult({
            status_code: response.status,
            data,
          });
          return !response.ok || apiError
            ? { ...result, isError: true }
            : result;
        } catch (error) {
          return operationError(TOOL_NAMES.prometheusTool, error);
        }
      },
    );
  },
};
