import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as configuration from "@/config/index.js";
import { AppConfigSchema } from "@/config/index.js";
import type {
  ProviderConfig,
  ThinkingLevel,
} from "@/config/provider-config.js";
import type { Message } from "@/conversation/index.js";
import * as clients from "@/llm/client.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import * as runtimeFactory from "@/runtime/factory.js";
import {
  captureSessionRuntimeState,
  providerEndpointFingerprint,
} from "@/runtime/session-state.js";
import type { AgentRuntime } from "@/runtime/types.js";
import type { AgentSession } from "@/sdk/agent-session.js";
import { createAgentSession } from "@/sdk/factory.js";
import type { CreateAgentSessionOptions } from "@/sdk/types.js";
import { SessionManager } from "@/session/manager.js";
import {
  getSessionFilePath,
  type SessionRuntimeState,
} from "@/session/records.js";
import { yukinoPath } from "@/storage/index.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

const { configuredClientFactory } = vi.hoisted(() => ({
  configuredClientFactory:
    vi.fn<
      (provider: ProviderConfig, systemPrompt: string) => Promise<LLMClient>
    >(),
}));
vi.mock("@/llm/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof clients>()),
  createClient: configuredClientFactory,
}));

const sessions: AgentSession[] = [];
const runtimes: AgentRuntime[] = [];
const realRuntime = runtimeFactory.createAgentRuntime;
let cwd: string;
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
const end: StreamEvent = { type: "stream_end", stopReason: "end_turn", usage };

