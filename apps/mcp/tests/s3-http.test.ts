import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { fetchS3 } from "@/tools/minio/http.js";
import { buildCanonicalUri, signRequest } from "@/tools/minio/s3.js";

describe("S3 HTTP transport", () => {
  it.each(["a/../file", "./file", "a/./file", "a//b"])(
    "preserves the signed object key %s",
    async (key) => {
      let receivedUrl = "";
      const server = createServer((req, res) => {
        receivedUrl = req.url!;
        res.end("object bytes");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const signed = signRequest({
          endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          method: "PUT",
          canonicalUri: buildCanonicalUri({ bucket: "data", key }),
          query: { versionId: "a+b" },
          payload: Buffer.from("upload"),
          credentials: { accessKey: "a", secretKey: "b", region: "us-east-1" },
        });
        const response = await fetchS3(signed.url, {
          method: "PUT",
          headers: signed.headers,
          body: Buffer.from("upload"),
          signal: AbortSignal.timeout(1000),
        });
        expect(await response.text()).toBe("object bytes");
        expect(receivedUrl).toBe(`/data/${key}?versionId=a%2Bb`);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
