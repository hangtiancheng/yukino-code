import { z } from "zod";

/**
 * Shared "authenticated HTTP passthrough" plumbing used by the Prometheus and
 * Grafana tools. Both expose an unrestricted generic HTTP endpoint: the caller
 * picks the path, method, query parameters, body and headers, and this helper
 * resolves the base URL, applies configured bearer/basic authentication, sends
 * the request and normalizes the response. It deliberately has no endpoint
 * allowlist; server-side privileges still govern what succeeds.
 */

export const httpParameterSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

export type HttpParamValue = z.infer<typeof httpParameterSchema>;
export type HttpParams = Record<string, HttpParamValue | HttpParamValue[]>;

export interface HttpPassthroughAuth {
  token: string;
  username: string;
  password: string;
}

export interface HttpPassthroughRequest {
  baseUrl?: string;
  path: string;
  method: string;
  params: HttpParams;
  body?: unknown;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface HttpPassthroughOutcome {
  status_code: number;
  data: unknown;
  isError: boolean;
}

/**
 * Build the common input schema for an HTTP-passthrough tool. The per-tool
 * differences are the default path and the field descriptions.
 */
export function buildHttpPassthroughSchema(options: {
  defaultPath: string;
  pathDescription: string;
  baseUrlDescription: string;
  paramsDescription: string;
  bodyDescription: string;
}) {
  return z.object({
    base_url: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(options.baseUrlDescription),
    path: z
      .string()
      .min(1)
      .default(options.defaultPath)
      .describe(options.pathDescription),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      .default("GET"),
    params: z
      .record(
        z.string(),
        z.union([httpParameterSchema, z.array(httpParameterSchema)]),
      )
      .default({})
      .describe(options.paramsDescription),
    body: z.json().optional().describe(options.bodyDescription),
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
  });
}

/**
 * Execute one HTTP-passthrough call. Throws when no base URL is configured and
 * the path is not absolute; callers catch this and surface it as a tool error.
 * `isApiError` lets a backend flag an in-band error on an otherwise 2xx
 * response (e.g. Prometheus `status: "error"`).
 */
export async function runHttpPassthrough(options: {
  configuredBaseUrl: string;
  envName: string;
  auth: HttpPassthroughAuth;
  request: HttpPassthroughRequest;
  isApiError?: (data: unknown) => boolean;
}): Promise<HttpPassthroughOutcome> {
  const { configuredBaseUrl, envName, auth, request, isApiError } = options;
  const base = request.baseUrl ?? configuredBaseUrl;
  if (!base && !/^https?:\/\//i.test(request.path)) {
    throw new Error(
      `Connection is not configured. Set ${envName} or supply base_url.`,
    );
  }
  const url = new URL(
    /^https?:\/\//i.test(request.path)
      ? request.path
      : `${base.replace(/\/+$/, "")}/${request.path.replace(/^\/+/, "")}`,
  );
  for (const [key, value] of Object.entries(request.params)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, String(entry));
    }
  }
  const requestHeaders = new Headers();
  if (auth.token) {
    requestHeaders.set("authorization", `Bearer ${auth.token}`);
  } else if (auth.username || auth.password) {
    requestHeaders.set(
      "authorization",
      `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
    );
  }
  if (request.body !== undefined && typeof request.body !== "string") {
    requestHeaders.set("content-type", "application/json");
  }
  for (const [key, value] of Object.entries(request.headers)) {
    requestHeaders.set(key, value);
  }
  const response = await fetch(url, {
    method: request.method,
    headers: requestHeaders,
    ...(request.body === undefined
      ? {}
      : {
          body:
            typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body),
        }),
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  const apiError = isApiError ? isApiError(data) : false;
  return {
    status_code: response.status,
    data,
    isError: !response.ok || apiError,
  };
}
