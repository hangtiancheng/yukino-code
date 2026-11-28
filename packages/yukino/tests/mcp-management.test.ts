import { homedir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LLMClient } from "@/llm/client.js";
import { MCPClient } from "@/mcp/client.js";
import { MCPManagement } from "@/mcp/management.js";
import { MCPManager } from "@/mcp/manager.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import type { AgentRuntime } from "@/runtime/types.js";
import { SessionManager } from "@/session/manager.js";
import type { PermissionRequestHandler } from "@/tools/types.js";

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.dispose()),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(
  permission: PermissionRequestHandler = () => Promise.resolve("allow"),
) {
  const clients: MCPClient[] = [];
  const manager = new MCPManager({
    clientFactory: (config) => {
      const client = new MCPClient(config);
      vi.spyOn(client, "connect").mockResolvedValue(undefined);
      vi.spyOn(client, "disconnect").mockResolvedValue(undefined);
      vi.spyOn(client, "listTools").mockResolvedValue([]);
      vi.spyOn(client, "readResource").mockResolvedValue({
        contents: [
          {
            uri: "memory://fixture",
            mimeType: "text/plain",
            blob: Buffer.from("fixture").toString("base64"),
          },
        ],
      });
      clients.push(client);
      return client;
    },
  });
  const session = SessionManager.create(homedir(), { persist: false });
  const client: LLMClient = {
    protocol: "openai-compat",
    setSystemPrompt: vi.fn(),
    async *stream() {
      await Promise.resolve();
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
    },
  };
  const runtime = await createAgentRuntime({
    cwd: session.cwd,
    sessionId: session.id,
    persist: false,
    memoryEnabled: false,
    enableCoordinatorMode: false,
    mcpManager: manager,
    client,
    provider: {
      name: "local",
      protocol: "openai-compat",
      base_url: "http://127.0.0.1:1/v1",
      model: "local",
    },
  });
  runtimes.push(runtime);
  return {
    session,
    runtime,
    manager,
    clients,
    management: new MCPManagement(runtime, session, permission),
  };
}

const signal = () => new AbortController().signal;

describe("shared MCP management", () => {
  it("denies registration without starting a transport", async () => {
    const { manager, clients, management } = await fixture(() =>
      Promise.resolve("deny"),
    );
    await expect(
      management.register(
        { name: "blocked", command: process.execPath },
        signal(),
      ),
    ).rejects.toThrow("requires approval");
    expect(manager.state("blocked")).toBeUndefined();
    expect(clients).toHaveLength(0);
  });

  it("uses existing global credential declarations without sending them through approval previews", async () => {
    vi.stubEnv("MCP_FIXTURE_SECRET", "fixture-secret");
    const previews: unknown[] = [];
    const { manager, management } = await fixture((name, args) => {
      previews.push({ name, args });
      return Promise.resolve("allow");
    });
    const source = manager.createSource("global", "fixture-global");
    await manager.registerServer(
      {
        name: "declared",
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: "Bearer ${MCP_FIXTURE_SECRET}" },
      },
      source,
    );
    await management.connect("declared", signal());
    expect(manager.state("declared")?.state).toBe("connected");
    expect(JSON.stringify(previews)).not.toContain("fixture-secret");
    await management.disconnect("declared", signal());
    expect(manager.state("declared")?.state).toBe("registered");
  });

  it("keeps resources portable with typed artifact descriptors and no arbitrary runtime state", async () => {
    const { manager, session, management } = await fixture();
    const source = manager.createSource("global", "fixture-global");
    await manager.registerServer(
      { name: "resource", url: "http://127.0.0.1:1/mcp" },
      source,
    );
    await management.connect("resource", signal());
    const result = await management.readResource(
      "resource",
      "memory://fixture",
      {},
      signal(),
    );
    expect(result.resourceArtifacts).toHaveLength(1);
    const record = session.getEntries().at(-1)?.message;
    expect(record?.type).toBe("mcp_resource");
    expect(record?.state).toBeUndefined();
    const copy = SessionManager.import(
      homedir(),
      session.export({ scope: "tree", format: "jsonl" }),
    );
    const imported = copy.getEntries().at(-1)?.message;
    expect(imported?.content).not.toContain(result.resourceArtifacts[0].id);
    expect(copy.export({ scope: "tree", format: "html" })).toContain("fixture");
  });

  it("does not publish a resource response after its server was revoked", async () => {
    const { manager, session, management, clients } = await fixture();
    const source = manager.createSource("global", "fixture-global");
    await manager.registerServer(
      { name: "resource", url: "http://127.0.0.1:1/mcp" },
      source,
    );
    await management.connect("resource", signal());
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(clients[0], "readResource").mockImplementation(async () => {
      entered();
      await gate;
      return {
        contents: [
          {
            uri: "memory://fixture",
            mimeType: "text/plain",
            blob: Buffer.from("fixture").toString("base64"),
          },
        ],
      };
    });
    const result = management.readResource(
      "resource",
      "memory://fixture",
      {},
      signal(),
    );
    const rejected = expect(result).rejects.toThrow("revoked");
    await started;
    await manager.disconnect("resource");
    release();
    await rejected;
    expect(session.getEntries()).toEqual([]);
    expect(session.revision).toBe(0);
  });
});
