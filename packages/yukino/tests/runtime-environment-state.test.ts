import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppConfigSchema } from "@/config/index.js";
import type {
  ProviderConfig,
  ThinkingLevel,
} from "@/config/provider-config.js";
import type { LLMClient } from "@/llm/client.js";
import { MCPClient } from "@/mcp/client.js";
import {
  createRuntimeEnvironment,
  type RuntimeEnvironment,
} from "@/remote/runtime-environment.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import {
  captureSessionRuntimeState,
  providerEndpointFingerprint,
} from "@/runtime/session-state.js";
import type { AgentRuntime } from "@/runtime/types.js";
import { SessionManager } from "@/session/manager.js";
import type { SessionRuntimeState } from "@/session/records.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

const environments: RuntimeEnvironment[] = [];
const runtimes: AgentRuntime[] = [];
let cwd: string;
function provider(model: string): ProviderConfig {
  return {
    name: "fixture",
    protocol: "anthropic",
    model,
    base_url: "https://example.invalid/v1",
    api_key: "private-key",
  };
}
function state(
  model = "A",
  tools: SessionRuntimeState["tools"] = [],
): SessionRuntimeState {
  const target = provider(model);
  return {
    provider: {
      name: target.name,
      protocol: target.protocol,
      model,
      endpointFingerprint: providerEndpointFingerprint(target),
    },
    thinking: "low",
    tools,
    discovered: [],
  };
}
function client(): LLMClient {
  let thinking: ThinkingLevel = "off";
  return {
    protocol: "anthropic",
    setSystemPrompt: vi.fn(),
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level) => (thinking = level),
    async *stream() {
      await Promise.reject(new Error("Unexpected paid request"));
      yield { type: "text_delta", text: "unreachable" };
    },
  };
}
const config = AppConfigSchema.parse({
  providers: [provider("B")],
  enable_memory: false,
});
async function build(
  manager: SessionManager,
  options: Partial<Parameters<typeof createRuntimeEnvironment>[2]> = {},
) {
  const result = await createRuntimeEnvironment(config, manager, {
    client: client(),
    enableCoordinatorMode: false,
    ...options,
  });
  environments.push(result);
  return result;
}
async function capture(registry: ToolRegistry) {
  const runtime = await createAgentRuntime({
    provider: provider("A"),
    client: client(),
    cwd,
    registry,
    enableCoordinatorMode: false,
    memoryEnabled: false,
    loadProjectResources: false,
    persist: false,
  });
  runtimes.push(runtime);
  return { runtime, state: captureSessionRuntimeState(runtime) };
}
function tool(name: string, field = "value", deferred = true): Tool {
  return {
    name,
    description: name,
    category: "read",
    deferred,
    schema: () => ({
      name,
      description: name,
      input_schema: {
        type: "object",
        properties: { [field]: { type: "string" } },
      },
    }),
    execute: () =>
      Promise.resolve({ output: "current implementation", isError: false }),
  };
}
beforeEach(() => {
  cwd = join(homedir(), "project");
  mkdirSync(cwd);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(async () => {
  await Promise.allSettled(
    environments
      .splice(0)
      .flatMap((environment) => [
        environment.project.dispose(),
        environment.runtime.dispose(),
      ]),
  );
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.dispose()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared runtime environment state", () => {
  it("restores images and paired tool results from the selected branch", async () => {
    const manager = SessionManager.create(cwd, { persist: false });
    manager.append({
      role: "assistant",
      content: "read",
      timestamp: 1,
      tool_uses: [
        {
          tool_use_id: "read",
          tool_name: "ReadFile",
          arguments: { file_path: "image.png" },
        },
      ],
    });
    const content = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: readFileSync(
            new URL("./fixtures/test.png", import.meta.url),
          ).toString("base64"),
        },
      },
      { type: "text", text: "attachment note" },
    ];
    const leaf = manager.append({
      role: "user",
      content,
      timestamp: 2,
      tool_results: [
        { tool_use_id: "read", content: "image read", is_error: false },
      ],
    });
    manager.append({ role: "user", content: "other branch", timestamp: 3 });
    manager.selectActiveLeaf(leaf);
    const { runtime } = await build(manager);
    expect(runtime.conv.getMessages()).toHaveLength(2);
    expect(runtime.conv.getMessages().at(-1)).toMatchObject({
      content,
      toolResults: [
        { toolUseId: "read", content: "image read", isError: false },
      ],
    });
  });

  it("chooses saved provider and thinking, captures effective state, and never mutates global config", async () => {
    const manager = SessionManager.create(cwd, { persist: false });
    manager.appendRuntimeState(state());
    const original = structuredClone(config);
    const environment = await build(manager, { toolNames: [] });
    expect(environment.runtime.provider.model).toBe("A");
    expect(environment.runtime.client.getThinkingLevel?.()).toBe("low");
    expect(environment.state).toEqual(state());
    expect(manager.getRuntimeState()).toEqual(environment.state);
    expect(manager.getEntries()).toHaveLength(1);
    expect(environment.runtime.conv.getMessages()).toEqual([]);
    expect(config).toEqual(original);
    expect(JSON.stringify(environment.state)).not.toMatch(
      /private-key|https:\/\//,
    );
  });

  it.each(["provider", "model", "thinking", "restoreState"] as const)(
    "honors an explicit %s instead of old state",
    async (override) => {
      const manager = SessionManager.create(cwd, { persist: false });
      manager.appendRuntimeState(state());
      const environment = await build(
        manager,
        override === "restoreState"
          ? { restoreState: false, toolNames: [] }
          : {
              invocationOptions:
                override === "provider"
                  ? { provider: "fixture", tools: [] }
                  : override === "model"
                    ? { model: "C", tools: [] }
                    : { thinking: "max", tools: [] },
            },
      );
      expect(environment.runtime.provider.model).toBe(
        override === "model" ? "C" : "B",
      );
      expect(environment.state.thinking).toBe(
        override === "thinking" ? "max" : "high",
      );
      expect(manager.getRuntimeState()).toEqual(environment.state);
    },
  );

  it("intersects saved declarations with current authority and only restores matching discovery", async () => {
    const oldRegistry = new ToolRegistry();
    oldRegistry.register(tool("Match"));
    oldRegistry.register(tool("Changed"));
    oldRegistry.register(tool("Gone"));
    const old = await capture(oldRegistry);
    for (const name of ["Match", "Changed", "Gone"]) {
      old.runtime.registry.markDiscovered(name);
    }
    const captured = captureSessionRuntimeState(old.runtime);
    const saved = {
      ...captured,
      tools: captured.tools.filter((entry) =>
        ["Match", "Changed", "Gone"].includes(entry.name),
      ),
    };
    const current = new ToolRegistry();
    current.register(tool("Match"));
    current.register(tool("Changed", "different"));
    current.register(tool("New"));
    const manager = SessionManager.create(cwd, { persist: false });
    manager.appendRuntimeState(saved);
    const environment = await build(manager, { registry: current });
    expect(environment.state.tools.map((entry) => entry.name)).toEqual([
      "Match",
    ]);
    expect(environment.runtime.registry.canInvoke("Changed", "dispatch")).toBe(
      false,
    );
    expect(environment.state.discovered).toEqual(["Match"]);
    expect(environment.droppedDeclarations).toEqual(["Changed", "Gone"]);
    expect(environment.runtime.registry.canInvoke("New", "dispatch")).toBe(
      false,
    );
    expect(environment.runtime.registry.get("Changed")).toBe(
      current.get("Changed"),
    );
    const explicit = await build(
      SessionManager.import(
        cwd,
        manager.export({ scope: "tree", format: "jsonl" }),
      ),
      { registry: current, invocationOptions: { tools: ["New"] } },
    );
    expect(explicit.state.tools.map((entry) => entry.name)).toEqual(["New"]);
    expect(explicit.state.discovered).toEqual([]);
  });

  it("drops matching-name MCP discovery after source configuration or project trust changes", async () => {
    vi.spyOn(MCPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "disconnect").mockResolvedValue();
    vi.spyOn(MCPClient.prototype, "listTools").mockResolvedValue([
      {
        name: "read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    mkdirSync(join(cwd, ".yukino"));
    const path = join(cwd, ".mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { repo: { command: "mock-initial", exposure: "deferred" } },
      }),
    );
    const manager = SessionManager.create(cwd, { persist: false });
    const first = await build(manager, {
      invocationOptions: { cwd, trustProject: true },
    });
    const name = "mcp__repo__read";
    first.runtime.registry.markDiscovered(name);
    const saved = captureSessionRuntimeState(first.runtime, first.project);
    expect(saved.discovered).toContain(name);
    manager.appendRuntimeState(saved);
    const grant = {
      identity: first.project.identity,
      fingerprint: first.project.fingerprint,
    };
    await first.project.dispose();
    await first.runtime.dispose();
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { repo: { command: "mock-changed", exposure: "deferred" } },
      }),
    );
    const denied = await build(manager, {
      authorizedProject: grant,
      onTrustRequest: () => Promise.resolve("deny"),
    });
    expect(denied.state.tools.map((entry) => entry.name)).not.toContain(name);
    expect(denied.state.discovered).toEqual([]);
    manager.selectActiveLeaf(
      manager
        .getEntries()
        .find((entry) => entry.message.state?.discovered.includes(name))
        ?.entryId ?? null,
    );
    const approved = await build(manager, {
      authorizedProject: grant,
      onTrustRequest: () => Promise.resolve("once"),
    });
    expect(approved.state.tools.map((entry) => entry.name)).not.toContain(name);
    expect(approved.runtime.registry.canInvoke(name, "dispatch")).toBe(false);
    expect(approved.state.discovered).not.toContain(name);
    expect(approved.droppedDeclarations).toContain(name);
  });

  it("binds the host signal and trusted-project guard into cache invalidation", async () => {
    const manager = SessionManager.create(cwd, { persist: false });
    const controller = new AbortController();
    let passed: Parameters<typeof createAgentRuntime>[0] | undefined;
    const environment = await build(manager, {
      signal: controller.signal,
      factory: async (options) => {
        passed = options;
        return createAgentRuntime(options);
      },
    });
    expect(passed?.cacheGuard?.()).toBeUndefined();
    controller.abort();
    expect(passed?.cacheGuard?.()).toBe("host_exit");
    expect(environment.runtime.conv.getMessages()).toEqual([]);
  });
});
