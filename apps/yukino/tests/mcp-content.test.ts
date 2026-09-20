/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, it, expect } from "vitest";

import { expandMcpServerConfigEnvironment, mcpContentToToolOutput } from "@/mcp/client.js";
import { isRecord } from "@/utils/index.js";

// Small buffers pass through maybeResizeAndDownsampleImage untouched (sharp is
// only consulted above the passthrough limit), so fake bytes are fine here.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA = Buffer.concat([PNG_MAGIC, Buffer.from("mcp-image")]).toString("base64");

describe("mcpContentToToolOutput", () => {
  it("keeps text-only content as a plain string fallback", async () => {
    const result = await mcpContentToToolOutput([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
    expect(result).toEqual({ output: "hello\nworld" });
  });

  it("preserves text and image order in Anthropic content blocks", async () => {
    const result = await mcpContentToToolOutput([
      { type: "text", text: "screenshot below" },
      { type: "image", data: DATA, mimeType: "image/png" },
    ]);
    expect(result.output).toBe("screenshot below\n[Image: image/png]");
    expect(result.output).not.toContain(DATA);
    expect(result.contentBlocks?.[0]).toEqual({
      type: "text",
      text: "screenshot below",
    });
    expect(result.contentBlocks?.[1]?.type).toBe("image");
    const source = isRecord(result.contentBlocks?.[1]) ? result.contentBlocks[1].source : null;
    expect(isRecord(source) ? source.media_type : null).toBe("image/png");
    expect(isRecord(source) ? source.data : null).toBe(DATA);
  });

  it("keeps an image-only fallback separate from its rich block", async () => {
    const result = await mcpContentToToolOutput([
      { type: "image", data: DATA, mimeType: "image/png" },
    ]);
    expect(result.output).toBe("[Image: image/png]");
    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks?.[0]?.type).toBe("image");
  });

  it("keeps unsupported mime types in the JSON text fallback", async () => {
    const result = await mcpContentToToolOutput([
      { type: "image", data: DATA, mimeType: "image/tiff" },
    ]);
    expect(result.contentBlocks).toBeUndefined();
    expect(result.output).toBe("[Unsupported image: image/tiff]");
    expect(result.output).not.toContain(DATA);
  });
});

describe("expandMcpServerConfigEnvironment", () => {
  it("expands command, args, env, URL and headers without mutating the environment", () => {
    const environment = { BIN: "/opt/mcp", TOKEN: "secret" };
    const original = { ...environment };
    expect(
      expandMcpServerConfigEnvironment(
        {
          name: "server",
          command: "${BIN}/server",
          args: ["--token", "$TOKEN", "${MODE:-safe}"],
          env: { AUTH: "Bearer ${TOKEN}" },
          url: "https://${HOST:-example.com}/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
        environment,
      ),
    ).toEqual({
      name: "server",
      command: "/opt/mcp/server",
      args: ["--token", "secret", "safe"],
      env: { AUTH: "Bearer secret" },
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
    });
    expect(environment).toEqual(original);
  });

  it("rejects an unset variable without a default", () => {
    expect(() =>
      expandMcpServerConfigEnvironment({ name: "server", command: "${MISSING}" }, {}),
    ).toThrow(/MISSING/);
  });
});