class MockClient implements LLMClient {
  readonly protocol = "anthropic";
  calls: Message[][] = [];
  thinking: ThinkingLevel = "off";
  dispose = vi.fn();
  setSystemPrompt = vi.fn();
  getThinkingLevel = () => this.thinking;
  setThinkingLevel = (level: ThinkingLevel) => (this.thinking = level);
  constructor(private script?: (index: number) => StreamEvent[]) {}
  async *stream(conv: Parameters<LLMClient["stream"]>[0]) {
    const index = this.calls.length;
    this.calls.push(structuredClone(conv.getMessages()));
    for (const event of this.script?.(index) ?? [
      { type: "text_delta", text: "reply" },
      end,
    ]) {
      await Promise.resolve();
      yield event;
    }
  }
}
function provider(model: string, endpoint = ""): ProviderConfig {
  return { name: "fixture", protocol: "anthropic", model, base_url: endpoint };
}
function state(
  target: ProviderConfig,
  thinking: ThinkingLevel = "off",
): SessionRuntimeState {
  return {
    provider: {
      name: target.name,
      protocol: target.protocol,
      model: target.model,
      endpointFingerprint: providerEndpointFingerprint(target),
    },
    thinking,
    tools: [],
    discovered: [],
  };
}
function controls(manager: SessionManager) {
  return manager
    .getEntries()
    .filter((entry) => entry.message.type === "session_runtime_state");
}
async function make(options: CreateAgentSessionOptions = {}) {
  const result = await createAgentSession({
    cwd,
    persist: false,
    tools: [],
    ...options,
  });
  sessions.push(result.session);
  return result;
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
  vi.spyOn(runtimeFactory, "createAgentRuntime").mockImplementation(
    async (options) => {
      const runtime = await realRuntime(options);
      runtimes.push(runtime);
      return runtime;
    },
  );
  configuredClientFactory
    .mockReset()
    .mockImplementation((target) =>
      Promise.resolve(clients.measureClient(new MockClient(), target)),
    );
});
afterEach(async () => {
  await Promise.allSettled(
    sessions.splice(0).map((session) => session.dispose()),
  );
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.dispose()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SDK branch runtime state", () => {
  it("restores A/B/A model and thinking with borrowed matching clients and no extra requests", async () => {
    const a = new MockClient(),
      b = new MockClient();
    const { session, sessionManager } = await make({
      provider: { ...provider("A"), name: "provider-a" },
      client: a,
    });
    expect(controls(sessionManager)).toHaveLength(1);
    session.setThinking("high");
    await session.prompt("A input");
    const leafA = sessionManager.leafId;
    await session.setModel({ ...provider("B"), name: "provider-b" }, b);
    expect(session.getModel().model).toBe("B");
    session.setThinking("low");
    await session.prompt("B input");
    const leafB = sessionManager.leafId;
    await session.navigate(leafA);
    expect(session.getModel().model).toBe("A");
    expect(session.getThinking()).toBe("high");
    await session.prompt("A again");
    await session.navigate(leafB);
    expect(session.getModel().model).toBe("B");
    expect(session.getThinking()).toBe("low");
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(1);
    expect(clients.createClient).not.toHaveBeenCalled();
    expect(session.getStats().attempts).toBe(3);
    expect(
      [...a.calls, ...b.calls]
        .flat()
        .every(
          (message) =>
            !("type" in message && message.type === "session_runtime_state"),
        ),
    ).toBe(true);
    expect(
      session
        .getMessages()
        .every(
          (message) =>
            !("type" in message && message.type === "session_runtime_state"),
        ),
    ).toBe(true);
    await session.dispose();
    expect(a.dispose).not.toHaveBeenCalled();
    expect(b.dispose).not.toHaveBeenCalled();
  });

  it("deduplicates equal captures and persists discovery only after a complete tool batch", async () => {
    const registry = new ToolRegistry();
    let deferred = false;
    const echo: Tool = {
      name: "Echo",
      description: "echo",
      category: "read",
      get deferred() {
        return deferred;
      },
      schema: () => ({
        name: "Echo",
        description: "echo",
        input_schema: { type: "object", properties: {} },
      }),
      execute: () => {
        deferred = true;
        runtimes[0].registry.markDiscovered("Echo");
        return Promise.resolve({ output: "ok", isError: false });
      },
    };
    registry.register(echo);
    const raw = new MockClient((index) =>
      index === 0
        ? [
            {
              type: "tool_call_complete",
              toolId: "one",
              toolName: "Echo",
              arguments: {},
            },
            {
              type: "tool_call_complete",
              toolId: "two",
              toolName: "Echo",
              arguments: {},
            },
            { type: "stream_end", stopReason: "tool_use", usage },
          ]
        : [end],
    );
    const { session, sessionManager } = await make({
      provider: provider("A"),
      client: raw,
      registry,
      tools: undefined,
      thinking: "off",
    });
    const afterResults: number[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_result") {
        afterResults.push(controls(sessionManager).length);
      }
    });
    await session.prompt("discover");
    expect(afterResults).toEqual([1, 1]);
    expect(controls(sessionManager)).toHaveLength(2);
    expect(sessionManager.getRuntimeState()?.discovered).toContain("Echo");
    const discoveryIndex = sessionManager
      .getEntries()
      .findIndex((entry) => entry.message.state?.discovered.includes("Echo"));
    expect(
      sessionManager
        .getEntries()
        .slice(0, discoveryIndex)
        .some((entry) => entry.message.tool_results?.length === 2),
    ).toBe(true);
    await session.prompt("unchanged");
    session.setThinking("off");
    expect(controls(sessionManager)).toHaveLength(2);
    expect(raw.calls).toHaveLength(3);
  });

  it.each(["fork", "clone", "import"] as const)(
    "%s restores target state but newSession inherits the current choice",
    async (operation) => {
      const a = new MockClient(),
        b = new MockClient();
      const { session, sessionManager } = await make({
        provider: provider("A"),
        client: a,
      });
      session.setThinking("high");
      await session.prompt("A root");
      await session.prompt("fork here");
      const user = sessionManager
        .getEntries()
        .find((entry) => entry.message.content === "fork here");
      if (!user) {
        throw new Error("Missing user entry");
      }
      const exported = session.export({ scope: "tree", format: "jsonl" });
      await session.setModel(provider("B"), b);
      session.setThinking("low");
      if (operation === "fork") {
        await session.fork(user.entryId);
      } else if (operation === "clone") {
        await session.navigate(user.parentId);
        await session.clone();
      } else {
        await session.import(exported);
      }
      expect(session.getModel().model).toBe("A");
      expect(session.getThinking()).toBe("high");
      expect(a.calls).toHaveLength(2);
      expect(b.calls).toHaveLength(0);
      await session.newSession();
      expect(session.getModel().model).toBe("A");
      expect(session.getThinking()).toBe("high");
      expect(session.getMessages()).toEqual([]);
      expect(controls(session.sessionManager)).toHaveLength(1);
    },
  );

  it("keeps the global configuration source across model transitions and refreshes target credentials", async () => {
    const a = {
      ...provider("A", "https://a.invalid/v1"),
      name: "a",
      api_key: "a-secret",
    };
    const b = {
      ...provider("B", "https://b.invalid/v1"),
      name: "b",
      api_key: "b-secret",
    };
    const config = AppConfigSchema.parse({
      providers: [a, b],
      enable_memory: false,
    });
    vi.spyOn(configuration, "loadConfig").mockReturnValue(config);
    const { session, sessionManager } = await make();
    const leafA = sessionManager.leafId;
    await session.setModel(b);
    const fresh = AppConfigSchema.parse({
      ...config,
      providers: [{ ...a, api_key: "fresh-a-secret" }, b],
    });
    vi.mocked(configuration.loadConfig).mockReturnValue(fresh);
    await session.navigate(leafA);
    expect(session.getModel()).toMatchObject({ name: "a", model: "A" });
    expect(configuredClientFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        api_key: "fresh-a-secret",
        base_url: a.base_url,
      }),
      expect.any(String),
    );
    expect(configuredClientFactory).toHaveBeenCalledTimes(3);
    expect(session.getStats().attempts).toBe(0);
    expect(config.providers).toEqual(
      [a, b].map(
        (target) => AppConfigSchema.parse({ providers: [target] }).providers[0],
      ),
    );
  });

  it("rebuilds a caller-configured target without retaining its owned client", async () => {
    const a = { ...provider("A", "https://a.invalid/v1"), name: "a" };
    const b = { ...provider("B", "https://b.invalid/v1"), name: "b" };
    const { session, sessionManager } = await make({ provider: a });
    const leafA = sessionManager.leafId;
    await session.setModel(b);
    await session.navigate(leafA);
    expect(session.getModel()).toMatchObject({ name: "a", model: "A" });
    expect(configuredClientFactory).toHaveBeenCalledTimes(3);
    expect(session.getStats().attempts).toBe(0);
  });

  it("does not reuse price or cache metadata from a different configured model", async () => {
    const target = provider("B", "https://example.invalid/v1");
    const config = AppConfigSchema.parse({
      providers: [
        {
          ...target,
          api_key: "current-secret",
          price: {
            currency: "USD",
            input: 10,
            output: 20,
            source: "B-only",
            effective_at: "2026-01-01T00:00:00Z",
          },
          cache: {
            mode: "short",
            capabilities: {
              verified: true,
              mapping: "anthropic_ephemeral",
              short: { ttl_seconds: 300, min_tokens: 10 },
              replayable: true,
            },
          },
        },
      ],
    });
    const manager = SessionManager.create(cwd, { persist: false });
    manager.appendRuntimeState(state({ ...target, model: "A" }));
    const { session } = await make({ config, sessionManager: manager });
    expect(session.getModel().price).toBeUndefined();
    expect(session.getModel().cache?.capabilities).toBeUndefined();
    expect(session.getModel().cache).toBeUndefined();
    expect(configuredClientFactory).toHaveBeenCalledWith(
      expect.objectContaining({ model: "A", api_key: "current-secret" }),
      expect.any(String),
    );
    expect(session.getStats().attempts).toBe(0);
  });

  it("restores configured references after process restart using fresh credentials without autoload work", async () => {
    const target = {
      ...provider("A", "https://EXAMPLE.invalid:443/v1/"),
      api_key: "old-secret",
    };
    const config = AppConfigSchema.parse({
      providers: [target],
      enable_memory: false,
    });
    const { session } = await make({ config, persist: true });
    session.setThinking("high");
    await session.prompt("persist");
    await session.setModel("B");
    const original = session.sessionManager;
    const aLeaf = original
      .getEntries()
      .find((entry) => entry.message.content === "reply")?.entryId;
    if (!aLeaf) {
      throw new Error("Missing A leaf");
    }
    await session.navigate(aLeaf);
    const serialized = readFileSync(
      getSessionFilePath(cwd, session.sessionId),
      "utf8",
    );
    expect(serialized).not.toMatch(/old-secret|https:\/\/EXAMPLE/);
    await session.dispose();
    vi.mocked(clients.createClient).mockClear();
    const fresh = AppConfigSchema.parse({
      ...config,
      providers: [
        {
          ...target,
          base_url: "https://example.invalid/v1",
          api_key: "new-secret",
        },
      ],
    });
    const resumed = await make({
      config: fresh,
      sessionManager: SessionManager.open(cwd, original.id),
    });
    expect(resumed.session.getModel().model).toBe("A");
    expect(resumed.session.getThinking()).toBe("high");
    expect(clients.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "A", api_key: "new-secret" }),
      expect.any(String),
    );
    expect(resumed.session.getStats().attempts).toBe(1);
    expect(runtimes.at(-1)?.client).toBeDefined();
    expect(fresh.providers[0].api_key).toBe("new-secret");
    expect(existsSync(yukinoPath("config.yaml"))).toBe(false);
  });

  it.each(["provider", "model", "thinking", "client"] as const)(
    "explicit initial %s overrides stored state, then navigation intentionally restores it",
    async (override) => {
      const target = provider("A", "https://example.invalid/v1");
      const manager = SessionManager.create(cwd, { persist: false });
      const oldLeaf = manager.appendRuntimeState(state(target, "max"));
      const config = AppConfigSchema.parse({
        providers: [provider("B", target.base_url)],
        enable_memory: false,
      });
      const extra: CreateAgentSessionOptions =
        override === "provider"
          ? { provider: provider("C", target.base_url) }
          : override === "model"
            ? { model: "C" }
            : override === "thinking"
              ? { thinking: "low" }
              : { client: new MockClient() };
      const { session } = await make({
        config,
        sessionManager: manager,
        ...extra,
      });
      expect(session.getModel().model).toBe(
        override === "provider" || override === "model" ? "C" : "B",
      );
      expect(session.getThinking()).toBe(
        override === "thinking" ? "low" : "high",
      );
      await session.navigate(oldLeaf);
      expect(session.getModel().model).toBe("A");
      expect(session.getThinking()).toBe("max");
      expect(session.getStats().attempts).toBe(0);
    },
  );

  it("rejects unavailable endpoint/custom targets and protocol mismatches without changing leaf or model", async () => {
    const raw = new MockClient();
    const { session, sessionManager } = await make({
      provider: provider("A"),
      client: raw,
    });
    await session.prompt("current");
    const currentLeaf = sessionManager.leafId;
    const unavailable = SessionManager.create(cwd, { persist: false });
    unavailable.appendRuntimeState(state(provider("missing")));
    await expect(session.switchSession(unavailable)).rejects.toThrow(
      /replacement|target|unavailable/,
    );
    expect(session.sessionManager).toBe(sessionManager);
    expect(sessionManager.leafId).toBe(currentLeaf);
    expect(session.getModel().model).toBe("A");
    await expect(
      session.setModel({ ...provider("bad"), protocol: "openai" }, raw),
    ).rejects.toThrow(/protocol/);
    expect(sessionManager.leafId).toBe(currentLeaf);
    expect(session.getModel().model).toBe("A");
    await expect(session.setModel("unbound")).rejects.toThrow(/replacement/);
    expect(sessionManager.leafId).toBe(currentLeaf);
    expect(await session.prompt("still works")).toMatchObject({
      status: "completed",
    });
    expect(raw.calls).toHaveLength(2);
  });

  it("rejects a changed configured endpoint instead of copying credentials to a fallback", async () => {
    const old = provider("A", "https://old.invalid/v1");
    const manager = SessionManager.create(cwd, { persist: false });
    manager.appendRuntimeState(state(old));
    const leaf = manager.leafId;
    const config = AppConfigSchema.parse({
      providers: [
        { ...old, base_url: "https://new.invalid/v1", api_key: "fresh-secret" },
      ],
    });
    await expect(make({ config, sessionManager: manager })).rejects.toThrow(
      /unavailable/,
    );
    expect(manager.leafId).toBe(leaf);
    expect(clients.createClient).not.toHaveBeenCalled();
    expect(config.providers[0].base_url).toBe("https://new.invalid/v1");
  });

  it("restores SDK declarations using current tools, not old schemas or newly available names", async () => {
    const registry = new ToolRegistry();
    const makeTool = (name: string, field = "value"): Tool => ({
      name,
      description: name,
      category: "read",
      deferred: true,
      schema: () => ({
        name,
        description: name,
        input_schema: {
          type: "object",
          properties: { [field]: { type: "string" } },
        },
      }),
      execute: () => Promise.resolve({ output: "current", isError: false }),
    });
    for (const name of ["Match", "Changed", "Gone"]) {
      registry.register(makeTool(name));
    }
    const { session, sessionManager } = await make({
      provider: provider("A"),
      client: new MockClient(),
      registry,
      tools: undefined,
    });
    const original = runtimes[0];
    for (const name of ["Match", "Changed", "Gone"]) {
      original.registry.markDiscovered(name);
    }
    const captured = captureSessionRuntimeState(original);
    const leaf = sessionManager.appendRuntimeState({
      ...captured,
      tools: captured.tools.filter((entry) =>
        ["Match", "Changed", "Gone"].includes(entry.name),
      ),
    });
    await session.setModel(provider("B"), new MockClient());
    registry.unregister("Gone");
    registry.unregister("Changed");
    const changed = makeTool("Changed", "new-schema");
    registry.register(changed);
    registry.register(makeTool("New"));
    await session.navigate(leaf);
    expect(session.getModel().model).toBe("A");
    expect(
      sessionManager.getRuntimeState()?.tools.map((entry) => entry.name),
    ).toEqual(["Match"]);
    expect(runtimes.at(-1)?.registry.canInvoke("Changed", "dispatch")).toBe(
      false,
    );
    expect(sessionManager.getRuntimeState()?.discovered).toEqual(["Match"]);
    expect(runtimes.at(-1)?.registry.get("Changed")).toBe(changed);
    expect(runtimes.at(-1)?.registry.canInvoke("New", "dispatch")).toBe(false);
    expect(session.getStats().attempts).toBe(0);
  });

  it("bounds borrowed bindings and never substitutes the current client after eviction", async () => {
    const first = new MockClient();
    const { session, sessionManager } = await make({
      provider: provider("0"),
      client: first,
    });
    const oldLeaf = sessionManager.leafId;
    for (let index = 1; index <= 16; index++) {
      await session.setModel(provider(String(index)), new MockClient());
    }
    const leaf = sessionManager.leafId;
    await expect(session.navigate(oldLeaf)).rejects.toThrow(/replacement/);
    expect(sessionManager.leafId).toBe(leaf);
    expect(session.getModel().model).toBe("16");
    expect(first.dispose).not.toHaveBeenCalled();
    expect(first.calls).toEqual([]);
    expect(clients.createClient).not.toHaveBeenCalled();
  });

  it("rolls back the selected leaf and provider on a restore revision conflict", async () => {
    const { session, sessionManager } = await make({
      provider: provider("A"),
      client: new MockClient(),
      persist: true,
    });
    await session.prompt("A");
    const leafA = sessionManager.leafId;
    await session.setModel(provider("B"), new MockClient());
    const leafB = sessionManager.leafId;
    vi.mocked(runtimeFactory.createAgentRuntime).mockImplementationOnce(
      async (options) => {
        const runtime = await realRuntime(options);
        runtimes.push(runtime);
        SessionManager.open(cwd, sessionManager.id).setName(
          "concurrent update",
        );
        return runtime;
      },
    );
    await expect(session.navigate(leafA)).rejects.toThrow(/revision/);
    expect(sessionManager.leafId).toBe(leafB);
    expect(session.getModel().model).toBe("B");
    expect(session.getMetadata().name).toBe("concurrent update");
    expect(session.getStats().attempts).toBe(1);
  });

  it("keeps branch and current thinking when restore initialization fails or is cancelled", async () => {
    const a = new MockClient(),
      b = new MockClient();
    const { session, sessionManager } = await make({
      provider: provider("A"),
      client: a,
    });
    await session.prompt("A");
    const leafA = sessionManager.leafId;
    await session.setModel(provider("B"), b);
    session.setThinking("low");
    const leafB = sessionManager.leafId;
    vi.mocked(runtimeFactory.createAgentRuntime).mockRejectedValueOnce(
      new Error("restore failed"),
    );
    await expect(session.navigate(leafA)).rejects.toThrow("restore failed");
    expect(sessionManager.leafId).toBe(leafB);
    expect(session.getModel().model).toBe("B");
    expect(session.getThinking()).toBe("low");
    const controller = new AbortController();
    vi.mocked(runtimeFactory.createAgentRuntime).mockImplementationOnce(
      async (options) => {
        const runtime = await realRuntime(options);
        runtimes.push(runtime);
        controller.abort();
        return runtime;
      },
    );
    await expect(
      session.navigate(leafA, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(sessionManager.leafId).toBe(leafB);
    expect(session.getModel().model).toBe("B");
    expect(await session.prompt("B remains usable")).toMatchObject({
      status: "completed",
    });
    expect(b.calls).toHaveLength(1);
  });
});
