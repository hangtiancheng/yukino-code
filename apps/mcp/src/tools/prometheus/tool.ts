import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import {
  operationError,
  operationResult,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";
import {
  buildHttpPassthroughSchema,
  runHttpPassthrough,
} from "@/tools/operations/http.js";

export const prometheusModule: ToolModule = {
  name: "prometheus",
  register(server) {
    server.registerTool(
      TOOL_NAMES.prometheusTool,
      {
        title: "Prometheus",
        description:
          "Call any Prometheus HTTP endpoint and method. Defaults to /api/v1/alerts; use /api/v1/query or query_range for PromQL, /api/v1/targets, rules, labels, label/{name}/values, series or metadata for inspection, and admin/tsdb endpoints or /-/reload for administration. params encodes query parameters (arrays repeat the key, e.g. match[]); body accepts raw form text or JSON. Returns full JSON responses including labels/annotations, or text for non-JSON endpoints. No endpoint/method restrictions. Uses PROMETHEUS_BASE_URL (PROMETHEUS_URL fallback) or base_url; supports bearer/basic authentication and custom headers.",
        inputSchema: buildHttpPassthroughSchema({
          defaultPath: "/api/v1/alerts",
          pathDescription: "HTTP endpoint path or absolute URL.",
          baseUrlDescription:
            "Prometheus server base URL override, including an optional reverse-proxy prefix.",
          paramsDescription:
            "Query parameters, e.g. {query: 'up', time: 1700000000} or {'match[]': ['up', 'process_cpu_seconds_total']}.",
          bodyDescription:
            "JSON body, or a string sent verbatim for form-encoded requests. Set content-type through headers when using raw text.",
        }),
        annotations: unrestrictedAnnotations,
      },
      async ({ base_url, path, method, params, body, headers, timeout_ms }) => {
        try {
          const config = loadConfig().prometheus;
          const { status_code, data, isError } = await runHttpPassthrough({
            configuredBaseUrl: config.baseUrl,
            envName: "PROMETHEUS_BASE_URL",
            auth: {
              token: config.token,
              username: config.username,
              password: config.password,
            },
            request: {
              baseUrl: base_url,
              path,
              method,
              params,
              body,
              headers,
              timeoutMs: timeout_ms,
            },
            isApiError: (payload) =>
              typeof payload === "object" &&
              payload !== null &&
              "status" in payload &&
              (payload as { status: unknown }).status === "error",
          });
          const result = operationResult({ status_code, data });
          return isError ? { ...result, isError: true } : result;
        } catch (error) {
          return operationError(TOOL_NAMES.prometheusTool, error);
        }
      },
    );
  },
};
