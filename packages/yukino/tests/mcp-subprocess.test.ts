import { describe, expect, it } from "vitest";

import { MCPManager } from "@/mcp/manager.js";
import { MCPResourcesTool, MCPReadResourceTool } from "@/mcp/resources.js";
import { ToolRegistry } from "@/tools/registry.js";

const server = `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let changed = false;
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, serverInfo: { name: 'offline-fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: changed ? 'updated' : 'read', description: 'offline mock', inputSchema: { type: 'object', properties: {} } }] };
  else if (message.method === 'resources/list') result = { resources: [{ name: 'offline', uri: 'docs://offline' }] };
  else if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ name: 'doc', uriTemplate: 'docs://{id}' }] };
  else if (message.method === 'resources/read') result = { contents: [{ uri: message.params.uri, text: 'offline text', mimeType: 'text/plain' }] };
  else if (message.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'mock result' }], structuredContent: { success: true } };
    changed = true;
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
  } else result = {};
  send({ jsonrpc: '2.0', id: message.id, result });
});
`;

describe("offline SDK stdio subprocess", () => {
  it("handshakes, reads resources, preserves raw content, handles notifications, and cleans up", async () => {
    const registry = new ToolRegistry();
    const manager = new MCPManager({ registry });
    registry.register(new MCPResourcesTool(manager));
    registry.register(
      new MCPReadResourceTool(manager, {
        create: () =>
          Promise.reject(
            new Error("Artifacts not used by this raw client fixture"),
          ),
      }),
    );
    try {
      const result = await manager.connectAll([
        {
          name: "offline",
          command: process.execPath,
          args: ["--input-type=module", "-e", server],
          exposure: "direct",
        },
      ]);
      expect(result.errors).toEqual([]);
      const client = manager.getClient("offline");
      if (!client) {
        throw new Error("Fixture connection missing");
      }
      expect((await client.listResources())[0].uri).toBe("docs://offline");
      expect((await client.listResourceTemplates())[0].uriTemplate).toBe(
        "docs://{id}",
      );
      expect(
        (await client.readResource("docs://offline")).contents[0],
      ).toMatchObject({ text: "offline text" });
      const generation = manager.generation;
      const changed = new Promise<void>((resolve) => {
        const unsubscribe = manager.subscribe(() => {
          if (registry.get("mcp__offline__updated")) {
            unsubscribe();
            resolve();
          }
        });
      });
      const called = await client.callTool("read", {});
      expect(called.structuredContent).toEqual({ success: true });
      expect(called.mcpResult.content).toEqual([
        { type: "text", text: "mock result" },
      ]);
      await changed;
      expect(manager.generation).toBeGreaterThan(generation);
      expect(registry.get("mcp__offline__read")).toBeUndefined();
    } finally {
      await manager.disconnectAll();
      await registry.dispose();
    }
    expect(manager.connectedServers()).toEqual([]);
    await expect(manager.disconnectAll()).resolves.toBeUndefined();
  }, 10_000);
});
