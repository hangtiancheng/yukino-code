import { describe, it, expect } from "vitest";

import { removeMcpTools } from "@/bootstrap/tool-registry.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

function stubTool(name: string, deferred = false): Tool {
  return {
    name,
    description: name,
    category: "read",
    deferred,
    schema: () => ({
      name,
      description: "",
      input_schema: { type: "object", properties: {} },
    }),
    execute: () => Promise.resolve({ output: "ok", isError: false }),
  };
}

// unregister backs /mcp reload: reconnecting replaces wrappers, and tools of
// servers removed from the config must disappear along with their discovery
// state — a re-registered tool has to start deferred again.
describe("ToolRegistry.unregister", () => {
  it("removes the tool", () => {
    const registry = new ToolRegistry();
    registry.register(stubTool("Echo"));
    registry.unregister("Echo");
    expect(registry.get("Echo")).toBeUndefined();
    expect(registry.listTools()).toEqual([]);
  });

  it("forgets the discovery state so a re-registered tool starts deferred again", () => {
    const registry = new ToolRegistry();
    registry.register(stubTool("mcp__srv__tool", true));
    registry.markDiscovered("mcp__srv__tool");
    expect(registry.isDiscovered("mcp__srv__tool")).toBe(true);

    registry.unregister("mcp__srv__tool");
    registry.register(stubTool("mcp__srv__tool", true));
    expect(registry.isDiscovered("mcp__srv__tool")).toBe(false);
    expect(registry.getDeferredToolNames()).toEqual(["mcp__srv__tool"]);
  });

  it("is a no-op for unknown names", () => {
    const registry = new ToolRegistry();
    registry.register(stubTool("Echo"));
    registry.unregister("Nope");
    expect(registry.get("Echo")).toBeDefined();
  });
});

describe("removeMcpTools", () => {
  it("removes only tools with the mcp__ prefix", () => {
    const registry = new ToolRegistry();
    registry.register(stubTool("ReadFile"));
    registry.register(stubTool("mcp__srv__a", true));
    registry.register(stubTool("mcp__other__b", true));

    removeMcpTools(registry);

    expect(registry.listTools().map((t) => t.name)).toEqual(["ReadFile"]);
  });

  it("can remove only wrappers belonging to changed servers", () => {
    const registry = new ToolRegistry();
    registry.register(
      Object.assign(stubTool("mcp__keep__a", true), { mcpServerName: "keep" }),
    );
    registry.register(
      Object.assign(stubTool("mcp__restart__b", true), {
        mcpServerName: "restart",
      }),
    );

    removeMcpTools(registry, new Set(["restart"]));

    expect(registry.listTools().map((tool) => tool.name)).toEqual([
      "mcp__keep__a",
    ]);
  });
});
