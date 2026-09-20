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

import { rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CREATED_APP_RESOURCE_URI, createAppModule } from "@/tools/create-app/tool.js";

// The SDK types these results loosely (index signatures, text/blob unions), so
// narrow them with zod before asserting on specific fields.
const ToolSchema = z.looseObject({
  name: z.string(),
  annotations: z.looseObject({ openWorldHint: z.boolean() }),
  _meta: z.looseObject({
    ui: z.looseObject({ resourceUri: z.string() }),
  }),
});

const TextResourceContentsSchema = z.looseObject({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string(),
});

const CallToolResultSchema = z.looseObject({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
  content: z
    .array(
      z.looseObject({
        type: z.literal("text"),
        text: z.string(),
      }),
    )
    .optional(),
});

const builtAppPath = fileURLToPath(new URL("../../dist/create-app.html", import.meta.url));
const hiddenAppPath = `${builtAppPath}.test-hidden`;

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  createAppModule.register(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(clientTransport);
  await client.connect(serverTransport);
  return client;
}

describe("create_app", () => {
  it("exposes an app tool linked to the UI resource", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "create_app");
    expect(tool).toBeDefined();
    const parsed = ToolSchema.parse(tool);
    // registerAppTool also mirrors the URI under the flat "ui/resourceUri" key.
    expect(parsed._meta.ui.resourceUri).toBe(CREATED_APP_RESOURCE_URI);
    expect(parsed.annotations.openWorldHint).toBe(true);
  });

  it("serves the bundled UI shell resource with the MCP Apps mime type", async () => {
    const client = await connect();
    const result = await client.readResource({ uri: CREATED_APP_RESOURCE_URI });
    const content = TextResourceContentsSchema.parse(result.contents[0]);
    expect(content.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(content.text).toContain('id="root"');
    expect(content.text).not.toContain("create-app.tsx");
  });

  it("fails when the bundled UI shell is missing", async () => {
    await rename(builtAppPath, hiddenAppPath);
    try {
      const client = await connect();
      await expect(client.readResource({ uri: CREATED_APP_RESOURCE_URI })).rejects.toThrow();
    } finally {
      await rename(hiddenAppPath, builtAppPath);
    }
  });

  it("keeps HTML in app-only metadata with a text fallback", async () => {
    const client = await connect();
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "create_app",
        arguments: { html: "<p>hello</p>", title: "Greeting" },
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ title: "Greeting" });
    expect(result._meta).toEqual({ html: "<p>hello</p>", title: "Greeting" });
    const text = result.content?.[0];
    expect(text?.type).toBe("text");
    expect(text?.text).toContain("Greeting");
  });

  it("defaults the title when omitted", async () => {
    const client = await connect();
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "create_app",
        arguments: { html: "<p>hello</p>" },
      }),
    );
    expect(result.structuredContent).toMatchObject({ title: "MCP App" });
  });

  it("rejects oversized html documents", async () => {
    const client = await connect();
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "create_app",
        arguments: { html: "x".repeat(200_001) },
      }),
    );
    expect(result.isError).toBe(true);
  });
});
