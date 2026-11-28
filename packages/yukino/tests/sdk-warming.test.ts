import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SessionRequestTracker,
  type MainRequestSnapshot,
} from "@/cache/requests.js";
import {
  CacheWarmingScheduler,
  snapshotWarmingRequest,
  type WarmingClock,
} from "@/cache/warming.js";
import {
  ProviderConfigSchema,
  type ProviderConfig,
  type ThinkingLevel,
} from "@/config/provider-config.js";
import { ConversationManager, type Message } from "@/conversation/index.js";
import { withExecutionContext } from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import { observeRequests } from "@/cost/requests.js";
import {
  measureClient,
  type LLMClient,
  type LLMStreamOptions,
} from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import type { AgentSession } from "@/sdk/agent-session.js";
import * as sdkFactory from "@/sdk/factory.js";
import { createAgentSession, type SessionEnvironment } from "@/sdk/factory.js";
import { getYukinoDir } from "@/storage/index.js";
import type { ProviderToolSchema, Tool } from "@/tools/types.js";

const epoch = Date.parse("2026-01-01T00:00:00Z");
const sessions: AgentSession[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function provider(mode: "idle" | "streaming" | "off" = "idle"): ProviderConfig {
  return ProviderConfigSchema.parse({
    name: "fixture",
    protocol: "anthropic",
    model: "fixture",
    base_url: "https://example.invalid",
    api_key: "mock",
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
        long: { ttl_seconds: 3600, min_tokens: 10 },
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
function end(
  inputTokens = 0,
  cached = 1000,
  stopReason = "end_turn",
): StreamEvent {
  return {
    type: "stream_end",
    stopReason,
    usage: {
      inputTokens,
      outputTokens: 1,
      cacheReadInputTokens: cached,
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
async function collect(iterator: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of iterator) {
    /* consume */
  }
}
class FakeClock implements WarmingClock {
  time = epoch;
  private id = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.time;
  }
  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.id;
    this.tasks.set(id, { at: this.time + delayMs, callback });
    return () => {
      this.tasks.delete(id);
    };
  }
  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (const [id, task] of this.tasks) {
      if (task.at <= this.time) {
        this.tasks.delete(id);
        task.callback();
      }
    }
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
  }
}
function candidate(request: MainRequestSnapshot) {
  const usage = request.usage;
  if (!usage || request.completedAt === undefined) {
    throw new Error("Missing completed request");
  }
  return {
    ...request,
    project: request.options.cacheScope?.project ?? "project",
    branch: request.options.cacheScope?.branch ?? "branch",
    inputTokens:
      usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens,
    cachedAt:
      usage.cacheReadInputTokens + usage.cacheCreationInputTokens > 0
        ? request.completedAt
        : Number.NaN,
    lastActivityAt: request.startedAt,
    parentRunId: request.context.runId,
  };
}
function tracked(client: LLMClient, config = provider()) {
  const clock = new FakeClock();
  const conv = new ConversationManager();
  conv.addUserMessage("first");
  const ledger = createCostLedger({
    sessionId: "session",
    clock: () => clock.now(),
    persist: false,
  });
  const tracker = new SessionRequestTracker({
    client: measureClient(client, config),
    provider: config,
    conversation: conv,
    sessionId: "session",
    systemPrompt: "system",
    now: () => clock.now(),
  });
  const scheduler = new CacheWarmingScheduler({
    client: tracker.client,
    provider: config,
    clock,
    context: {
      sessionId: "session",
      runId: "wrong-static-parent",
      purpose: "main",
      agentId: "main",
      ledger,
    },
  });
  tracker.setHandlers({
    start: () => scheduler.beginRequest(),
    finish: () => {
      scheduler.endRequest();
    },
    invalidate: (reason) => scheduler.invalidate(reason),
  });
  const run = (
    runId: string,
    purpose:
      "main" | "memory" | "subagent" | "compaction" | "cache_warming" = "main",
    options: LLMStreamOptions = {},
  ) =>
    withExecutionContext(
      {
        sessionId: "session",
        runId,
        agentId: purpose === "subagent" ? "child" : "main",
        purpose,
        ledger,
      },
      () => collect(tracker.client.stream(conv, [], undefined, options)),
    );
  const latest = () => {
    const request = tracker.getLatest();
    if (!request) {
      throw new Error("No real main request");
    }
    return request;
  };
  return { tracker, scheduler, clock, conv, ledger, run, latest };
}
interface Call {
  messages: Message[];
  tools: ProviderToolSchema[];
  options?: LLMStreamOptions;
  signal?: AbortSignal;
}
async function sdk(
  client: LLMClient,
  config = provider(),
  tools: Tool[] = [],
  signal?: AbortSignal,
) {
  const cwd = join(dirname(getYukinoDir()), "warming-project");
  mkdirSync(cwd, { recursive: true });
  const { session } = await createAgentSession({
    cwd,
    client,
    provider: config,
    persist: false,
    tools,
    systemPrompt: "actual system",
    signal,
  });
  sessions.push(session);
  return session;
}
function slowTool(
  started: ReturnType<typeof gate>,
  finish: ReturnType<typeof gate>,
): Tool {
  return {
    name: "Slow",
    description: "slow fixture",
    category: "read",
    schema: () => ({
      name: "Slow",
      description: "slow fixture",
      input_schema: { type: "object", properties: {} },
    }),
    execute: async () => {
      started.resolve();
      await finish.promise;
      return { output: "tool result", isError: false };
    },
  };
}

describe("true SDK request replay", () => {
  it("uses each runtime's cache services once, warms only after queued runs, and safely rebuilds on rollback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const environments: SessionEnvironment[] = [];
    const build = sdkFactory.buildSessionEnvironment;
    vi.spyOn(sdkFactory, "buildSessionEnvironment").mockImplementation(
      async (...args) => {
        const environment = await build(...args);
        environments.push(environment);
        return environment;
      },
    );
    const handlers = vi.spyOn(SessionRequestTracker.prototype, "setHandlers");
    const calls: LLMStreamOptions[] = [];
    const started = gate(),
      finish = gate();
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(_conv, _tools, _signal, options) {
        calls.push(options ?? {});
        if (calls.length === 1) {
          started.resolve();
          await finish.promise;
        }
        yield end();
      },
    };
    const session = await sdk(client);
    const first = environments[0];
    expect(first.requests).toBe(first.runtime.cache.requests);
    expect(first.warming).toBe(first.runtime.cache.warming);
    expect(first.runtime.client).toBe(first.runtime.cache.client);
    expect(handlers).toHaveBeenCalledOnce();
    const begin = vi.spyOn(first.runtime.cache, "beginRun");
    const endRun = vi.spyOn(first.runtime.cache, "endRun");
    const beginRequest = vi.spyOn(first.warming, "beginRequest");
    const endRequest = vi.spyOn(first.warming, "endRequest");
    const foreground = vi.spyOn(first.warming, "setForegroundActive");
    const schedule = vi.spyOn(first.warming, "schedule");
    const running = session.prompt("first");
    await started.promise;
    const queued = session.followUp("second");
    finish.resolve();
    await Promise.all([running, queued.completion]);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(endRun.mock.calls).toEqual([[true], [true]]);
    expect(beginRequest).toHaveBeenCalledTimes(2);
    expect(endRequest).toHaveBeenCalledTimes(2);
    expect(foreground.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((options) => options.warming)).toHaveLength(1);
    expect(session.getStats().attempts).toBe(3);
    const runtimeDispose = vi.spyOn(first.runtime, "dispose");
    const trackerDispose = vi.spyOn(first.requests, "dispose");
    await session.newSession();
    expect(trackerDispose).toHaveBeenCalledOnce();
    expect(runtimeDispose.mock.invocationCallOrder[0]).toBeLessThan(
      trackerDispose.mock.invocationCallOrder[0],
    );
    const second = environments[1];
    expect(second.runtime.cache).not.toBe(first.runtime.cache);
    expect(second.requests).toBe(second.runtime.cache.requests);
    expect(second.warming).toBe(second.runtime.cache.warming);
    expect(handlers).toHaveBeenCalledTimes(2);
    const status = vi.spyOn(second.runtime, "getStatus");
    expect(session.getStatus()).toEqual(second.runtime.getStatus());
    expect(status).toHaveBeenCalledTimes(2);
    const pause = vi.spyOn(second.runtime.cache, "pause");
    const resume = vi.spyOn(second.runtime.cache, "resume");
    await session.stopWarming();
    session.resumeWarming();
    expect(pause).toHaveBeenCalledWith("user_stopped");
    expect(resume).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(3);
    await session.prompt("rebuilt");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((options) => options.warming)).toHaveLength(2);
    const beforeRollback = session.getCostEntries();
    const secondDispose = vi.spyOn(second.runtime, "dispose");
    const secondTrackerDispose = vi.spyOn(second.requests, "dispose");
    await expect(
      session.setModel(provider(), {
        ...client,
        setSystemPrompt() {
          throw new Error("local rebuild failure");
        },
      }),
    ).rejects.toThrow("local rebuild failure");
    expect(secondTrackerDispose).toHaveBeenCalledOnce();
    expect(secondDispose.mock.invocationCallOrder[0]).toBeLessThan(
      secondTrackerDispose.mock.invocationCallOrder[0],
    );
    expect(environments).toHaveLength(3);
    expect(handlers).toHaveBeenCalledTimes(3);
    expect(session.getCostEntries()).toEqual(beforeRollback);
    await session.prompt("rollback continued");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((options) => options.warming)).toHaveLength(3);
    expect(session.getStats().attempts).toBe(beforeRollback.length + 2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns credential-free status snapshots while preserving ledger-backed stats", async () => {
    const secret = "sdk-private-status-token";
    const config = provider("off");
    config.api_key = secret;
    config.base_url = `https://status.invalid/mcp?token=${secret}`;
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream() {
        await Promise.resolve();
        yield { type: "text_delta", text: secret };
        yield end(7, 1000);
      },
    };
    const session = await sdk(client, config);
    expect(session.getStatus().request).toBeNull();
    const result = await session.prompt(`private prompt ${secret}`);
    const status = session.getStatus();
    expect(status).toMatchObject({
      sessionId: session.sessionId,
      request: {
        usage: { inputTokens: 7, cacheReadInputTokens: 1000 },
        inputTotalTokens: 1007,
        cachePrefixTokens: 1000,
        contextTokens: 1008,
      },
      run: {
        runId: result.runId,
        active: false,
        cost: session.getStats({
          runId: result.runId,
          includeDescendants: true,
        }),
      },
      session: { sessionId: session.sessionId, cost: session.getStats() },
      history: [],
      cache: { warmingMode: "off" },
    });
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(status.cache.warming).not.toHaveProperty("identity");
    expect(session.getCostEntries()[0].provider.endpoint).toContain(secret);
    if (status.request?.usage) {
      status.request.usage.inputTokens = 999;
    }
    if (status.session) {
      status.session.cost.attempts = 999;
    }
    expect(session.getStatus().request?.usage?.inputTokens).toBe(7);
    expect(session.getStats().attempts).toBe(1);
    session.resumeWarming();
    expect(session.getStatus().cache.warmingMode).toBe("off");
  });

  it("warms the latest of two prompts and a tool round, never the reply or aggregate usage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const calls: Call[] = [];
    let foreground = 0;
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(conv, tools, signal, options) {
        await Promise.resolve();
        calls.push({
          messages: structuredClone(conv.getMessages()),
          tools: structuredClone(tools),
          options,
          signal,
        });
        if (options?.warming) {
          yield end();
          return;
        }
        foreground++;
        if (foreground === 2) {
          yield {
            type: "tool_call_complete",
            toolName: "Slow",
            toolId: "slow",
            arguments: {},
          };
          yield end(0, 90_000, "tool_use");
        } else {
          yield { type: "text_delta", text: `reply ${foreground}` };
          yield end(5, foreground === 3 ? 100 : 2000);
        }
      },
    };
    const started = gate(),
      finish = gate();
    finish.resolve();
    const session = await sdk(client, provider(), [slowTool(started, finish)]);
    await session.prompt("first prompt");
    const result = await session.prompt("different second prompt");
    expect(result.usage.cacheReadInputTokens).toBe(90_100);
    expect(calls).toHaveLength(3);
    const expectedInput = structuredClone(calls[2].messages);
    await vi.advanceTimersByTimeAsync(10);
    const warm = calls[3];
    expect(warm.messages).toEqual(expectedInput);
    expect(warm.messages.some((message) => message.content === "reply 3")).toBe(
      false,
    );
    expect(warm.tools).toEqual(calls[2].tools);
    const originalOptions = { ...calls[2].options };
    delete originalOptions.attemptObserver;
    expect(warm.options).toMatchObject({
      ...originalOptions,
      systemPrompt: "actual system",
      maxOutputTokens: 1,
      maxRetries: 0,
      warming: true,
    });
    expect(warm.options?.attemptObserver).not.toBe(
      calls[2].options?.attemptObserver,
    );
    expect(warm.options?.cacheScope).toEqual(calls[2].options?.cacheScope);
    expect(session.getWarmingState().decision?.warmCost).toBeCloseTo(
      (105 * 0.1 + 2) / 1_000_000,
    );
    expect(session.getCostEntries({ purpose: "main" })).toHaveLength(3);
    expect(
      session.getCostEntries({ purpose: "cache_warming" })[0],
    ).toMatchObject({ parentRunId: result.runId, usage: { outputTokens: 1 } });
    expect(session.getMessages().at(-1)?.content).toBe("reply 3");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("streams warming during a long tool, then preempts it before the next foreground request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const toolStarted = gate(),
      finishTool = gate(),
      warmStarted = gate();
    const calls: Call[] = [];
    let foreground = 0,
      cancelled = false;
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(conv, tools, signal, options) {
        await Promise.resolve();
        calls.push({
          messages: structuredClone(conv.getMessages()),
          tools,
          options,
          signal,
        });
        if (options?.warming) {
          warmStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          });
          return;
        }
        foreground++;
        if (foreground === 1) {
          yield {
            type: "tool_call_complete",
            toolName: "Slow",
            toolId: "slow",
            arguments: {},
          };
          yield end(0, 1000, "tool_use");
        } else {
          expect(cancelled).toBe(true);
          yield { type: "text_delta", text: "final" };
          yield end();
        }
      },
    };
    const session = await sdk(client, provider("streaming"), [
      slowTool(toolStarted, finishTool),
    ]);
    const result = session.prompt("streaming tool prompt");
    await toolStarted.promise;
    expect(session.isBusy).toBe(true);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    await warmStarted.promise;
    expect(calls[1].messages).toEqual(calls[0].messages);
    expect(session.isBusy).toBe(true);
    finishTool.resolve();
    await result;
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(3);
    await session.stopWarming();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(3);
  });

  it("idle mode waits until the tool and run settle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const toolStarted = gate(),
      finishTool = gate();
    const calls: Call[] = [];
    let foreground = 0;
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(conv, tools, signal, options) {
        await Promise.resolve();
        calls.push({
          messages: structuredClone(conv.getMessages()),
          tools,
          signal,
          options,
        });
        if (!options?.warming && ++foreground === 1) {
          yield {
            type: "tool_call_complete",
            toolName: "Slow",
            toolId: "slow",
            arguments: {},
          };
          yield end(0, 1000, "tool_use");
        } else {
          yield end();
        }
      },
    };
    const session = await sdk(client, provider(), [
      slowTool(toolStarted, finishTool),
    ]);
    const result = session.prompt("idle prompt");
    await toolStarted.promise;
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toHaveLength(1);
    finishTool.resolve();
    await result;
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(3);
  });

  it.each(["off", "unknown_price", "unverified"])(
    "does not make warming calls for %s",
    async (variant) => {
      vi.useFakeTimers();
      vi.setSystemTime(epoch);
      const config = provider(variant === "off" ? "off" : "streaming");
      if (variant === "unknown_price") {
        config.price = undefined;
      }
      if (variant === "unverified") {
        config.cache = undefined;
      }
      const calls: LLMStreamOptions[] = [];
      const client: LLMClient = {
        supportsCacheWarming: true,
        setSystemPrompt() {},
        async *stream(_conv, _tools, _signal, options) {
          await Promise.resolve();
          calls.push(options ?? {});
          yield end();
        },
      };
      const session = await sdk(client, config);
      await session.prompt("main only");
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not wake a paused or budget-limited Goal or rearm after stop/resume", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const calls: LLMStreamOptions[] = [];
    let foreground = 0;
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(_conv, _tools, _signal, options) {
        await Promise.resolve();
        calls.push(options ?? {});
        if (++foreground === 1) {
          yield {
            type: "tool_call_complete",
            toolName: "PauseGoal",
            toolId: "pause",
            arguments: {},
          };
          yield end(0, 1000, "tool_use");
        } else {
          yield end();
        }
      },
    };
    const pause: Tool = {
      name: "PauseGoal",
      description: "pause fixture",
      category: "read",
      schema: () => ({
        name: "PauseGoal",
        description: "pause fixture",
        input_schema: { type: "object", properties: {} },
      }),
      execute: (ctx) => {
        ctx.goalManager?.transition("paused");
        return Promise.resolve({ output: "paused", isError: false });
      },
    };
    const session = await sdk(client, provider("streaming"), [pause]);
    await session.prompt("/goal goal fixture");
    const pausedCount = calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(pausedCount);
    await session.prompt("/goal replace --budget 1 budget fixture");
    const budgetCount = calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(budgetCount);
    expect(calls.some((options) => options.warming)).toBe(false);
    await session.stopWarming();
    session.resumeWarming();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(budgetCount);
  });

  it("cancels before replay when schemas change or the host signal aborts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const calls: LLMStreamOptions[] = [];
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(_conv, _tools, _signal, options) {
        await Promise.resolve();
        calls.push(options ?? {});
        yield end();
      },
    };
    const started = gate(),
      finish = gate();
    finish.resolve();
    const tool = slowTool(started, finish);
    const controller = new AbortController();
    const session = await sdk(client, provider(), [tool], controller.signal);
    await session.prompt("schema fixture");
    tool.schema = () => ({
      name: "Slow",
      description: "new schema",
      input_schema: {
        type: "object",
        properties: { newKey: { type: "string" } },
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    expect(session.getWarmingState().skipReason).toBe("schema_change");
    await session.prompt("host signal fixture");
    controller.abort();
    await session.waitForIdle();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
  });

  it.each(["thinking", "compact", "tree", "model", "trust", "host_exit"])(
    "invalidates scheduled warming on %s",
    async (variant) => {
      vi.useFakeTimers();
      vi.setSystemTime(epoch);
      let thinking: ThinkingLevel = "off";
      const calls: LLMStreamOptions[] = [];
      const client: LLMClient = {
        supportsCacheWarming: true,
        getThinkingLevel: () => thinking,
        setThinkingLevel: (level) => {
          thinking = level;
          return level;
        },
        setSystemPrompt() {},
        async *stream(_conv, _tools, _signal, options) {
          await Promise.resolve();
          calls.push(options ?? {});
          yield { type: "text_delta", text: "<summary>summary</summary>" };
          yield end();
        },
      };
      const session = await sdk(client);
      await session.prompt("cancellable");
      if (variant === "thinking") {
        session.setThinking("low");
      }
      if (variant === "compact") {
        await session.compact();
      }
      if (variant === "tree") {
        await session.newSession();
      }
      if (variant === "model") {
        await session.setModel(provider(), client);
      }
      if (variant === "trust") {
        await session.revokeProjectTrust();
      }
      if (variant === "host_exit") {
        await session.dispose();
      }
      const count = calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(count);
      expect(calls.some((options) => options.warming)).toBe(false);
    },
  );
});

