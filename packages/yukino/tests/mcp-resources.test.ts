import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MCP_RESOURCE_MAX_BYTES,
  MCP_RESOURCE_PREVIEW_BYTES,
} from "@/mcp/constants.js";
import {
  DirectoryMCPArtifactStore,
  previewMCPResource,
} from "@/mcp/resources.js";

describe("safe MCP resource artifacts", () => {
  it("preserves full text/blob content in private host paths with provenance and bounded previews", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "yukino-mcp-resource-"),
    );
    try {
      const store = new DirectoryMCPArtifactStore(directory);
      const text = "hello".repeat(MCP_RESOURCE_PREVIEW_BYTES);
      const binary = Buffer.from([0, 1, 2, 255]);
      const result = await previewMCPResource(
        "server",
        {
          contents: [
            { uri: "file:///../../do-not-write", text, mimeType: "text/plain" },
            {
              uri: "blob://source",
              blob: binary.toString("base64"),
              mimeType: "application/octet-stream",
            },
          ],
        },
        store,
      );
      expect(result.output.length).toBeLessThan(
        MCP_RESOURCE_PREVIEW_BYTES + 1024,
      );
      expect(result.output).toContain("preview truncated");
      expect(result.resourceArtifacts).toHaveLength(2);
      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      for (const artifact of result.resourceArtifacts) {
        expect(artifact.id).not.toContain("/");
        expect(
          (await stat(path.join(directory, artifact.id))).mode & 0o777,
        ).toBe(0o600);
      }
      expect(
        await readFile(
          path.join(directory, result.resourceArtifacts[0].id),
          "utf8",
        ),
      ).toBe(text);
      expect(
        await readFile(path.join(directory, result.resourceArtifacts[1].id)),
      ).toEqual(binary);
      expect(result.resourceArtifacts[0].uri).toBe(
        "file:///../../do-not-write",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects Apps, invalid base64, oversized responses and pre-aborted reads before creating artifacts", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "yukino-mcp-resource-"),
    );
    try {
      const store = new DirectoryMCPArtifactStore(directory);
      await expect(
        previewMCPResource(
          "server",
          { contents: [{ uri: "ui://app", text: "<script>bad</script>" }] },
          store,
        ),
      ).rejects.toThrow("Apps");
      await expect(
        previewMCPResource(
          "server",
          { contents: [{ uri: "blob://source", blob: "not base64" }] },
          store,
        ),
      ).rejects.toThrow("blob");
      await expect(
        previewMCPResource(
          "server",
          {
            contents: [
              {
                uri: "text://source",
                text: "x".repeat(MCP_RESOURCE_MAX_BYTES + 1),
              },
            ],
          },
          store,
        ),
      ).rejects.toThrow("byte limit");
      const controller = new AbortController();
      controller.abort();
      await expect(
        previewMCPResource(
          "server",
          { contents: [{ uri: "text://source", text: "safe" }] },
          store,
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
