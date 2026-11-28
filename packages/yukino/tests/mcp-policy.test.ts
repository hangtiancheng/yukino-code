import { describe, expect, it, vi } from "vitest";

import { expandMcpServerConfigEnvironment, MCPClient } from "@/mcp/client.js";
import { MCPServerConfigSchema } from "@/mcp/config.js";
import type { MCPExposure } from "@/mcp/config.js";
import { resolveMCPExposure } from "@/mcp/policy.js";
import { prepareRuntimeMCPServer } from "@/mcp/registration.js";
import { applyMode } from "@/mcp/strategy.js";
import { McpCallTool } from "@/tools/mcp-call.js";
import { ToolRegistry } from "@/tools/registry.js";
import { ToolSearchTool } from "@/tools/tool-search.js";

function tool(name: string, exposure: MCPExposure) {
  return {
    name,
    description: name,
    exposure,
    category: "read" as const,
    schema: () => ({
      name,
      description: name,
      input_schema: { type: "object" as const, properties: {} },
    }),
    execute: vi.fn(() => Promise.resolve({ output: "ok", isError: false })),
    mcpServerName: "srv",
    mcpInputSchema: () => ({}),
    setDeferLoading: () => undefined,
  };
}

describe("MCP exposure and revocation", () => {
  it("has one strict user exposure schema and exact-before-first-wildcard rules", () => {
    const config = MCPServerConfigSchema.parse({
      name: "srv",
      command: "mock",
      exposure: "deferred",
      tool_exposure: [
        { tool: "*", exposure: "hidden" },
        { tool: "read*", exposure: "direct" },
        { tool: "read_one", exposure: "codemode" },
      ],
    });
    expect(resolveMCPExposure(config, "read_one")).toBe("codemode");
    expect(resolveMCPExposure(config, "read_two")).toBe("hidden");
    expect(
      MCPServerConfigSchema.safeParse({
        name: "srv",
        command: "mock",
        exposure: "eager",
      }).success,
    ).toBe(false);
    expect(
      MCPServerConfigSchema.safeParse({
        name: "srv",
        command: "mock",
        loading: "native",
      }).success,
    ).toBe(false);
    expect(
      MCPServerConfigSchema.safeParse({
        name: "srv",
        command: "mock",
        tool_exposure: [
          { tool: "read", exposure: "hidden" },
          { tool: "read", exposure: "direct" },
        ],
      }).success,
    ).toBe(false);
  });
  it("validates raw URL templates structurally and expanded endpoints before I/O", async () => {
    const raw = {
      name: "env",
      url: "${ENDPOINT}",
      env: { ENDPOINT: "https://example.invalid/mcp", VALUE: "own-secret" },
      headers: { Authorization: "Bearer ${VALUE}" },
    };
    expect(MCPServerConfigSchema.safeParse(raw).success).toBe(true);
    expect(expandMcpServerConfigEnvironment(raw, {})).toMatchObject({
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer own-secret" },
    });
    expect(
      MCPServerConfigSchema.safeParse({ ...raw, source: { scope: "global" } })
        .success,
    ).toBe(false);
    expect(prepareRuntimeMCPServer(raw)).toMatchObject({
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer own-secret" },
      inherit_env: false,
    });
    for (const url of [
      "ftp://example.invalid",
      "https://user:password@example.invalid",
      "https://example.invalid@other.invalid",
    ]) {
      expect(() =>
        prepareRuntimeMCPServer({
          name: "env",
          url: "${ENDPOINT}",
          env: { ENDPOINT: url },
        }),
      ).toThrow();
    }
    expect(() =>
      prepareRuntimeMCPServer({
        name: "unknown",
        url: "${UNKNOWN_RUNTIME_URL}",
      }),
    ).toThrow(/unset/);
    const previous = process.env.UNKNOWN_RUNTIME_URL;
    process.env.UNKNOWN_RUNTIME_URL = "https://global-secret.invalid";
    try {
      expect(() =>
        prepareRuntimeMCPServer({
          name: "global",
          url: "${UNKNOWN_RUNTIME_URL}",
        }),
      ).toThrow(/unset/);
      expect(() =>
        prepareRuntimeMCPServer({
          name: "nested",
          url: "${ENDPOINT}",
          env: { ENDPOINT: "${UNKNOWN_RUNTIME_URL}" },
        }),
      ).toThrow();
      expect(() =>
        prepareRuntimeMCPServer({
          name: "nested",
          command: "mock",
          env: { VALUE: "${UNKNOWN_RUNTIME_URL}" },
        }),
      ).toThrow();
    } finally {
      if (previous === undefined) {
        delete process.env.UNKNOWN_RUNTIME_URL;
      } else {
        process.env.UNKNOWN_RUNTIME_URL = previous;
      }
    }
    const disabled = {
      name: "disabled",
      enabled: false,
      env: { TOKEN: "${UNSET_DISABLED_SECRET}" },
    };
    expect(prepareRuntimeMCPServer(disabled).env).toEqual(disabled.env);
    expect(expandMcpServerConfigEnvironment(disabled, {}).env).toEqual(
      disabled.env,
    );
    await expect(new MCPClient(disabled).connect()).rejects.toThrow("disabled");
    expect(
      MCPServerConfigSchema.safeParse({
        name: "xor",
        command: "mock",
        url: "${ENDPOINT}",
      }).success,
    ).toBe(false);
    expect(
      MCPServerConfigSchema.safeParse({
        name: "oauth",
        url: "${ENDPOINT}",
        oauth: { issuer: "https://issuer.invalid", client_id: "id" },
        headers: { Authorization: "secret" },
      }).success,
    ).toBe(false);
  });
  it("hidden is denied at every entry, codemode requires enabled VM and cannot dispatch", async () => {
    const registry = new ToolRegistry();
    const hidden = tool("mcp__srv__hidden", "hidden");
    const vm = tool("mcp__srv__vm", "codemode");
    const deferred = tool("mcp__srv__deferred", "deferred");
    const direct = tool("mcp__srv__direct", "direct");
    for (const item of [hidden, vm, deferred, direct]) {
      registry.register(item);
    }
    applyMode(registry, "dispatch");
    for (const entry of [
      "direct",
      "dispatch",
      "codemode",
      "app",
      "resource",
    ] as const) {
      expect(registry.canInvoke(hidden.name, entry)).toBe(false);
    }
    expect(registry.canInvoke(vm.name, "codemode")).toBe(false);
    registry.setPolicy({ codeModeEnabled: true });
    expect(registry.canInvoke(vm.name, "codemode")).toBe(true);
    for (const entry of ["direct", "dispatch", "app", "resource"] as const) {
      expect(registry.canInvoke(vm.name, entry)).toBe(false);
    }
    expect(registry.getAllSchemas().map((schema) => schema.name)).toEqual([
      direct.name,
    ]);
    expect(registry.searchDeferred("srv").map((item) => item.name)).toEqual([
      deferred.name,
    ]);
    const dispatch = new McpCallTool(registry);
    for (const target of [hidden, vm]) {
      const result = await dispatch.execute(
        { cwd: "/tmp" },
        { server: "srv", tool: target.name, arguments: {} },
      );
      expect(result.isError).toBe(true);
      expect(target.execute).not.toHaveBeenCalled();
      expect(result.output.split("Available tools: ")[1]).not.toContain(
        hidden.name,
      );
    }
  });
  it("native discovery enables only selected deferred tools and keeps schemas stable", async () => {
    const registry = new ToolRegistry();
    const deferred = tool("mcp__srv__read", "deferred");
    registry.register(deferred);
    applyMode(registry, "native");
    const before = registry.getAllSchemas();
    expect(registry.canInvoke(deferred.name, "direct")).toBe(false);
    await new ToolSearchTool(registry).execute(
      { cwd: "/tmp" },
      { query: "read" },
    );
    expect(registry.canInvoke(deferred.name, "direct")).toBe(true);
    expect(registry.getAllSchemas()).toEqual(before);
    registry.setPolicy({ allowlist: [] });
    expect(registry.getAllSchemas()).toEqual([]);
    expect(registry.canInvoke(deferred.name, "dispatch")).toBe(false);
  });
  it("revokes borrowed children and stale approvals without disposing their parent", async () => {
    const parent = new ToolRegistry();
    const original = tool("mcp__srv__read", "direct");
    const dispose = vi.fn(() => Promise.resolve());
    parent.register({ ...original, dispose });
    const owned = parent.get(original.name);
    expect(owned).toBeDefined();
    const child = new ToolRegistry();
    child.copyLoadingStateFrom(parent);
    if (!owned) {
      throw new Error("Missing fixture tool");
    }
    child.registerBorrowed(owned);
    const authorization = child.captureAuthorization(original.name, "direct");
    parent.setPolicy({ denylist: [original.name], role: "readonly" });
    expect(child.validateAuthorization(authorization)).toBe(false);
    expect(child.canInvoke(original.name, "direct")).toBe(false);
    parent.unregister(original.name);
    parent.register(tool(original.name, "direct"));
    expect(child.get(original.name)).toBeUndefined();
    await child.dispose();
    expect(dispose).not.toHaveBeenCalled();
    await parent.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it("rejects collisions and failed atomic publication without changing schemas", () => {
    const registry = new ToolRegistry();
    const direct = tool("mcp__srv__read", "direct");
    registry.register(direct);
    const generation = registry.generation;
    expect(() => {
      registry.register(tool(direct.name, "hidden"));
    }).toThrow("collision");
    expect(() => {
      registry.replaceTools(
        [],
        [tool("new", "direct"), tool(direct.name, "direct")],
      );
    }).toThrow("collision");
    expect(registry.generation).toBe(generation);
    expect(registry.get("new")).toBeUndefined();
  });
});
