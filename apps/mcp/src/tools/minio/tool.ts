import { readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";
import {
  operationError,
  operationResult,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";
import { buildCanonicalUri, signRequest } from "./s3.js";
import { fetchS3 } from "./http.js";

const TEXT_SUBTYPE =
  /(^|\/)(xml|json|javascript|html|x-www-form-urlencoded)([;+]|$)/i;

function isTextual(contentType: string | null, buffer: Buffer): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.startsWith("text/")) return true;
    return TEXT_SUBTYPE.test(ct);
  }
  // No content type: treat as text when it decodes cleanly as UTF-8.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export const minioModule: ToolModule = {
  name: "minio",
  register(server) {
    server.registerTool(
      TOOL_NAMES.minioTool,
      {
        title: "MinIO / S3",
        description:
          "Call any S3-compatible (MinIO) REST operation with full account privileges: list buckets, list/create/delete buckets, get/put/head/delete objects, multipart upload, versioning, policies, lifecycle and other subresources. There is no operation allowlist. Requests are signed with AWS Signature V4 (path-style). Set method plus optional bucket, key, query subresource params (e.g. {location:''}, {uploads:''}, {'list-type':2, prefix:'a/'}, {partNumber:1, uploadId:'...'}, {delete:''}), headers and a body. The body may be a UTF-8 string (XML/JSON), base64 (body_base64) or a local file (body_path). Responses return status_code, headers, size and the body as text (XML/JSON) or base64; large or binary bodies can be written to save_path instead. Uses MINIO_URL (S3_ENDPOINT fallback), MINIO_ACCESS_KEY/MINIO_SECRET_KEY (AWS_* fallback) and MINIO_REGION, or per-call endpoint/region.",
        inputSchema: {
          endpoint: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "S3 endpoint origin override, e.g. http://localhost:9000.",
            ),
          region: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Signing region override (default us-east-1)."),
          method: z
            .enum(["GET", "PUT", "POST", "DELETE", "HEAD", "PATCH"])
            .default("GET"),
          bucket: z
            .string()
            .trim()
            .optional()
            .describe(
              "Target bucket. Omit for the service-level ListBuckets call.",
            ),
          key: z
            .string()
            .optional()
            .describe("Object key, including any '/' path segments."),
          query: z
            .record(
              z.string(),
              z.union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.union([z.string(), z.number()])),
              ]),
            )
            .default({})
            .describe(
              "Query/subresource parameters. Use an empty string for valueless subresources such as location, uploads, versioning or delete.",
            ),
          headers: z
            .record(z.string(), z.string())
            .default({})
            .describe(
              "Additional request headers, e.g. content-type or x-amz-* headers.",
            ),
          body: z
            .string()
            .optional()
            .describe(
              "UTF-8 request body (XML/JSON/text). Ignored when body_base64 or body_path is set.",
            ),
          body_base64: z
            .string()
            .optional()
            .describe("Base64-encoded binary request body."),
          body_path: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Local file whose bytes are uploaded as the request body.",
            ),
          unsigned_payload: z
            .boolean()
            .default(false)
            .describe(
              "Sign with UNSIGNED-PAYLOAD instead of hashing the body.",
            ),
          response_format: z
            .enum(["auto", "text", "base64", "none"])
            .default("auto")
            .describe(
              "How to return the response body. auto returns text for XML/JSON and base64 otherwise.",
            ),
          max_bytes: z
            .number()
            .int()
            .positive()
            .default(1_000_000)
            .describe("Maximum inline response bytes before truncation."),
          save_path: z
            .string()
            .min(1)
            .optional()
            .describe("Write the full response body to this local file path."),
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
          const config = loadConfig().minio;
          const endpoint = (input.endpoint ?? config.endpoint).replace(
            /\/+$/,
            "",
          );
          if (!endpoint) {
            throw new Error(
              "Connection is not configured. Set MINIO_URL (or S3_ENDPOINT) or supply endpoint.",
            );
          }
          const accessKey = config.accessKey;
          const secretKey = config.secretKey;
          if (!accessKey || !secretKey) {
            throw new Error(
              "Credentials are not configured. Set MINIO_ACCESS_KEY and MINIO_SECRET_KEY (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).",
            );
          }

          let payload = Buffer.alloc(0);
          if (input.body_path) {
            payload = await readFile(input.body_path);
          } else if (input.body_base64) {
            payload = Buffer.from(input.body_base64, "base64");
          } else if (input.body !== undefined) {
            payload = Buffer.from(input.body, "utf8");
          }

          const canonicalUri = buildCanonicalUri({
            bucket: input.bucket,
            key: input.key,
          });
          const signed = signRequest({
            method: input.method,
            endpoint,
            canonicalUri,
            query: input.query,
            headers: input.headers,
            payload,
            unsignedPayload: input.unsigned_payload,
            credentials: {
              accessKey,
              secretKey,
              region: input.region ?? config.region,
              sessionToken: config.sessionToken || undefined,
            },
          });

          const response = await fetchS3(signed.url, {
            method: input.method,
            headers: signed.headers,
            ...(input.method === "GET" ||
            input.method === "HEAD" ||
            payload.length === 0
              ? {}
              : { body: payload }),
            signal: AbortSignal.timeout(input.timeout_ms),
          });

          const raw = Buffer.from(await response.arrayBuffer());
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          const contentType = response.headers.get("content-type");
          const result: Record<string, unknown> = {
            status_code: response.status,
            headers,
            size: raw.length,
          };

          if (input.save_path) {
            await writeFile(input.save_path, raw);
            result["saved_to"] = input.save_path;
            result["saved_bytes"] = raw.length;
          }

          const format = input.response_format;
          const textual =
            format === "text" ||
            (format === "auto" && isTextual(contentType, raw));
          if (format !== "none") {
            const truncated = raw.length > input.max_bytes;
            const slice = truncated ? raw.subarray(0, input.max_bytes) : raw;
            // Textual bodies (XML/JSON/errors) are always inlined so they stay
            // visible even when also written to save_path. Binary bodies are
            // inlined only when explicitly requested, or when there is no
            // save_path to fall back on.
            if (textual) {
              result["body"] = slice.toString("utf8");
              if (truncated) result["truncated"] = true;
            } else if (
              format === "base64" ||
              (format === "auto" && !input.save_path)
            ) {
              result["body_base64"] = slice.toString("base64");
              if (truncated) result["truncated"] = true;
            }
          }

          const callResult = operationResult(result);
          return response.ok ? callResult : { ...callResult, isError: true };
        } catch (error) {
          return operationError(TOOL_NAMES.minioTool, error);
        }
      },
    );
  },
};
