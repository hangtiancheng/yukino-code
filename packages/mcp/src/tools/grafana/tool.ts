import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import {
  buildHttpPassthroughSchema,
  runHttpPassthrough,
} from "@/tools/operations/http.js";
import {
  operationError,
  operationResult,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";
import type { ToolModule } from "@/tools/types.js";

export const grafanaModule: ToolModule = {
  name: "grafana",
  register(server) {
    server.registerTool(
      TOOL_NAMES.grafanaTool,
      {
        title: "Grafana",
        description:
          "Call any Grafana HTTP API endpoint and method. Defaults to /api/health. Use /api/search to list dashboards and folders, /api/dashboards/uid/{uid} to fetch a dashboard (GET) or save one (POST with a dashboard model), /api/folders, /api/datasources and /api/datasources/{id} for provisioning, /api/ds/query to run proxied datasource queries, /api/annotations, /api/ruler/grafana/api/v1/rules and /api/v1/provisioning/* for alerting, and /api/admin, /api/org, /api/users, /api/serviceaccounts for administration. params encodes query parameters (arrays repeat the key); body accepts JSON (dashboard models, ds/query payloads) or a raw string sent verbatim. Returns full JSON responses, or text for non-JSON endpoints. No endpoint/method restrictions; Grafana RBAC and the credential's role still govern what succeeds. Uses GRAFANA_BASE_URL (GRAFANA_URL fallback) or base_url; supports bearer authentication (service-account token or API key) or basic authentication, plus custom headers such as X-Grafana-Org-Id.",
        inputSchema: buildHttpPassthroughSchema({
          defaultPath: "/api/health",
          pathDescription:
            "Grafana HTTP API path or absolute URL, e.g. /api/search or /api/dashboards/uid/abc123.",
          baseUrlDescription:
            "Grafana base URL override, including an optional reverse-proxy prefix.",
          paramsDescription:
            "Query parameters, e.g. {query: 'my-dashboard'} for /api/search or {from: 'now-6h', to: 'now'}.",
          bodyDescription:
            "JSON body for POST/PUT APIs (dashboard models, /api/ds/query requests, annotations), or a string sent verbatim. Set content-type through headers when using raw text.",
        }),
        annotations: unrestrictedAnnotations,
      },
      async ({ base_url, path, method, params, body, headers, timeout_ms }) => {
        try {
          const config = loadConfig().grafana;
          const { status_code, data, isError } = await runHttpPassthrough({
            configuredBaseUrl: config.baseUrl,
            envName: "GRAFANA_BASE_URL",
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
          });
          const result = operationResult({ status_code, data });
          return isError ? { ...result, isError: true } : result;
        } catch (error) {
          return operationError(TOOL_NAMES.grafanaTool, error);
        }
      },
    );
  },
};