describe("session-local request tracking and scheduler clock", () => {
  it("keeps original replay options, start/end times, price, and final per-request usage", async () => {
    const calls: Call[] = [];
    const started = gate(),
      finish = gate();
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(conv, tools, signal, options) {
        await Promise.resolve();
        calls.push({
          messages: structuredClone(conv.getMessages()),
          tools,
          options,
          signal,
        });
        if (!options?.warming) {
          started.resolve();
          await finish.promise;
        }
        yield { type: "usage_snapshot", usage: { cacheReadInputTokens: 9999 } };
        yield end(4, options?.warming ? 1000 : 500);
      },
    };
    const originalStream = Object.getOwnPropertyDescriptor(client, "stream");
    const { run, latest, tracker, scheduler, clock, conv, ledger } =
      tracked(client);
    const observer = { start: vi.fn(), snapshot: vi.fn(), complete: vi.fn() };
    const main = run("actual-parent", "main", {
      systemPrompt: "request system",
      cacheMode: "long",
      cacheTTLSeconds: 3600,
      cacheIdentity: "exact identity",
      cacheScope: { project: "actual project", branch: "actual branch" },
      maxOutputTokens: 300,
      answerReserveTokens: 70,
      maxRetries: 2,
      attemptObserver: observer,
    });
    await started.promise;
    await clock.advance(7);
    finish.resolve();
    await main;
    const request = latest();
    expect(request).toMatchObject({
      startedAt: epoch,
      completedAt: epoch + 7,
      usage: { inputTokens: 4, cacheReadInputTokens: 500 },
      price: provider().price,
    });
    expect(request.options).not.toHaveProperty("attemptObserver");
    conv.addAssistantFull("reply must not be replayed", [], []);
    expect(scheduler.schedule(candidate(request)).allowed).toBe(true);
    await clock.advance(10);
    expect(calls[1].messages).toEqual(calls[0].messages);
    expect(calls[1].options).toMatchObject({
      ...request.options,
      maxOutputTokens: 1,
      maxRetries: 0,
      warming: true,
    });
    expect(calls[1].options?.attemptObserver).not.toBe(observer);
    expect(Object.getOwnPropertyDescriptor(client, "stream")).toEqual(
      originalStream,
    );
    expect(tracker.getLatest()).toBe(request);
    expect(ledger.getEntries({ purpose: "cache_warming" })[0]).toMatchObject({
      parentRunId: "actual-parent",
    });
    await scheduler.dispose();
  });

  it("does not replace a main snapshot with memory, subagent, or warming requests", async () => {
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream() {
        await Promise.resolve();
        yield end();
      },
    };
    const { run, latest, scheduler } = tracked(client);
    await run("parent");
    const main = latest();
    await run("memory", "memory");
    await run("child", "subagent");
    await run("warm", "cache_warming");
    expect(latest()).toBe(main);
    await run("compact", "compaction");
    await scheduler.dispose();
  });

  it("forwards native observation and controls without double ledger entries", async () => {
    const config = provider();
    let thinking: ThinkingLevel = "low";
    const setSystemPrompt = vi.fn(),
      setMaxOutputTokens = vi.fn();
    const native: LLMClient = {
      protocol: "anthropic",
      observesRequests: true,
      supportsCacheWarming: true,
      setSystemPrompt,
      setThinkingLevel: (level) => {
        thinking = level;
        return level;
      },
      getThinkingLevel: () => thinking,
      getSupportedThinkingLevels: () => ["off", "low"],
      setMaxOutputTokens,
      getOutputBudget: () => ({ maxOutputTokens: 300, thinkingTokens: 100 }),
      stream: (_conv, _tools, signal, options) =>
        observeRequests(
          config,
          async function* (attempt) {
            await Promise.resolve();
            attempt.start();
            yield end();
          },
          signal,
          options,
        ),
    };
    const { run, tracker, ledger, scheduler } = tracked(native, config);
    await run("native");
    expect(ledger.getEntries()).toHaveLength(1);
    expect(tracker.client.observesRequests).toBe(true);
    expect(tracker.client.protocol).toBe("anthropic");
    expect(tracker.client.getOutputBudget?.()).toEqual({
      maxOutputTokens: 300,
      thinkingTokens: 100,
    });
    expect(tracker.client.getSupportedThinkingLevels?.()).toEqual([
      "off",
      "low",
    ]);
    expect(tracker.client.setThinkingLevel?.("off")).toBe("off");
    tracker.client.setMaxOutputTokens?.(7);
    expect(setMaxOutputTokens).toHaveBeenCalledWith(7);
    tracker.client.setSystemPrompt("new");
    expect(setSystemPrompt).toHaveBeenCalledWith("new");
    await scheduler.dispose();
  });

  it("request counting prevents concurrent main requests from releasing foreground early", async () => {
    const finishA = gate(),
      finishB = gate(),
      startedA = gate(),
      startedB = gate();
    let calls = 0;
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream() {
        const index = ++calls;
        (index === 1 ? startedA : startedB).resolve();
        await (index === 1 ? finishA : finishB).promise;
        yield end();
      },
    };
    const { run, tracker, latest, scheduler } = tracked(
      client,
      provider("streaming"),
    );
    const a = run("a"),
      b = run("b");
    await Promise.all([startedA.promise, startedB.promise]);
    finishB.resolve();
    await b;
    expect(tracker.active).toBe(1);
    expect(scheduler.schedule(candidate(latest()), "streaming").reason).toBe(
      "foreground_active",
    );
    finishA.resolve();
    await a;
    expect(tracker.active).toBe(0);
    expect(latest().context.runId).toBe("b");
    await scheduler.dispose();
  });

  it("bounds an uncooperative warming iterator and lets foreground cancel without hanging", async () => {
    const never = new Promise<void>(() => undefined);
    let calls = 0;
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(_conv, _tools, _signal, options) {
        calls++;
        if (options?.warming) {
          await never;
        }
        yield end();
      },
    };
    const { run, latest, scheduler, clock } = tracked(client);
    await run("main");
    scheduler.schedule(candidate(latest()));
    await clock.advance(10);
    expect(scheduler.getStatus().state).toBe("running");
    await run("preempt");
    expect(calls).toBe(3);
    scheduler.schedule(candidate(latest()));
    await clock.advance(10);
    await clock.advance(30_000);
    expect(scheduler.getStatus()).toMatchObject({
      state: "idle",
      skipReason: "cancelled",
    });
    await scheduler.dispose();
  });

  it("rejects snapshot getters, toJSON, cycles and excessive depth without executing them", () => {
    const conv = new ConversationManager();
    conv.addUserMessage("safe");
    const getter = vi.fn(() => "unsafe"),
      toJSON = vi.fn(() => ({}));
    const schema: ProviderToolSchema = {
      name: "Unsafe",
      description: "fixture",
      input_schema: { type: "object", properties: {} },
    };
    Object.defineProperty(schema.input_schema, "properties", {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      snapshotWarmingRequest(conv, [schema], {}, "system"),
    ).toThrow();
    expect(() =>
      snapshotWarmingRequest(
        conv,
        [],
        {
          cacheScope: Object.assign({ project: "p", branch: "b" }, { toJSON }),
        },
        "system",
      ),
    ).toThrow();
    const options: LLMStreamOptions = {};
    Object.defineProperty(options, "warming", {
      enumerable: true,
      get: getter,
    });
    expect(() => snapshotWarmingRequest(conv, [], options, "system")).toThrow();
    const cyclic: {
      type: "object";
      properties: Record<string, object>;
      [key: string]: unknown;
    } = { type: "object", properties: {} };
    cyclic.self = cyclic;
    expect(() =>
      snapshotWarmingRequest(
        conv,
        [{ ...schema, input_schema: cyclic }],
        {},
        "system",
      ),
    ).toThrow();
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      deep = { child: deep };
    }
    expect(() =>
      snapshotWarmingRequest(
        conv,
        [
          {
            ...schema,
            input_schema: { type: "object", properties: {}, nested: deep },
          },
        ],
        {},
        "system",
      ),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(conv.getMessages()).toEqual([{ role: "user", content: "safe" }]);
  });
});
