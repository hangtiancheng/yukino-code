import { createHash } from "node:crypto";

import { describe, it, expect, vi } from "vitest";

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

// unregister backs /mcp reload: the reload reconnects every server, so each old
// wrapper is dropped along with its discovery state — a re-registered tool has to
// start deferred again.
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

describe("ToolRegistry declaration snapshots", () => {
  const fingerprint = (tool: Tool) =>
    createHash("sha256")
      .update(`trusted-project/server/target/${tool.name}`)
      .digest("hex");

  it("hashes current schemas deterministically without saving implementations or executing them", () => {
    const first = new ToolRegistry();
    const second = new ToolRegistry();
    const a = stubTool("Deferred", true);
    const b = stubTool("Deferred", true);
    a.schema = () => ({
      name: a.name,
      description: "description",
      input_schema: {
        type: "object",
        properties: {
          b: { type: "string", minLength: 1 },
          a: { type: "number" },
        },
      },
    });
    b.schema = () => ({
      input_schema: {
        properties: {
          a: { type: "number" },
          b: { minLength: 1, type: "string" },
        },
        type: "object",
      },
      description: "description",
      name: b.name,
    });
    const execute = vi.fn(() =>
      Promise.resolve({ output: "ok", isError: false }),
    );
    a.execute = execute;
    first.register(a);
    second.register(b);
    const snapshots = first.snapshotDeclarations(fingerprint);
    expect(snapshots).toEqual(second.snapshotDeclarations(fingerprint));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].name).toBe("Deferred");
    expect(snapshots[0].schemaFingerprint).toMatch(/^[a-f\d]{64}$/u);
    expect(snapshots[0].sourceFingerprint).toBe(fingerprint(a));
    expect(Object.keys(snapshots[0]).sort()).toEqual([
      "name",
      "schemaFingerprint",
      "sourceFingerprint",
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(first.restoreDiscovered(snapshots, fingerprint)).toEqual([]);
    expect(first.isDiscovered("Deferred")).toBe(true);
    expect(first.get("Deferred")).toBe(a);
    expect(execute).not.toHaveBeenCalled();
  });

  it("clears old discoveries in one publication and restores only matching authorized dispatch tools", () => {
    const registry = new ToolRegistry();
    const names = [
      "Valid",
      "Revoked",
      "SchemaChanged",
      "SourceChanged",
      "Hidden",
      "CodeOnly",
      "NowDirect",
      "ModelHidden",
      "Unavailable",
      "Removed",
      "NotInSnapshot",
    ];
    const tools = names.map((name) =>
      Object.assign(stubTool(name, true), {
        exposure: "deferred",
        modelVisible: true,
      }),
    );
    for (const tool of tools) {
      registry.register(tool);
      registry.markDiscovered(tool.name);
    }
    const snapshots = registry
      .snapshotDeclarations(fingerprint)
      .filter((snapshot) => snapshot.name !== "NotInSnapshot");
    registry.setPolicy({
      role: "read-only",
      denylist: ["Revoked"],
      codeModeEnabled: true,
    });
    const changed = tools.find((tool) => tool.name === "SchemaChanged");
    if (!changed) {
      throw new Error("Missing tool");
    }
    changed.schema = () => ({
      name: changed.name,
      description: "changed",
      input_schema: { type: "object", properties: {} },
    });
    for (const tool of tools) {
      if (tool.name === "Hidden") {
        tool.exposure = "hidden";
      }
      if (tool.name === "CodeOnly") {
        tool.exposure = "codemode";
      }
      if (tool.name === "NowDirect") {
        tool.exposure = "direct";
      }
      if (tool.name === "ModelHidden") {
        tool.modelVisible = false;
      }
      if (tool.name === "Unavailable") {
        tool.isAvailable = () => false;
      }
    }
    registry.unregister("Removed");
    const seen: string[][] = [];
    const before = registry.generation;
    registry.subscribe(() =>
      seen.push(names.filter((name) => registry.isDiscovered(name))),
    );
    const dropped = registry.restoreDiscovered(snapshots, (tool) =>
      tool.name === "SourceChanged" ? "d".repeat(64) : fingerprint(tool),
    );
    expect(dropped.sort()).toEqual(
      names
        .filter((name) => name !== "Valid" && name !== "NotInSnapshot")
        .sort(),
    );
    expect(registry.generation).toBe(before + 1);
    expect(seen).toEqual([["Valid"]]);
    expect(registry.getPolicy()).toEqual({
      role: "read-only",
      denylist: ["Revoked"],
      codeModeEnabled: true,
    });
    expect(registry.get("Valid")).toBe(tools[0]);
  });

  it("uses current inherited role/source policy and never restores an owner's revoked tool", () => {
    const owner = new ToolRegistry();
    const tool = stubTool("Deferred", true);
    owner.register(tool);
    const snapshots = owner.snapshotDeclarations(fingerprint);
    const child = new ToolRegistry();
    child.copyLoadingStateFrom(owner);
    child.registerBorrowed(tool);
    child.setPolicy({ role: "reader", allowlist: [tool.name] });
    expect(child.restoreDiscovered(snapshots, fingerprint)).toEqual([]);
    owner.setPolicy({ role: "revoked", denylist: [tool.name] });
    expect(child.restoreDiscovered(snapshots, fingerprint)).toEqual([
      tool.name,
    ]);
    expect(child.isDiscovered(tool.name)).toBe(false);
    expect(child.snapshotDeclarations(fingerprint)).toEqual([]);
  });

  it("rejects malformed/duplicate snapshots fail-closed and drops invalid current source hashes", () => {
    const registry = new ToolRegistry();
    const tool = stubTool("Deferred", true);
    registry.register(tool);
    const snapshots = registry.snapshotDeclarations(fingerprint);
    registry.markDiscovered(tool.name);
    expect(() =>
      registry.restoreDiscovered([...snapshots, ...snapshots], fingerprint),
    ).toThrow();
    expect(registry.isDiscovered(tool.name)).toBe(false);
    registry.markDiscovered(tool.name);
    expect(() =>
      registry.restoreDiscovered(
        [{ ...snapshots[0], sourceFingerprint: "https://host?token=secret" }],
        fingerprint,
      ),
    ).toThrow();
    expect(registry.isDiscovered(tool.name)).toBe(false);
    expect(() =>
      registry.snapshotDeclarations(() => "Bearer secret"),
    ).toThrow();
    expect(registry.restoreDiscovered(snapshots, () => "not-a-hash")).toEqual([
      tool.name,
    ]);
    expect(registry.isDiscovered(tool.name)).toBe(false);
    registry.markDiscovered(tool.name);
    expect(registry.restoreDiscovered([], fingerprint)).toEqual([]);
    expect(registry.isDiscovered(tool.name)).toBe(false);
    registry.markDiscovered(tool.name);
    tool.isAvailable = () => {
      throw new Error("Unavailable current source");
    };
    expect(registry.restoreDiscovered(snapshots, fingerprint)).toEqual([
      tool.name,
    ]);
    expect(registry.isDiscovered(tool.name)).toBe(false);
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
});
