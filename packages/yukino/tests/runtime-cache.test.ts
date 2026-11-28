import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { RuntimeCacheController } from "@/cache/controller.js";
import {
  ProviderConfigSchema,
  type ProviderConfig,
  type ThinkingLevel,
} from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import { withExecutionContext } from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import type { LLMClient, LLMStreamOptions } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import {
  getRuntimeStatus,
  RuntimeStatusSchema,
  formatRuntimeStatus,
} from "@/runtime/status.js";
import type { AgentRuntime, CreateRuntimeOptions } from "@/runtime/types.js";
import { getSessionFilePath, SessionManager } from "@/session/index.js";
import * as sessionRecords from "@/session/records.js";
import { sessionPath } from "@/storage/index.js";
import {
  readPrivateFileSync,
  writePrivateFileSync,
} from "@/storage/private.js";
import { tryAcquireFileSyncLock } from "@/teams/file-lock.js";
import { TASKS_FILENAME } from "@/todo/constants.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { ProviderToolSchema, Tool } from "@/tools/types.js";

const epoch = Date.parse("2026-01-01T00:00:00Z");
const runtimes: AgentRuntime[] = [];
const directories: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function provider(mode: "idle" | "streaming" | "off" = "idle"): ProviderConfig {
  return ProviderConfigSchema.parse({
    name: "fixture",
    protocol: "anthropic",
    model: "fixture",
    api_key: "never-expose-key",
    base_url: "https://example.invalid?secret=never-expose-query",
    context_window: 200000,
    max_output_tokens: 1000,
    price: {
      currency: "USD",
      input: 10,
      output: 2,
      cache_read: 0.1,
      cache_write: 12,
      source: "fixture",
      effective_at: "2025-01-01T00:00:00Z",
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
    warming: {
      mode,
      frequency_ms: 10,
      max_idle_ms: 1000,
      reuse_probability: 1,
      net_benefit_threshold: 0,
    },
  });
}
function end(stopReason = "end_turn", usageComplete = true): StreamEvent {
  return {
    type: "stream_end",
    stopReason,
    usageComplete,
    usage: {
      inputTokens: 5,
      outputTokens: 1,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 0,
    },
  };
}
function gate() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface Call {
  messages: unknown;
  tools: ProviderToolSchema[];
  options?: LLMStreamOptions;
}
function client(calls: Call[]): LLMClient {
  return {
    protocol: "anthropic",
    supportsCacheWarming: true,
    setSystemPrompt: vi.fn(),
    async *stream(conv, tools, _signal, options) {
      await Promise.resolve();
      calls.push({
        messages: structuredClone(conv.getMessages()),
        tools,
        options,
      });
      yield { type: "text_delta", text: "reply must not be replayed" };
      yield end();
    },
  };
}
async function runtime(
  llm: LLMClient,
  config = provider(),
  options: Partial<CreateRuntimeOptions> = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "runtime-cache-"));
  directories.push(cwd);
  const borrowedRegistry = new ToolRegistry();
  for (const tool of options.tools ?? []) {
    borrowedRegistry.register(tool);
  }
  const handle = await createAgentRuntime({
    provider: config,
    client: llm,
    systemPrompt: "actual system",
    cwd,
    persist: false,
    cleanupArtifacts: false,
    memoryEnabled: false,
    enableCoordinatorMode: false,
    loadProjectResources: false,
    registry: borrowedRegistry,
    toolNames: [],
    ...options,
  });
  runtimes.push(handle);
  return handle;
}
async function run(
  handle: AgentRuntime,
  text = "actual prompt",
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of handle.run(text, {
    onPermissionRequest: () => Promise.resolve("allow"),
  })) {
    events.push(event);
  }
  return events;
}
function execution(handle: AgentRuntime) {
  const context = handle.executionContext;
  if (!context) {
    throw new Error("Missing execution context");
  }
  return context;
}
function slow(
  started: ReturnType<typeof gate>,
  finish: ReturnType<typeof gate>,
): Tool {
  return {
    name: "Slow",
    description: "fixture",
    category: "read",
    schema: () => ({
      name: "Slow",
      description: "fixture",
      input_schema: { type: "object", properties: {} },
    }),
    execute: async () => {
      started.resolve();
      await finish.promise;
      return { output: "done", isError: false };
    },
  };
}

