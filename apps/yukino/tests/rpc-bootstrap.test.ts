import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bridgeBinaryName,
  bridgeBinDir,
  bridgeServerTarget,
  ensureBridgeServer,
  killBridgeServers,
  resolveBridgeBinary,
} from "@/rpc/bootstrap.js";

describe("bridgeBinaryName", () => {
  it.each(["rpc", "stdio", "ws"] as const)(
    "matches the release asset naming for %s",
    (transport) => {
      expect(bridgeBinaryName(transport)).toBe(
        `yukino-code-${transport}-${process.platform}-${process.arch}`,
      );
    },
  );
});

describe("bridgeBinDir", () => {
  it("is the ~/.yukino/bin directory", () => {
    expect(bridgeBinDir().endsWith(join(".yukino", "bin"))).toBe(true);
  });
});

describe("resolveBridgeBinary", () => {
  it("returns undefined when the binary is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-bin-"));
    expect(resolveBridgeBinary("stdio", dir)).toBeUndefined();
  });

  it("returns the absolute path when the binary is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-bin-"));
    const name = bridgeBinaryName("stdio");
    writeFileSync(join(dir, name), "binary");
    expect(resolveBridgeBinary("stdio", dir)).toBe(join(dir, name));
  });
});

describe("bridgeServerTarget", () => {
  it("defaults the rpc port and formats host:port", () => {
    expect(bridgeServerTarget("rpc", "http://127.0.0.1")).toEqual({
      host: "127.0.0.1",
      port: 7860,
      addr: "127.0.0.1:7860",
    });
  });

  it("keeps an explicit port", () => {
    expect(bridgeServerTarget("rpc", "http://127.0.0.1:9000")).toEqual({
      host: "127.0.0.1",
      port: 9000,
      addr: "127.0.0.1:9000",
    });
  });

  it("passes the websocket route through as -path", () => {
    expect(bridgeServerTarget("ws", "ws://127.0.0.1:7861/ws")).toEqual({
      host: "127.0.0.1",
      port: 7861,
      addr: "127.0.0.1:7861",
      path: "/ws",
    });
  });

  it("omits the root path", () => {
    expect(bridgeServerTarget("ws", "ws://127.0.0.1:7861/")).toEqual({
      host: "127.0.0.1",
      port: 7861,
      addr: "127.0.0.1:7861",
    });
  });

  it("brackets IPv6 hosts in the -addr value", () => {
    expect(bridgeServerTarget("ws", "ws://[::1]:7861/ws")).toEqual({
      host: "::1",
      port: 7861,
      addr: "[::1]:7861",
      path: "/ws",
    });
  });
});

describe("ensureBridgeServer", () => {
  it("resolves immediately for the stdio transport (no server to manage)", async () => {
    await expect(
      ensureBridgeServer({
        kind: "stdio",
        command: "yukino-code-stdio",
        args: [],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("killBridgeServers", () => {
  it("tolerates being called without spawned servers", () => {
    expect(() => {
      killBridgeServers();
    }).not.toThrow();
  });
});
