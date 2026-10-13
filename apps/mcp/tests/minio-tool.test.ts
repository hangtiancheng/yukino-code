import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { minioModule } from "@/tools/minio/tool.js";
import {
  buildCanonicalQuery,
  buildCanonicalUri,
  rfc3986Encode,
  signRequest,
} from "@/tools/minio/s3.js";
import { firstText, isolateEnv, stubFetchRoutes } from "./helpers.js";

const envKeys = [
  "MINIO_URL",
  "S3_ENDPOINT",
  "MINIO_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "MINIO_SECRET_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "MINIO_REGION",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "MINIO_SESSION_TOKEN",
  "AWS_SESSION_TOKEN",
];
isolateEnv(envKeys);

const resultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

let client: Client;
async function call(args: Record<string, unknown> = {}) {
  return resultSchema.parse(
    await client.callTool({ name: "minio_tool", arguments: args }),
  );
}

beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  process.env["MINIO_URL"] = "http://localhost:9000";
  process.env["MINIO_ACCESS_KEY"] = "admin";
  process.env["MINIO_SECRET_KEY"] = "12345678";
  const server = new McpServer({ name: "test", version: "1" });
  minioModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterEach(async () => {
  await client.close();
});

describe("S3 SigV4 helpers", () => {
  it("RFC 3986 encodes reserved and unicode characters", () => {
    expect(rfc3986Encode("a b")).toBe("a%20b");
    expect(rfc3986Encode("a+b")).toBe("a%2Bb");
    expect(rfc3986Encode("a/b")).toBe("a%2Fb");
    expect(rfc3986Encode("file!name*'()")).toBe("file%21name%2A%27%28%29");
    expect(rfc3986Encode("ключ")).toBe(encodeURIComponent("ключ"));
  });

  it("builds path-style canonical URIs preserving key slashes", () => {
    expect(buildCanonicalUri({})).toBe("/");
    expect(buildCanonicalUri({ bucket: "data" })).toBe("/data");
    expect(buildCanonicalUri({ bucket: "data", key: "a/b c.txt" })).toBe(
      "/data/a/b%20c.txt",
    );
    expect(buildCanonicalUri({ key: "solo/key" })).toBe("/solo/key");
  });

  it("sorts and encodes the canonical query string", () => {
    expect(
      buildCanonicalQuery({ b: "2", a: "1", "list-type": 2, prefix: "x/" }),
    ).toBe("a=1&b=2&list-type=2&prefix=x%2F");
    // Duplicate keys are sorted by value per the SigV4 canonical-query rules.
    expect(buildCanonicalQuery({ "match[]": ["up", "down"] })).toBe(
      "match%5B%5D=down&match%5B%5D=up",
    );
    expect(buildCanonicalQuery({ delete: "" })).toBe("delete=");
  });

  it("produces deterministic, input-sensitive signatures", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const base = {
      method: "GET",
      endpoint: "http://localhost:9000",
      canonicalUri: "/bucket/key.txt",
      credentials: {
        accessKey: "admin",
        secretKey: "12345678",
        region: "us-east-1",
      },
      now,
    };
    const a = signRequest(base);
    const b = signRequest(base);
    expect(a.headers["authorization"]).toBe(b.headers["authorization"]);
    expect(a.headers["x-amz-date"]).toBe("20260102T030405Z");
    expect(a.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("").digest("hex"),
    );
    expect(a.headers["authorization"]).toContain(
      "Credential=admin/20260102/us-east-1/s3/aws4_request",
    );
    expect(a.headers["authorization"]).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date",
    );
    expect(a.url).toBe("http://localhost:9000/bucket/key.txt");

    const differentSecret = signRequest({
      ...base,
      credentials: { ...base.credentials, secretKey: "other" },
    });
    expect(differentSecret.headers["authorization"]).not.toBe(
      a.headers["authorization"],
    );

    const withPayload = signRequest({ ...base, payload: Buffer.from("hello") });
    expect(withPayload.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("hello").digest("hex"),
    );
    expect(withPayload.headers["authorization"]).not.toBe(
      a.headers["authorization"],
    );

    const unsigned = signRequest({ ...base, unsignedPayload: true });
    expect(unsigned.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  });

  it("includes the session token in the signed headers when present", () => {
    const signed = signRequest({
      method: "GET",
      endpoint: "http://localhost:9000",
      canonicalUri: "/",
      credentials: {
        accessKey: "a",
        secretKey: "b",
        region: "us-east-1",
        sessionToken: "tok",
      },
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(signed.headers["x-amz-security-token"]).toBe("tok");
    expect(signed.headers["authorization"]).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });
});

describe("minio_tool", () => {
  it("lists buckets and returns XML as text", () => {
    const xml =
      '<?xml version="1.0"?><ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>';
    const routes = stubFetchRoutes([
      { method: "GET", url: "http://localhost:9000/", text: xml },
    ]);
    return call().then((result) => {
      expect(result.isError).toBeUndefined();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc["status_code"]).toBe(200);
      expect(sc["body"]).toBe(xml);
      const last = routes.lastCall();
      expect(last.headers["authorization"]).toContain("AWS4-HMAC-SHA256");
      expect(last.headers["x-amz-content-sha256"]).toBeDefined();
    });
  });

  it("lists objects with query parameters and signs the request", async () => {
    const routes = stubFetchRoutes([
      {
        method: "GET",
        url: "http://localhost:9000/data",
        json: { dummy: true },
      },
    ]);
    const result = await call({
      bucket: "data",
      query: { "list-type": 2, prefix: "logs/" },
    });
    expect(result.isError).toBeUndefined();
    const url = new URL(routes.lastCall().url);
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("logs/");
    expect(routes.lastCall().headers["authorization"]).toContain(
      "Credential=admin/",
    );
  });

  it("uploads a string body and hashes the payload", async () => {
    const routes = stubFetchRoutes([
      { method: "PUT", url: "http://localhost:9000/data/hello.txt", text: "" },
    ]);
    const result = await call({
      method: "PUT",
      bucket: "data",
      key: "hello.txt",
      body: "hello world",
      headers: { "content-type": "text/plain" },
    });
    expect(result.isError).toBeUndefined();
    const last = routes.lastCall();
    // The body is sent as bytes; the SigV4 payload hash confirms the content.
    expect(last.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("hello world").digest("hex"),
    );
    expect(last.headers["content-type"]).toBe("text/plain");
  });

  it("uploads a local file and downloads binary to save_path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minio-tool-"));
    const upload = path.join(dir, "upload.bin");
    const download = path.join(dir, "download.bin");
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    writeFileSync(upload, bytes);
    try {
      const routes = stubFetchRoutes([
        { method: "PUT", url: "http://localhost:9000/data/blob.bin", text: "" },
        {
          method: "GET",
          url: "http://localhost:9000/data/blob.bin",
          bytes,
          headers: { "content-type": "application/octet-stream" },
        },
      ]);
      const put = await call({
        method: "PUT",
        bucket: "data",
        key: "blob.bin",
        body_path: upload,
      });
      expect(put.isError).toBeUndefined();
      // The uploaded file's bytes are hashed into the SigV4 payload header.
      expect(routes.calls[0].headers["x-amz-content-sha256"]).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );

      const get = await call({
        bucket: "data",
        key: "blob.bin",
        save_path: download,
      });
      expect(get.isError).toBeUndefined();
      const sc = get.structuredContent as Record<string, unknown>;
      expect(sc["saved_to"]).toBe(download);
      expect(sc["saved_bytes"]).toBe(bytes.length);
      expect(readFileSync(download).equals(bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inlines textual bodies even when save_path is set", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minio-text-"));
    const target = path.join(dir, "listing.xml");
    const xml = '<?xml version="1.0"?><ListBucketResult/>';
    try {
      stubFetchRoutes([
        {
          method: "GET",
          url: "http://localhost:9000/data",
          text: xml,
          headers: { "content-type": "application/xml" },
        },
      ]);
      const result = await call({ bucket: "data", save_path: target });
      expect(result.isError).toBeUndefined();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc["saved_to"]).toBe(target);
      expect(sc["body"]).toBe(xml);
      expect(readFileSync(target, "utf8")).toBe(xml);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks non-2xx responses as errors and keeps the body", async () => {
    stubFetchRoutes([
      {
        method: "GET",
        url: "http://localhost:9000/data/missing.txt",
        status: 404,
        text: "<Error><Code>NoSuchKey</Code></Error>",
        headers: { "content-type": "application/xml" },
      },
    ]);
    const result = await call({ bucket: "data", key: "missing.txt" });
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc["status_code"]).toBe(404);
    expect(String(sc["body"])).toContain("NoSuchKey");
  });

  it("reports missing configuration as an error", async () => {
    delete process.env["MINIO_URL"];
    delete process.env["MINIO_ACCESS_KEY"];
    const result = await call({ bucket: "data" });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("MINIO_URL");
  });
});