describe("runtime-owned cache lifecycle", () => {
  it("warms the original persistent prefix through assistant/tool appends without executing replayed tools", async () => {
    const started = gate(),
      finish = gate();
    const tool = slow(started, finish);
    const execute = vi.spyOn(tool, "execute");
    const calls: Call[] = [];
    let foreground = 0;
    const llm = client(calls);
    llm.stream = async function* (conv, tools, _signal, options) {
      await Promise.resolve();
      calls.push({
        messages: structuredClone(conv.getMessages()),
        tools: structuredClone(tools),
        options,
      });
      if (options?.warming || ++foreground === 1) {
        yield {
          type: "tool_call_complete",
          toolName: "Slow",
          toolId: options?.warming ? "never-execute" : "slow",
          arguments: {},
        };
      } else {
        yield { type: "text_delta", text: "final reply" };
      }
      yield options?.warming
        ? {
            ...end(),
            usage: {
              inputTokens: 0,
              outputTokens: 1,
              cacheReadInputTokens: 1005,
              cacheCreationInputTokens: 0,
            },
          }
        : end(foreground === 1 ? "tool_use" : "end_turn");
    };
    const handle = await runtime(llm, provider("streaming"), {
      persist: true,
      tools: [tool],
      toolNames: ["Slow"],
    });
    const stream = handle.client.stream.bind(handle.client);
    vi.spyOn(handle.client, "stream").mockImplementation(
      (conv, tools, signal, options) =>
        stream(
          conv,
          tools,
          signal,
          options?.warming
            ? options
            : {
                ...options,
                cacheMode: "short",
                cacheTTLSeconds: 300,
                answerReserveTokens: 70,
                maxRetries: 2,
              },
        ),
    );
    const path = getSessionFilePath(handle.cwd, handle.sessionId);
    const running = run(handle);
    try {
      await Promise.race([
        started.promise,
        running.then((events) => {
          throw new Error(JSON.stringify(events));
        }),
      ]);
      const request = handle.cache.requests.getLatest();
      if (!request) {
        throw new Error("Missing persistent request");
      }
      const document = sessionRecords.readSessionDocument(path);
      if (!document) {
        throw new Error("Missing persistent document");
      }
      const branch = request.options.cacheScope?.branch;
      expect(branch).not.toBe(handle.sessionId);
      expect(document.leafId).not.toBe(branch);
      expect(
        sessionRecords.getEntryPath(document).map((entry) => entry.entryId),
      ).toContain(branch);
      expect(handle.cache.getStatus().warming.state).toBe("scheduled");
      await vi.advanceTimersByTimeAsync(20);
      expect(calls).toHaveLength(3);
      for (const warm of calls.slice(1)) {
        expect(warm.messages).toEqual(calls[0].messages);
        expect(warm.messages).toEqual(request.conversation.getMessages());
        expect(warm.tools).toEqual(request.tools);
        expect(warm.tools).toHaveLength(1);
        expect(warm.options).toMatchObject({
          ...request.options,
          systemPrompt: "actual system",
          cacheTTLSeconds: 300,
          maxOutputTokens: 1,
          maxRetries: 0,
          warming: true,
        });
        expect(warm.options?.cacheScope).toEqual(request.options.cacheScope);
      }
      expect(execute).toHaveBeenCalledOnce();
      expect(sessionRecords.readSessionDocument(path)?.leafId).toBe(
        document.leafId,
      );
      expect(handle.cache.getStatus().warming.state).toBe("scheduled");
    } finally {
      finish.resolve();
      await running;
    }
    const latest = handle.cache.requests.getLatest();
    expect(latest?.conversation.getMessages()).toEqual(calls[3].messages);
    expect(sessionRecords.readSessionDocument(path)?.leafId).not.toBe(
      latest?.options.cacheScope?.branch,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(5);
    expect(calls[4].messages).toEqual(calls[3].messages);
    expect(calls[4].options?.cacheScope).toEqual(calls[3].options?.cacheScope);
    expect(handle.cache.getStatus().warming.state).toBe("scheduled");
    expect(execute).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps idle warming valid for same-path appends but blocks an active sibling selection", async () => {
    const calls: Call[] = [];
    const llm = client(calls);
    llm.stream = async function* (conv, tools, _signal, options) {
      await Promise.resolve();
      calls.push({
        messages: structuredClone(conv.getMessages()),
        tools,
        options,
      });
      yield { type: "text_delta", text: "reply" };
      yield {
        ...end(),
        usage: {
          inputTokens: 0,
          outputTokens: 1,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 0,
        },
      };
    };
    const handle = await runtime(llm, provider(), { persist: true });
    const path = getSessionFilePath(handle.cwd, handle.sessionId);
    const root = sessionRecords.appendTranscriptMessage(path, {
      role: "assistant",
      content: "shared root",
      timestamp: epoch / 1000,
    });
    const manager = SessionManager.open(handle.cwd, handle.sessionId);
    const sibling = manager.append({ role: "assistant", content: "sibling" });
    manager.selectActiveLeaf(root);
    await run(handle);
    const snapshot = handle.cache.requests.getLatest();
    expect(handle.cache.getStatus().warming.state).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(2);
    manager.refresh();
    manager.append({ role: "system", content: "ordinary same-branch append" });
    handle.conv.addSystemReminder("ordinary same-branch append");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(3);
    expect(calls[2].messages).toEqual(calls[0].messages);
    expect(calls[2].options?.cacheScope).toEqual(snapshot?.options.cacheScope);
    expect(handle.cache.getStatus().warming.state).toBe("scheduled");
    manager.selectActiveLeaf(sibling);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(3);
    expect(handle.cache.getStatus().warming).toMatchObject({
      state: "idle",
      skipReason: "branch_change",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "damaged"])(
    "denies paid replay safely when the persistent record is %s",
    async (variant) => {
      const calls: Call[] = [];
      const handle = await runtime(client(calls), provider(), {
        persist: true,
      });
      await run(handle);
      expect(handle.cache.getStatus().warming.state).toBe("scheduled");
      const path = getSessionFilePath(handle.cwd, handle.sessionId);
      if (variant === "missing") {
        rmSync(path);
      } else {
        writePrivateFileSync(path, "private damaged session payload");
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(1);
      expect(handle.cache.getStatus().warming).toMatchObject({
        state: "idle",
        skipReason: "branch_change",
      });
      expect(JSON.stringify(handle.cache.getStatus())).not.toContain(
        "private damaged",
      );
    },
  );

  it("never parses an in-progress locked append and can warm a later complete request", async () => {
    const calls: Call[] = [];
    const handle = await runtime(client(calls), provider(), { persist: true });
    await run(handle);
    const path = getSessionFilePath(handle.cwd, handle.sessionId);
    const serialized = readPrivateFileSync(path, "utf8");
    const release = tryAcquireFileSyncLock(path);
    if (!release) {
      throw new Error("Missing writer lock");
    }
    const read = vi.spyOn(sessionRecords, "readSessionDocument");
    try {
      writePrivateFileSync(path, serialized + '{"partial-private-record":');
      await vi.advanceTimersByTimeAsync(100);
      expect(read).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(handle.cache.getStatus().warming.skipReason).toBe("branch_change");
    } finally {
      writePrivateFileSync(path, serialized);
      release();
    }
    await run(handle, "after concurrent write");
    expect(handle.cache.getStatus().warming.state).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(3);
    expect(calls[2].messages).toEqual(calls[1].messages);
  });

  it.each(["missing_branch", "predicate_failure"])(
    "fails closed for %s at the controller boundary",
    async (variant) => {
      const calls: Call[] = [];
      const conv = new ConversationManager();
      conv.addUserMessage("original");
      const context = {
        sessionId: "memory-session",
        runId: "main-run",
        agentId: "main",
        purpose: "main" as const,
        ledger: createCostLedger({
          sessionId: "memory-session",
          persist: false,
        }),
      };
      let fail = false;
      const branch = vi.fn((requestBranch: string) => {
        if (fail) {
          throw new Error("private predicate failure");
        }
        return requestBranch === context.sessionId;
      });
      const cache = new RuntimeCacheController({
        provider: provider(),
        client: client(calls),
        conversation: conv,
        context,
        systemPrompt: "system",
        cwd: "/memory-project",
        registry: new ToolRegistry(),
        toolFilter: () => () => true,
        goalStatus: () => undefined,
        branch,
      });
      try {
        await cache.beginRun(context);
        await withExecutionContext(context, async () => {
          for await (const _event of cache.client.stream(
            conv,
            [],
            undefined,
            variant === "missing_branch"
              ? {}
              : {
                  cacheScope: {
                    project: "/memory-project",
                    branch: context.sessionId,
                  },
                },
          )) {
            /* consume */
          }
        });
        await cache.endRun(true);
        if (variant === "predicate_failure") {
          expect(branch).toHaveBeenCalledWith(context.sessionId);
          expect(cache.getStatus().warming.state).toBe("scheduled");
          fail = true;
        } else {
          expect(branch).not.toHaveBeenCalled();
        }
        await vi.advanceTimersByTimeAsync(100);
        expect(calls).toHaveLength(1);
        expect(cache.getStatus().warming.skipReason).toBe("branch_change");
        expect(JSON.stringify(cache.getStatus())).not.toContain(
          "private predicate",
        );
      } finally {
        await cache.dispose();
      }
    },
  );

  it("shares one real request/warming service across two hosts and replays actual input only", async () => {
    const calls: Call[] = [];
    const handle = await runtime(client(calls));
    const hostA = { cache: handle.cache, client: handle.client };
    const hostB = { cache: handle.cache, client: handle.client };
    expect(hostA.cache).toBe(hostB.cache);
    expect(hostA.client).toBe(hostB.client);
    expect(handle.client).toBe(handle.cache.requests.client);
    await run(handle);
    expect(handle.cache.warming.getStatus().state).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toEqual(calls[0].messages);
    expect(calls[1].tools).toEqual(calls[0].tools);
    expect(calls[1].options).toMatchObject({
      warming: true,
      maxOutputTokens: 1,
      maxRetries: 0,
      systemPrompt: "actual system",
    });
    expect(
      handle.executionContext?.ledger.getEntries({ purpose: "main" }),
    ).toHaveLength(1);
    expect(
      handle.executionContext?.ledger.getEntries({
        purpose: "cache_warming",
      })[0].parentRunId,
    ).toBe(handle.executionContext?.runId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("streams during tools and cancels warming before the next actual main request", async () => {
    const started = gate(),
      finish = gate(),
      warmingStarted = gate();
    let foreground = 0,
      cancelled = false;
    const calls: Call[] = [];
    const llm = client(calls);
    llm.stream = async function* (conv, tools, signal, options) {
      calls.push({
        messages: structuredClone(conv.getMessages()),
        tools,
        options,
      });
      if (options?.warming) {
        warmingStarted.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          ),
        );
        return;
      }
      if (++foreground === 1) {
        yield {
          type: "tool_call_complete",
          toolName: "Slow",
          toolId: "slow",
          arguments: {},
        };
        yield end("tool_use");
      } else {
        expect(cancelled).toBe(true);
        yield end();
      }
    };
    const handle = await runtime(llm, provider("streaming"), {
      tools: [slow(started, finish)],
      toolNames: ["Slow"],
    });
    const running = run(handle);
    await Promise.race([
      started.promise,
      running.then((events) => {
        throw new Error(JSON.stringify(events));
      }),
    ]);
    expect(handle.cache.isForegroundActive).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await warmingStarted.promise;
    expect(calls[1].messages).toEqual(calls[0].messages);
    expect(calls[1].tools).toEqual(calls[0].tools);
    finish.resolve();
    await running;
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("idle mode schedules only after the root run and its tool settle", async () => {
    const started = gate(),
      finish = gate();
    let foreground = 0;
    const calls: Call[] = [];
    const llm = client(calls);
    llm.stream = async function* (conv, tools, _signal, options) {
      await Promise.resolve();
      calls.push({ messages: conv.getMessages(), tools, options });
      if (!options?.warming && ++foreground === 1) {
        yield {
          type: "tool_call_complete",
          toolName: "Slow",
          toolId: "slow",
          arguments: {},
        };
        yield end("tool_use");
      } else {
        yield end();
      }
    };
    const handle = await runtime(llm, provider(), {
      tools: [slow(started, finish)],
      toolNames: ["Slow"],
    });
    const running = run(handle);
    await Promise.race([
      started.promise,
      running.then((events) => {
        throw new Error(JSON.stringify(events));
      }),
    ]);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(1);
    finish.resolve();
    await running;
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(3);
  });

  it.each(["default_off", "unknown_price", "partial", "cancel"])(
    "does not pay for %s",
    async (variant) => {
      const calls: Call[] = [];
      const config = provider();
      if (variant === "default_off") {
        config.warming = undefined;
      }
      if (variant === "unknown_price") {
        config.price = undefined;
      }
      const llm = client(calls);
      if (variant === "partial") {
        llm.stream = async function* (_conv, tools, _signal, options) {
          await Promise.resolve();
          calls.push({ messages: [], tools, options });
          yield end("end_turn", false);
        };
      }
      const handle = await runtime(llm, config);
      await run(handle);
      if (variant === "cancel") {
        handle.abortForeground();
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(1);
      if (variant === "default_off") {
        expect(handle.getStatus().cache).toMatchObject({
          warmingMode: "off",
          warming: { state: "off" },
        });
      }
    },
  );

  it.each([
    "schema",
    "registry",
    "thinking",
    "compaction",
    "branch",
    "paused",
    "budget_limited",
    "host_exit",
    "stop",
  ])("invalidates scheduled warming for %s", async (reason) => {
    const calls: Call[] = [];
    const llm = client(calls);
    let thinking: ThinkingLevel = "off",
      exited = false;
    llm.getThinkingLevel = () => thinking;
    llm.setThinkingLevel = (level) => {
      thinking = level;
      return level;
    };
    const started = gate(),
      finish = gate();
    finish.resolve();
    const tool = slow(started, finish);
    const handle = await runtime(llm, provider(), {
      tools: [tool],
      toolNames: ["Slow"],
      cacheGuard: () => (exited ? "host_exit" : undefined),
    });
    await run(handle);
    if (reason === "schema") {
      tool.schema = () => ({
        name: "Slow",
        description: "changed",
        input_schema: { type: "object", properties: {} },
      });
    }
    if (reason === "registry") {
      handle.registry.invalidate();
    }
    if (reason === "thinking") {
      handle.client.setThinkingLevel?.("low");
    }
    if (reason === "compaction") {
      await handle.cache.handleAgentEvent({
        type: "compact",
        message: "compacted",
      });
    }
    if (reason === "branch") {
      await handle.cache.invalidate("branch_change");
    }
    if (reason === "paused" || reason === "budget_limited") {
      handle.goalManager?.set("fixture");
      handle.goalManager?.transition(reason);
      await handle.cache.handleAgentEvent({ type: "turn_complete" });
    }
    if (reason === "host_exit") {
      exited = true;
    }
    if (reason === "stop") {
      await handle.cache.pause();
      handle.cache.resume();
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
  });

  it("checks cancellation after asynchronous foreground preparation", async () => {
    const calls: Call[] = [];
    const handle = await runtime(client(calls));
    const preparing = gate(),
      release = gate();
    vi.spyOn(handle.cache.warming, "setForegroundActive").mockImplementation(
      async (active) => {
        if (active) {
          preparing.resolve();
          await release.promise;
        }
      },
    );
    const running = run(handle);
    const rejected = expect(running).rejects.toThrow();
    await preparing.promise;
    expect(handle.cache.isForegroundActive).toBe(true);
    handle.abortForeground();
    release.resolve();
    await rejected;
    expect(calls).toHaveLength(0);
  });

  it("rejects failed runs and iterator abandonment instead of scheduling idle warming", async () => {
    const calls: Call[] = [];
    const handle = await runtime(client(calls));
    const iterator = handle.run("abandoned", {
      onPermissionRequest: () => Promise.resolve("allow"),
    });
    await iterator.next();
    await iterator.return(undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(handle.cache.warming.getStatus().state).not.toBe("scheduled");
  });

  it("atomically installs provider/client/limits, cancels old warming and preserves same-client no-ops", async () => {
    const calls: Call[] = [],
      nextCalls: Call[] = [];
    const config = provider();
    const handle = await runtime(client(calls), config);
    await run(handle);
    const oldCache = handle.cache,
      oldClient = handle.client;
    const latest = oldCache.requests.getLatest();
    expect(await handle.updateProvider(config, oldClient)).toBe(oldClient);
    expect(handle.cache).toBe(oldCache);
    expect(oldCache.requests.getLatest()).toBe(latest);
    const invalid = structuredClone(config);
    Object.defineProperty(invalid, "protocol", { value: "invalid" });
    await expect(
      handle.updateProvider(invalid, client(nextCalls)),
    ).rejects.toThrow();
    expect(handle.cache).toBe(oldCache);
    const updated = { ...config, model: "new-model", context_window: 300000 };
    const result = await handle.updateProvider(updated, client(nextCalls));
    expect(result).toBe(handle.client);
    expect(result).toBe(handle.cache.client);
    expect(handle.cache).not.toBe(oldCache);
    expect(oldCache.warming.getStatus().state).toBe("disposed");
    expect(handle.provider.model).toBe("new-model");
    expect(handle.contextWindow).toBe(300000);
    expect(handle.getStatus().request).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    await expect(handle.updateProvider(config, oldClient)).rejects.toThrow(
      "untracked client",
    );
    await run(handle);
    expect(handle.getStatus().request?.model).toBe("new-model");
    expect(nextCalls).toHaveLength(1);
  });

  it("keeps selected protocol authoritative for injected clients and rejects mismatched transports before commit", async () => {
    const calls: Call[] = [],
      nextCalls: Call[] = [];
    const handle = await runtime(client(calls));
    await run(handle);
    const next = ProviderConfigSchema.parse({
      ...provider(),
      protocol: "openai",
      cache: undefined,
      warming: undefined,
    });
    await expect(
      handle.updateProvider(next, client(nextCalls)),
    ).rejects.toThrow("protocols differ");
    expect(handle.provider.protocol).toBe("anthropic");
    const injected = client(nextCalls);
    Reflect.deleteProperty(injected, "protocol");
    const tracked = await handle.updateProvider(next, injected);
    expect(tracked.protocol).toBe("openai");
    await run(handle);
    expect(nextCalls).toHaveLength(1);
  });

  it("joins running paid warming before committing a model switch and blocks overlapping foreground work", async () => {
    const calls: Call[] = [],
      nextCalls: Call[] = [];
    const warmed = gate(),
      cancelling = gate(),
      release = gate();
    const llm = client(calls);
    llm.stream = async function* (conv, tools, signal, options) {
      calls.push({ messages: conv.getMessages(), tools, options });
      if (options?.warming) {
        warmed.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              cancelling.resolve();
              reject(new Error("cancelled"));
            },
            { once: true },
          ),
        );
      } else {
        yield end();
      }
    };
    const handle = await runtime(llm);
    await run(handle);
    await vi.advanceTimersByTimeAsync(10);
    await warmed.promise;
    const old = handle.cache;
    const stopMemory = handle.stopMemoryTasks.bind(handle);
    vi.spyOn(handle, "stopMemoryTasks").mockImplementation(async () => {
      await release.promise;
      await stopMemory();
    });
    const switching = handle.updateProvider(
      { ...provider(), model: "second" },
      client(nextCalls),
    );
    await cancelling.promise;
    expect(handle.provider.model).toBe("fixture");
    expect(handle.cache).toBe(old);
    await expect(run(handle)).rejects.toThrow("already running");
    release.resolve();
    await switching;
    expect(old.getStatus().warming.state).toBe("disposed");
    expect(handle.provider.model).toBe("second");
    await run(handle);
    expect(nextCalls).toHaveLength(1);
  });

  it("clear gets a new cache/client/ledger and keeps inherited unbilled run relations", async () => {
    const calls: Call[] = [];
    const handle = await runtime(client(calls));
    await run(handle);
    const oldCache = handle.cache,
      oldClient = handle.client;
    const context = execution(handle);
    context.ledger.registerRun({
      sessionId: context.sessionId,
      runId: "unbilled-ancestor",
      parentRunId: context.runId,
    });
    await handle.clearConversation();
    expect(handle.client).not.toBe(oldClient);
    expect(handle.cache).not.toBe(oldCache);
    expect(oldCache.warming.getStatus().state).toBe("disposed");
    expect(handle.executionContext?.ledger.getRuns()).toContainEqual({
      sessionId: context.sessionId,
      runId: "unbilled-ancestor",
      parentRunId: context.runId,
    });
    expect(handle.getStatus().session?.cost.attempts).toBe(0);
    expect(handle.getStatus().history[0].cost.attempts).toBe(1);
    expect(handle.getStatus().request).toBeNull();
    await run(handle);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(3);
  });

  it.each([false, true])(
    "keeps TODO storage consistent before and after a reset when persist=%s",
    async (persist) => {
      const handle = await runtime(client([]), provider(), { persist });
      const board = handle.taskList;
      const originalId = board.boardId;
      board.write({ todos: [{ subject: "first task" }] });
      expect(existsSync(sessionPath(handle.sessionId, TASKS_FILENAME))).toBe(
        persist,
      );
      await handle.clearConversation();
      expect(handle.taskList).toBe(board);
      expect(board.boardId).not.toBe(originalId);
      expect(board.list()).toEqual([]);
      expect(board.write({ todos: [{ subject: "next task" }] })[0].id).toBe(
        "1",
      );
      expect(existsSync(sessionPath(handle.sessionId, TASKS_FILENAME))).toBe(
        persist,
      );
    },
  );

  it("repeated dispose joins cache before runtime cleanup without disposing borrowed clients", async () => {
    const calls: Call[] = [];
    const borrowed = { ...client(calls), dispose: vi.fn() };
    const handle = await runtime(borrowed);
    await run(handle);
    const stop = vi
      .spyOn(handle.backgroundTaskManager, "stopAll")
      .mockImplementation(() => {
        expect(handle.cache.warming.getStatus().state).toBe("disposed");
        return Promise.resolve();
      });
    const first = handle.dispose(),
      second = handle.dispose();
    expect(first).toBe(second);
    await first;
    expect(stop).toHaveBeenCalled();
    expect(borrowed.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
  });
});

describe("terminal-independent runtime status", () => {
  it("separates last actual context from descendant spending, session totals and inherited provenance", async () => {
    const calls: Call[] = [];
    const handle = await runtime(client(calls));
    await run(handle);
    const context = execution(handle);
    const ledger = context.ledger;
    withExecutionContext(
      { ...context, runId: "unbilled", parentRunId: context.runId },
      () => undefined,
    );
    const euro = ProviderConfigSchema.parse({
      ...provider(),
      price: { ...provider().price, currency: "EUR" },
    });
    const child = ledger.beginAttempt(
      {
        ...context,
        runId: "child",
        parentRunId: "unbilled",
        purpose: "subagent",
      },
      euro,
    );
    child.snapshot(
      {
        inputTokens: 20,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      { currency: "EUR", amount: 2 },
    );
    child.finish("completed", true);
    const unknown = ledger.beginAttempt(
      {
        ...context,
        runId: "unknown",
        parentRunId: "unbilled",
        purpose: "memory",
      },
      { ...provider(), price: undefined },
    );
    unknown.snapshot({ outputTokens: 4 });
    unknown.finish("error", false);
    const inherited = createCostLedger({
      sessionId: "historical",
      persist: false,
    });
    const previous = inherited.beginAttempt(
      {
        sessionId: "historical",
        runId: "previous",
        agentId: "main",
        purpose: "main",
      },
      provider(),
    );
    previous.snapshot({
      inputTokens: 30,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    previous.finish("completed", true);
    ledger.replay(inherited.getEntries(), inherited.getRuns());
    const status = getRuntimeStatus(handle);
    expect(status.request).toMatchObject({
      inputTotalTokens: 1005,
      cachePrefixTokens: 1000,
      contextTokens: 1006,
      usageComplete: true,
      observedAt: epoch,
      model: "fixture",
      contextWindow: 200000,
    });
    expect(status.run?.cost).toMatchObject({
      attempts: 3,
      incompleteAttempts: 1,
      unknownCurrencyEstimates: 1,
      unknownProviderAmounts: 2,
      providerReported: { EUR: { amount: 2, knownAmount: 2 } },
    });
    expect(Object.keys(status.run?.cost.estimated ?? {}).sort()).toEqual([
      "EUR",
      "USD",
    ]);
    expect(status.session?.cost.attempts).toBe(3);
    expect(status.history).toHaveLength(1);
    expect(status.history[0]).toMatchObject({
      sessionId: "historical",
      cost: { attempts: 1 },
    });
    expect(RuntimeStatusSchema.parse(status)).toEqual(status);
    expect(formatRuntimeStatus(status)).toMatch(
      /EUR|USD|incomplete|Historical sources: 1/,
    );
    expect(
      RuntimeStatusSchema.safeParse({
        ...status,
        cache: {
          ...status.cache,
          warming: { ...status.cache.warming, identity: "private-cache-key" },
        },
      }).success,
    ).toBe(false);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(
      /never-expose|example\.invalid|actual prompt|actual system|input_schema|endpoint/,
    );
    expect(status.cache.policy).toMatchObject({
      mode: "short",
      ttlSeconds: 300,
      bestEffort: true,
    });
  });

  it("preserves partial/unknown usage and null price rather than claiming zero cost", async () => {
    const calls: Call[] = [];
    const llm = client(calls);
    llm.stream = async function* () {
      await Promise.resolve();
      yield { type: "usage_snapshot", usage: { outputTokens: 7 } };
      throw new Error("failed actual request");
    };
    const handle = await runtime(llm, { ...provider(), price: undefined });
    await run(handle);
    const status = handle.getStatus();
    expect(status.request).toMatchObject({
      usage: { outputTokens: 7 },
      usageComplete: false,
      inputTotalTokens: null,
      cachePrefixTokens: null,
      contextTokens: null,
    });
    expect(status.request?.usage).not.toHaveProperty("inputTokens");
    expect(RuntimeStatusSchema.parse(status)).toEqual(status);
    expect(formatRuntimeStatus(status)).toContain(
      "unknown in / 7 out · partial",
    );
    expect(formatRuntimeStatus(status)).toContain("unknown currency/price");
    expect(status.session?.cost).toMatchObject({
      incompleteAttempts: 1,
      estimated: {},
      unknownCurrencyEstimates: 1,
      unknownProviderAmounts: 1,
    });
    expect(status.cache.warming.state).not.toBe("scheduled");
  });
});
