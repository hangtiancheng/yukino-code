import { afterEach, describe, expect, test, vi } from "vitest";

import type { MCPServerConfig } from "@/config/index.js";
import { MCPClient } from "@/mcp/client.js";
import { MCPManager } from "@/mcp/manager.js";

// Neither `command` nor `url`, so MCPClient.connect rejects before touching the
// network or spawning anything — a deterministic stand-in for a server that is down.
const unreachable: MCPServerConfig[] = [{ name: "broken" }];

describe("MCPManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a server that fails to come up counts as missing, never as connected", async () => {
    const mgr = new MCPManager();
    const result = await mgr.connectAll(unreachable);

    expect(result.servers).toEqual([]);
    expect(result.errors.map((e) => e.serverName)).toEqual(["broken"]);
    expect(mgr.connectedServers()).toEqual([]);
    expect(mgr.missingServers(unreachable)).toEqual(["broken"]);
  });

  test("a later connect pass retries the server instead of skipping it", async () => {
    const mgr = new MCPManager();
    await mgr.connectAll(unreachable);
    const second = await mgr.connectAll(unreachable);

    expect(second.errors.map((e) => e.serverName)).toEqual(["broken"]);
    expect(mgr.missingServers(unreachable)).toEqual(["broken"]);
  });

  test("reconciles added, removed, changed, and unchanged servers", async () => {
    const disconnect = vi
      .spyOn(MCPClient.prototype, "disconnect")
      .mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "listTools").mockImplementation(function (
      this: MCPClient,
    ) {
      return Promise.resolve([
        {
          name: `${this.name}-tool`,
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
      ]);
    });
    vi.spyOn(MCPClient.prototype, "getInstructions").mockImplementation(
      function (this: MCPClient) {
        return `${this.name}-instructions`;
      },
    );

    const mgr = new MCPManager();
    await mgr.connectAll([
      { name: "same", command: "same" },
      { name: "changed", command: "old" },
      { name: "removed", command: "x" },
    ]);
    const sameClient = mgr.getClient("same");
    const changedClient = mgr.getClient("changed");

    const result = await mgr.reconcile([
      { name: "same", command: "same" },
      { name: "changed", command: "new" },
      { name: "added", command: "y" },
    ]);

    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(mgr.getClient("same")).toBe(sameClient);
    expect(mgr.getClient("changed")).toBe(changedClient);
    expect(mgr.getClient("removed")).toBeUndefined();
    expect(mgr.connectedServers()).toEqual(["same", "changed", "added"]);
    expect(result).toMatchObject({
      added: ["added"],
      removed: ["removed"],
      restarted: ["changed"],
      unchanged: ["same"],
      servers: ["changed", "added"],
    });
    expect(result.tools.map(({ tool }) => tool.name)).toEqual([
      "changed-tool",
      "added-tool",
    ]);
    expect(mgr.connectedInstructions()).toEqual([
      { serverName: "same", text: "same-instructions" },
      { serverName: "changed", text: "changed-instructions" },
      { serverName: "added", text: "added-instructions" },
    ]);
  });

  test("queues reconciliation behind an in-flight startup connection", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = vi
      .spyOn(MCPClient.prototype, "connect")
      .mockImplementationOnce(() => gate)
      .mockResolvedValue(undefined);
    const disconnect = vi
      .spyOn(MCPClient.prototype, "disconnect")
      .mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "listTools").mockResolvedValue([]);

    const mgr = new MCPManager();
    const startup = mgr.connectAll([{ name: "server", command: "old" }]);
    const reload = mgr.reconcile([{ name: "server", command: "new" }]);
    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();

    release?.();
    await Promise.all([startup, reload]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test("connects independent servers concurrently but publishes in config order", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    vi.spyOn(MCPClient.prototype, "connect").mockImplementation(async function (
      this: MCPClient,
    ) {
      started.push(this.name);
      if (this.name === "slow") {
        await gate;
      }
    });
    vi.spyOn(MCPClient.prototype, "listTools").mockImplementation(function (
      this: MCPClient,
    ) {
      return Promise.resolve([
        {
          name: this.name,
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
      ]);
    });
    const mgr = new MCPManager();
    const startup = mgr.connectAll([{ name: "slow" }, { name: "fast" }]);
    try {
      await Promise.resolve();
      expect(started).toEqual(["slow", "fast"]);
    } finally {
      release();
    }
    const result = await startup;
    expect(result.servers).toEqual(["slow", "fast"]);
    expect(result.tools.map(({ tool }) => tool.name)).toEqual(["slow", "fast"]);
    expect(mgr.connectedServers()).toEqual(["slow", "fast"]);
  });

  test("keeps successful parallel connections when another tool listing fails", async () => {
    vi.spyOn(MCPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "listTools").mockImplementation(function (
      this: MCPClient,
    ) {
      if (this.name === "broken") {
        return Promise.reject(new Error("listing failed"));
      }
      return Promise.resolve([]);
    });
    const disconnect = vi
      .spyOn(MCPClient.prototype, "disconnect")
      .mockResolvedValue();
    const mgr = new MCPManager();
    const result = await mgr.connectAll([
      { name: "first" },
      { name: "broken" },
      { name: "last" },
    ]);
    expect(result.servers).toEqual(["first", "last"]);
    expect(result.errors).toEqual([
      { serverName: "broken", error: "listing failed" },
    ]);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(mgr.getClient("broken")).toBeUndefined();
  });

  test("deduplicates same-named configs before opening concurrent connections", async () => {
    const configure = vi
      .spyOn(MCPClient.prototype, "connect")
      .mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "listTools").mockResolvedValue([]);
    const mgr = new MCPManager();
    const result = await mgr.connectAll([
      { name: "same", command: "old" },
      { name: "same", command: "new" },
    ]);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(result.servers).toEqual(["same"]);
    expect(
      (await mgr.reconcile([{ name: "same", command: "new" }])).unchanged,
    ).toEqual(["same"]);
  });
});
