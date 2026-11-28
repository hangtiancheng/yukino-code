import { afterEach, describe, expect, it, vi } from "vitest";

import { MCPClient } from "@/mcp/client.js";
import type { MCPTool } from "@/mcp/client.js";
import { formatMCPStatus } from "@/mcp/commands.js";
import { MCPConnectionError } from "@/mcp/errors.js";
import { MCPManager, connectRegisteredMCPServers } from "@/mcp/manager.js";
import { ToolRegistry } from "@/tools/registry.js";

const schema = { type: "object" as const, properties: {} };
const mcpTool = (name: string): MCPTool => ({
  name,
  description: name,
  inputSchema: schema,
});
function mocks() {
  const connect = vi.spyOn(MCPClient.prototype, "connect").mockResolvedValue();
  const disconnect = vi
    .spyOn(MCPClient.prototype, "disconnect")
    .mockResolvedValue();
  const list = vi
    .spyOn(MCPClient.prototype, "listTools")
    .mockResolvedValue([mcpTool("read")]);
  return { connect, disconnect, list };
}
afterEach(() => {
  vi.restoreAllMocks();
});

describe("controlled MCP lifecycle", () => {
  it("reports failed startup without publishing wrappers and retries only missing servers", async () => {
    const { connect, disconnect } = mocks();
    connect.mockRejectedValueOnce(
      Object.assign(new Error("secret credential must not be logged"), {
        code: "ENOENT",
      }),
    );
    const registry = new ToolRegistry();
    const manager = new MCPManager({ registry });
    const configs = [{ name: "server", command: "mock" }];
    const failed = await manager.connectAll(configs);
    expect(failed.servers).toEqual([]);
    expect(failed.errors[0].error).not.toContain("secret");
    expect(registry.listTools()).toEqual([]);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(manager.missingServers(configs)).toEqual(["server"]);
    expect((await manager.connectAll(configs)).servers).toEqual(["server"]);
    await manager.connectAll(configs);
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("retains a good wrapper and per-server discovery diagnostics until explicit retry", async () => {
    const { connect, list, disconnect } = mocks();
    const original = Object.assign(new Error("credential-secret"), {
      code: "EPIPE",
    });
    let failing = true;
    list.mockImplementation(function (this: MCPClient) {
      return this.name === "failed" && failing
        ? Promise.reject(original)
        : Promise.resolve([mcpTool("read")]);
    });
    disconnect.mockRejectedValue(new Error("cleanup-secret"));
    const registry = new ToolRegistry();
    const manager = new MCPManager({ registry });
    const configs = [
      { name: "good", command: "mock" },
      { name: "failed", command: "mock" },
    ];
    const result = await manager.connectAll(configs);
    expect(result.servers).toEqual(["good"]);
    expect(result.errors).toEqual([
      {
        serverName: "failed",
        error: "MCP transport is unavailable",
        diagnostic: {
          serverName: "failed",
          transport: "stdio",
          phase: "discovery",
          code: "EPIPE",
          message: "MCP transport is unavailable",
        },
      },
    ]);
    expect(JSON.stringify(result.errors)).not.toContain("secret");
    expect(manager.state("failed")).toMatchObject({
      state: "error",
      tools: 0,
      diagnostic: result.errors[0].diagnostic,
    });
    expect(manager.getClient("failed")).toBeUndefined();
    expect(registry.get("mcp__failed__read")).toBeUndefined();
    const wrapper = registry.get("mcp__good__read");
    failing = false;
    await manager.connect("failed");
    expect(manager.state("failed")).toMatchObject({ state: "connected" });
    expect(manager.state("failed")?.diagnostic).toBeUndefined();
    expect(registry.get("mcp__good__read")).toBe(wrapper);
    expect(registry.get("mcp__failed__read")).toBeDefined();
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("startup helper only connects registered servers and catches typed unavailable failures", async () => {
    const { connect, disconnect } = mocks();
    const manager = new MCPManager();
    const owner = manager.createSource("global", "host");
    await manager.registerServer({ name: "failed", command: "mock" }, owner);
    const original = Object.assign(new Error("private-secret"), {
      code: "ENOENT",
    });
    connect.mockRejectedValueOnce(original);
    const diagnostics = await connectRegisteredMCPServers(manager, ["failed"]);
    expect(diagnostics).toMatchObject([
      { serverName: "failed", phase: "connect", code: "ENOENT" },
    ]);
    expect(manager.state("failed")?.state).toBe("error");
    const unknown = new Error("unknown-secret");
    connect.mockRejectedValueOnce(unknown);
    disconnect.mockRejectedValueOnce(new Error("cleanup-secret"));
    await expect(
      connectRegisteredMCPServers(manager, ["failed"]),
    ).rejects.toMatchObject({ cause: unknown, optionalUnavailable: false });
    await expect(
      connectRegisteredMCPServers(manager, ["unregistered"]),
    ).rejects.toThrow("Unknown MCP server");
    await manager.connect("failed");
    expect(manager.connectedServers()).toEqual(["failed"]);
  });

  it("keeps explicit connect and reload strict for typed unavailable failures", async () => {
    const { connect } = mocks();
    const manager = new MCPManager();
    const source = manager.createSource("global", "host");
    await manager.registerServer({ name: "server", command: "mock" }, source);
    const original = Object.assign(new Error("secret"), { code: "ENOENT" });
    connect.mockRejectedValueOnce(original);
    await expect(manager.connect("server")).rejects.toBeInstanceOf(
      MCPConnectionError,
    );
    await manager.connect("server");
    const client = manager.getClient("server");
    connect.mockRejectedValueOnce(original);
    await expect(manager.reload("server")).rejects.toMatchObject({
      cause: original,
      optionalUnavailable: true,
    });
    expect(manager.getClient("server")).toBe(client);
  });

  it("preserves publication failure over cleanup and never treats it as optional", async () => {
    const { disconnect } = mocks();
    const registry = new ToolRegistry();
    const manager = new MCPManager({ registry });
    const source = manager.createSource("global", "host");
    await manager.registerServer({ name: "server", command: "mock" }, source);
    const original = Object.assign(new Error("publication-secret"), {
      code: "EPIPE",
    });
    vi.spyOn(registry, "replaceTools").mockImplementationOnce(() => {
      throw original;
    });
    disconnect.mockRejectedValueOnce(new Error("cleanup-secret"));
    await expect(
      connectRegisteredMCPServers(manager, ["server"]),
    ).rejects.toMatchObject({
      cause: original,
      diagnostic: {
        phase: "publication",
        message: "MCP tool publication failed",
      },
      optionalUnavailable: false,
    });
    expect(registry.listTools()).toEqual([]);
    expect(manager.getClient("server")).toBeUndefined();
    expect(JSON.stringify(manager.state("server"))).not.toContain("secret");
  });

  it("never swallows cancellation, authorization, owner conflicts, or invalid configuration", async () => {
    const { connect } = mocks();
    const manager = new MCPManager();
    const owner = manager.createSource("global", "host");
    await manager.registerServer({ name: "server", command: "mock" }, owner);
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    connect.mockImplementationOnce(
      (options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(reason);
            },
            { once: true },
          );
        }),
    );
    const pending = connectRegisteredMCPServers(manager, ["server"], {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledOnce();
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(
      manager.connectAll([
        { name: "invalid", command: "mock", transport: "http" },
      ]),
    ).rejects.toThrow();
    await expect(
      manager.connectAll([{ name: "server", command: "mock" }]),
    ).rejects.toThrow("another source owner");
    const denied = new MCPManager({ authorizeProject: () => false });
    const source = denied.createSource("project", "project", "/tmp/mock");
    await expect(
      denied.connectAll([{ name: "denied", command: "mock" }], source),
    ).rejects.toThrow("authorization required");
    const invalid = new MCPManager({ clientOptions: { environment: {} } });
    const invalidSource = invalid.createSource("global", "host");
    await invalid.registerServer(
      { name: "invalid", command: "$MISSING", inherit_env: false },
      invalidSource,
    );
    await expect(
      connectRegisteredMCPServers(invalid, ["invalid"]),
    ).rejects.toThrow("unset environment");
  });

  it("rejects unknown batch errors while retaining successful servers", async () => {
    const { connect } = mocks();
    const original = new Error("raw-secret");
    connect.mockImplementation(function (this: MCPClient) {
      return this.name === "failed"
        ? Promise.reject(original)
        : Promise.resolve();
    });
    const manager = new MCPManager();
    await expect(
      manager.connectAll([
        { name: "failed", command: "mock" },
        { name: "good", command: "mock" },
      ]),
    ).rejects.toMatchObject({ cause: original, optionalUnavailable: false });
    expect(manager.connectedServers()).toEqual(["good"]);
    expect(manager.state("failed")?.state).toBe("error");
  });

  it("serializes reload behind startup and scopes a single-server replacement", async () => {
    const { connect, disconnect } = mocks();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    connect.mockImplementationOnce(() => gate);
    const manager = new MCPManager();
    const startup = manager.connectAll([
      { name: "one", command: "mock" },
      { name: "two", command: "mock" },
    ]);
    const reload = manager.reload("one", { name: "one", command: "new" });
    expect(disconnect).not.toHaveBeenCalled();
    release();
    await Promise.all([startup, reload]);
    expect(manager.connectedServers()).toEqual(["one", "two"]);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(3);
  });
  it("runs independent connections concurrently and preserves configuration order", async () => {
    const { connect } = mocks();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    connect.mockImplementation(async function (this: MCPClient) {
      started.push(this.name);
      if (this.name === "slow") {
        await gate;
      }
    });
    const manager = new MCPManager();
    const pending = manager.connectAll([
      { name: "slow", command: "mock" },
      { name: "fast", command: "mock" },
    ]);
    await vi.waitFor(() => {
      expect(started).toEqual(["slow", "fast"]);
    });
    release();
    expect((await pending).servers).toEqual(["slow", "fast"]);
  });
  it("requires host-generated source and project authorization before any transport", async () => {
    const { connect } = mocks();
    const manager = new MCPManager();
    const project = manager.createSource(
      "project",
      "host-project",
      "/tmp/mock-project",
    );
    await expect(
      manager.registerServer({ name: "server", command: "mock" }, project),
    ).rejects.toThrow("authorization required");
    await expect(
      manager.connectAll([{ name: "server", command: "mock" }], { ...project }),
    ).rejects.toThrow("host manager");
    expect(connect).not.toHaveBeenCalled();
    const allowed = new MCPManager({ authorizeProject: () => true });
    const owner = allowed.createSource(
      "extension",
      "host-extension",
      "/tmp/mock-project",
    );
    await allowed.registerServer(
      { name: "server", command: "mock", dynamic: true },
      owner,
    );
    await allowed.connect("server");
    expect(allowed.sourcesForServers()).toEqual([
      { name: "server", source: owner },
    ]);
    await allowed.unregisterOwner(owner);
    expect(allowed.states()).toEqual([]);
  });
  it("rejects duplicate/sanitized names and publication collisions without partial wrappers", async () => {
    const { list, disconnect } = mocks();
    const manager = new MCPManager();
    await expect(
      manager.connectAll([
        { name: "same", command: "old" },
        { name: "same", command: "new" },
      ]),
    ).rejects.toThrow("collision");
    await expect(
      manager.connectAll([
        { name: "a-b", command: "mock" },
        { name: "a_b", command: "mock" },
      ]),
    ).rejects.toThrow("collision");
    expect(manager.states()).toEqual([]);
    list.mockResolvedValue([mcpTool("a-b"), mcpTool("a_b")]);
    const registry = new ToolRegistry();
    const conflict = new MCPManager({ registry });
    await expect(
      conflict.connectAll([{ name: "server", command: "mock" }]),
    ).rejects.toMatchObject({
      diagnostic: { phase: "publication" },
      optionalUnavailable: false,
    });
    expect(registry.listTools()).toEqual([]);
    expect(conflict.getClient("server")).toBeUndefined();
    expect(disconnect).toHaveBeenCalled();
  });
  it("keeps the old connection/schema when reload candidate fails", async () => {
    const { list } = mocks();
    const registry = new ToolRegistry();
    const manager = new MCPManager({ registry });
    await manager.connectAll([{ name: "server", command: "mock" }]);
    const client = manager.getClient("server");
    const wrapper = registry.get("mcp__server__read");
    const original = new Error("bad listing secret");
    list.mockRejectedValueOnce(original);
    await expect(manager.reload("server")).rejects.toMatchObject({
      cause: original,
      diagnostic: { phase: "discovery" },
      optionalUnavailable: false,
    });
    expect(manager.getClient("server")).toBe(client);
    expect(registry.get("mcp__server__read")).toBe(wrapper);
  });
  it("updates wrappers on listChanged, revokes borrowed children, and invalidates resources", async () => {
    const { list } = mocks();
    let notify: (kind: "tools" | "resources") => void = () => undefined;
    vi.spyOn(MCPClient.prototype, "onListChanged").mockImplementation(
      (listener) => {
        notify = listener;
        return () => undefined;
      },
    );
    const registry = new ToolRegistry();
    const manager = new MCPManager({ registry });
    await manager.connectAll([
      { name: "server", command: "mock", exposure: "direct" },
    ]);
    const child = new ToolRegistry();
    child.copyLoadingStateFrom(registry);
    const wrapper = registry.get("mcp__server__read");
    if (!wrapper) {
      throw new Error("Fixture missing");
    }
    child.registerBorrowed(wrapper);
    const authorization = registry.captureAuthorization(wrapper.name, "direct");
    list.mockResolvedValueOnce([mcpTool("new")]);
    notify("tools");
    await vi.waitFor(() => {
      expect(registry.get("mcp__server__new")).toBeDefined();
    });
    expect(registry.get(wrapper.name)).toBeUndefined();
    expect(child.get(wrapper.name)).toBeUndefined();
    expect(registry.validateAuthorization(authorization)).toBe(false);
    const version = manager.cacheVersion;
    notify("resources");
    await vi.waitFor(() => {
      expect(manager.cacheVersion).toBeGreaterThan(version);
    });
    await manager.setExposure("server", "hidden");
    expect(registry.canInvoke("mcp__server__new", "app")).toBe(false);
    expect(manager.canReadResources("server")).toBe(false);
    list.mockResolvedValueOnce([mcpTool("next")]);
    notify("tools");
    await vi.waitFor(() => {
      expect(registry.get("mcp__server__next")).toBeDefined();
    });
    expect(registry.canInvoke("mcp__server__next", "direct")).toBe(false);
  });
  it("formats codemode-unreachable status without invoking lifecycle actions", async () => {
    const { connect } = mocks();
    const manager = new MCPManager();
    await manager.connectAll([
      { name: "server", command: "mock", exposure: "codemode" },
    ]);
    const calls = connect.mock.calls.length;
    expect(formatMCPStatus(manager, "server")).toContain(
      "CodeMode exposure is unreachable",
    );
    expect(connect).toHaveBeenCalledTimes(calls);
  });
});
