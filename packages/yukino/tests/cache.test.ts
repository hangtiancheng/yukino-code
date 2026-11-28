import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { CacheIdentityTracker, createCacheIdentity } from "@/cache/identity.js";
import { resolveCachePolicy } from "@/cache/policy.js";
import {
  CacheWarmingScheduler,
  warmingBenefit,
  type WarmingClock,
} from "@/cache/warming.js";
import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import { createCostLedger } from "@/cost/ledger.js";
import { snapshotPrice } from "@/cost/pricing.js";
import { createClient, type LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import type { ProviderToolSchema } from "@/tools/types.js";

vi.mock("@/config/index.js", () => ({
  resolveAPIKey: (provider: ProviderConfig) => provider.api_key,
}));

const epoch = Date.parse("2026-01-01T00:00:00Z");
afterEach(() => {
  vi.unstubAllGlobals();
});
function provider(
  protocol: ProviderConfig["protocol"] = "openai",
): ProviderConfig {
  return ProviderConfigSchema.parse({
    name: "not-a-provider-brand",
    protocol,
    model: "not-a-known-model",
    api_key: "mock",
    base_url: "https://example.invalid",
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
        mapping:
          protocol === "anthropic" ? "anthropic_ephemeral" : "openai_retention",
        short: { ttl_seconds: 300, min_tokens: 10 },
        long: {
          ttl_seconds: protocol === "anthropic" ? 3600 : 86400,
          min_tokens: 10,
        },
        replayable: true,
      },
    },
    warming: {
      mode: "idle",
      reuse_probability: 1,
      frequency_ms: 10,
      max_idle_ms: 100,
      net_benefit_threshold: 0,
    },
  });
}
function conversation(): ConversationManager {
  const conv = new ConversationManager();
  conv.addUserMessage("original");
  return conv;
}
async function collect(stream: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of stream) {
    /* consume */
  }
}

class FakeClock implements WarmingClock {
  time = epoch;
  private tasks = new Map<number, { callback: () => void; at: number }>();
  private id = 0;
  now(): number {
    return this.time;
  }
  schedule(callback: () => void, delay: number): () => void {
    const id = ++this.id;
    this.tasks.set(id, { callback, at: this.time + delay });
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
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  }
}
function setup(config = provider(), client?: LLMClient) {
  const clock = new FakeClock();
  const ledger = createCostLedger({
    sessionId: "session",
    clock: () => clock.now(),
  });
  const calls: { options: unknown; tools: unknown; messages: unknown }[] = [];
  const mock: LLMClient = client ?? {
    supportsCacheWarming: true,
    setSystemPrompt() {},
    async *stream(conv, tools, _signal, options) {
      await Promise.resolve();
      calls.push({ options, tools, messages: conv.getMessages() });
      conv.addUserMessage("must not pollute original");
      yield {
        type: "tool_call_complete",
        toolId: "never-execute",
        toolName: "WriteFile",
        arguments: {},
      };
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 1,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 0,
        },
      };
    },
  };
  const scheduler = new CacheWarmingScheduler({
    provider: config,
    client: mock,
    context: {
      sessionId: "session",
      runId: "parent",
      agentId: "agent",
      purpose: "main",
      ledger,
    },
    clock,
  });
  const conv = conversation();
  const candidate = {
    conversation: conv,
    tools: [],
    systemPrompt: "system",
    options: {
      systemPrompt: "system",
      cacheScope: { project: "/project", branch: "leaf" },
    },
    project: "/project",
    branch: "leaf",
    inputTokens: 1000,
    cachedAt: epoch,
    lastActivityAt: epoch,
    price: snapshotPrice(config, epoch),
  };
  return { scheduler, clock, ledger, calls, candidate, conv };
}

describe("capability-gated cache protocol", () => {
  it("disables absent/unverified/wrong protocol and wrong TTL metadata", () => {
    const config = provider();
    expect(
      resolveCachePolicy({ ...config, cache: undefined }, "long").mode,
    ).toBe("off");
    expect(resolveCachePolicy({ ...config, protocol: "anthropic" }).mode).toBe(
      "off",
    );
    const bad = provider();
    if (bad.cache?.capabilities?.long) {
      bad.cache.capabilities.long.ttl_seconds = 3600;
    }
    expect(resolveCachePolicy(bad, "long")).toMatchObject({
      mode: "off",
      reason: "unverified_or_unsupported",
    });
  });
  it.each(["anthropic", "openai", "openai-compat"] as const)(
    "maps only explicit %s cache capabilities for off/short/long",
    async (protocol) => {
      const config = provider(protocol);
      const events =
        protocol === "anthropic"
          ? [
              {
                type: "message_start",
                message: {
                  id: "msg",
                  type: "message",
                  role: "assistant",
                  model: "model",
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ]
          : protocol === "openai"
            ? [
                {
                  type: "response.completed",
                  response: {
                    status: "completed",
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
                },
              ]
            : [
                {
                  type: "chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                },
              ];
      const body = events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
      const fetchMock = vi.fn(
        (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
          Promise.resolve(
            new Response(body, {
              headers: { "content-type": "text/event-stream" },
            }),
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = await createClient(config, "system");
      const tools: ProviderToolSchema[] = [
        {
          name: "ReadFile",
          description: "read",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "ephemeral" },
        },
      ];
      for (const mode of ["off", "short", "long"] as const) {
        await collect(
          client.stream(conversation(), tools, undefined, {
            cacheMode: mode,
            cacheScope: { project: "p", branch: "b" },
          }),
        );
      }
      const pending = client.stream(conversation(), tools, undefined, {
        cacheScope: { project: "p", branch: "b" },
      });
      client.setSystemPrompt("changed after stream creation");
      await collect(pending);
      const payloads = fetchMock.mock.calls.map((call) =>
        JSON.stringify(JSON.parse(z.string().parse(call[1]?.body))),
      );
      if (protocol === "anthropic") {
        expect(payloads[0]).not.toContain("cache_control");
        expect(payloads[1]).toContain('"ttl":"5m"');
        expect(payloads[2]).toContain('"ttl":"1h"');
      } else {
        expect(payloads[0]).not.toContain("prompt_cache");
        expect(payloads[1]).toContain('"prompt_cache_retention":"in_memory"');
        expect(payloads[2]).toContain('"prompt_cache_retention":"24h"');
      }
      expect(payloads[3]).toBe(payloads[1]);
      expect(tools[0]).toHaveProperty("cache_control", { type: "ephemeral" });
    },
  );
  it.each(["anthropic", "openai", "openai-compat"] as const)(
    "sends a bounded native %s warming request without executing tools",
    async (protocol) => {
      const config = provider(protocol);
      const raw =
        protocol === "anthropic"
          ? [
              {
                type: "message_start",
                message: {
                  id: "msg",
                  type: "message",
                  role: "assistant",
                  model: "opaque",
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_input_tokens: 1000,
                  },
                },
              },
              {
                type: "message_delta",
                delta: { stop_reason: "max_tokens" },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ]
          : protocol === "openai"
            ? [
                {
                  type: "response.completed",
                  response: {
                    status: "completed",
                    usage: {
                      input_tokens: 1000,
                      output_tokens: 1,
                      input_tokens_details: { cached_tokens: 1000 },
                    },
                  },
                },
              ]
            : [
                {
                  type: "chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "length" }],
                  usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 1,
                    prompt_tokens_details: { cached_tokens: 1000 },
                  },
                },
              ];
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
          Promise.resolve(
            new Response(
              raw
                .map(
                  (event) =>
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            ),
          ),
        ),
      );
      const { scheduler, clock, ledger, candidate } = setup(
        config,
        await createClient(config, "system"),
      );
      scheduler.schedule(candidate);
      await clock.advance(10);
      await scheduler.cancel("test_complete");
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(z.string().parse(fetchMock.mock.calls[0][1]?.body)));
      expect(
        body[
          protocol === "anthropic"
            ? "max_tokens"
            : protocol === "openai"
              ? "max_output_tokens"
              : "max_completion_tokens"
        ],
      ).toBe(1);
      expect(body.tool_choice).toEqual(
        protocol === "anthropic" ? { type: "none" } : "none",
      );
      if (protocol !== "anthropic") {
        expect(body.store).toBe(false);
      }
      expect(ledger.getEntries()[0].purpose).toBe("cache_warming");
      await scheduler.dispose();
    },
  );
  it("hashes tools canonically and reports precise invalidation reasons", () => {
    const input = {
      provider: "p",
      endpoint: "e",
      model: "m",
      system: "s",
      tools: { b: 2, a: 1 },
      project: "p",
      branch: "b",
    };
    expect(createCacheIdentity(input)).toBe(
      createCacheIdentity({ ...input, tools: { a: 1, b: 2 } }),
    );
    const tracker = new CacheIdentityTracker();
    tracker.update(input);
    expect(
      tracker.update({ ...input, model: "new", branch: "other" })
        .invalidationReasons,
    ).toEqual(["model", "branch"]);
    expect(tracker.invalidate("project_change").invalidationReasons).toEqual([
      "project_change",
    ]);
  });
});

describe("standalone default-off warming", () => {
  it("applies the pure net benefit policy without currency conversion", () => {
    expect(
      warmingBenefit(
        0.5,
        { currency: "USD", amount: 10 },
        { currency: "USD", amount: 2 },
        { currency: "USD", amount: 1 },
        0,
      ),
    ).toMatchObject({ allowed: true, netBenefit: 3 });
    expect(
      warmingBenefit(
        1,
        { currency: "USD", amount: null },
        { currency: "USD", amount: 0 },
        { currency: "USD", amount: 0 },
        0,
      ).allowed,
    ).toBe(false);
    expect(
      warmingBenefit(
        1,
        { currency: "USD", amount: 10 },
        { currency: "EUR", amount: 0 },
        { currency: "USD", amount: 0 },
        0,
      ).allowed,
    ).toBe(false);
  });
  it("requires an explicit streaming-mode trigger and never starts automatically", async () => {
    const config = provider();
    if (config.warming) {
      config.warming.mode = "streaming";
    }
    const { scheduler, clock, calls, candidate } = setup(config);
    await clock.advance(10);
    expect(calls).toHaveLength(0);
    expect(scheduler.schedule(candidate, "idle").reason).toBe("mode_mismatch");
    expect(scheduler.schedule(candidate, "streaming").allowed).toBe(true);
    await clock.advance(10);
    expect(calls).toHaveLength(1);
    await scheduler.dispose();
  });
  it("never starts by construction or default-off configuration", async () => {
    const config = provider();
    config.warming = ProviderConfigSchema.parse({
      ...config,
      warming: {},
    }).warming;
    const { scheduler, calls, candidate, clock } = setup(config);
    expect(scheduler.schedule(candidate).allowed).toBe(false);
    await clock.advance(1000);
    expect(calls).toHaveLength(0);
    await scheduler.dispose();
  });
  it("uses an isolated replay, max one output, zero retries and warming ledger purpose", async () => {
    const { scheduler, clock, calls, ledger, candidate, conv } = setup();
    expect(scheduler.schedule(candidate).allowed).toBe(true);
    expect(scheduler.schedule(candidate).reason).toBe("deduplicated");
    await clock.advance(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({
      maxOutputTokens: 1,
      maxRetries: 0,
      warming: true,
      systemPrompt: "system",
    });
    expect(conv.getMessages()).toEqual([{ role: "user", content: "original" }]);
    expect(ledger.getEntries()[0]).toMatchObject({
      purpose: "cache_warming",
      parentRunId: "parent",
      usage: { outputTokens: 1 },
    });
    expect(scheduler.cost().attempts).toBe(1);
    expect(scheduler.getStatus().lastCost?.attempts).toBe(1);
    await scheduler.dispose();
    await clock.advance(1000);
    expect(calls).toHaveLength(1);
  });
  it.each(["budget_stop", "model_change", "tree_change", "project_change"])(
    "cancels scheduled warming for %s",
    async (reason) => {
      const { scheduler, calls, candidate, clock } = setup();
      scheduler.schedule(candidate);
      await scheduler.pause(reason);
      await clock.advance(1000);
      expect(calls).toHaveLength(0);
      expect(scheduler.getStatus()).toMatchObject({
        state: "paused",
        skipReason: reason,
      });
      await scheduler.dispose();
    },
  );
  it("enforces foreground priority, frequency and maximum idle with a fake clock", async () => {
    const { scheduler, clock, calls, candidate } = setup();
    await scheduler.setForegroundActive(true);
    expect(scheduler.schedule(candidate).reason).toBe("foreground_active");
    await scheduler.setForegroundActive(false);
    scheduler.schedule(candidate);
    await clock.advance(9);
    expect(calls).toHaveLength(0);
    await clock.advance(1);
    expect(calls).toHaveLength(1);
    await clock.advance(5);
    expect(calls).toHaveLength(1);
    await clock.advance(100);
    expect(calls).toHaveLength(1);
    expect(scheduler.getStatus().skipReason).toBe("max_idle");
    await scheduler.dispose();
  });
  it("skips unknown prices, unsupported replay, insufficient prefixes, expired TTL and negative benefit", async () => {
    for (const variant of [
      "price",
      "replay",
      "length",
      "expiry",
      "benefit",
    ] as const) {
      const config = provider();
      if (variant === "price") {
        config.price = undefined;
      }
      if (variant === "replay" && config.cache?.capabilities) {
        config.cache.capabilities.replayable = false;
      }
      if (variant === "benefit" && config.warming) {
        config.warming.reuse_probability = 0;
      }
      const { scheduler, candidate, calls, clock } = setup(config);
      if (variant === "length") {
        candidate.inputTokens = 1;
      }
      if (variant === "expiry") {
        candidate.cachedAt -= 300_000;
      }
      expect(scheduler.schedule(candidate).allowed).toBe(false);
      await clock.advance(10);
      expect(calls).toHaveLength(0);
      await scheduler.dispose();
    }
  });
  it("cancels an active real attempt and never reschedules after dispose", async () => {
    const client: LLMClient = {
      supportsCacheWarming: true,
      setSystemPrompt() {},
      async *stream(_conv, _tools, signal, options) {
        options?.attemptObserver?.snapshot({ inputTokens: 12 });
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
        yield { type: "text_delta", text: "unreachable" };
      },
    };
    const { scheduler, candidate, clock, ledger } = setup(provider(), client);
    scheduler.schedule(candidate);
    await clock.advance(10);
    expect(scheduler.getStatus().state).toBe("running");
    await scheduler.dispose();
    await clock.advance(1000);
    expect(scheduler.getStatus().state).toBe("disposed");
    expect(ledger.getEntries()).toHaveLength(1);
    expect(ledger.getEntries()[0]).toMatchObject({
      outcome: "aborted",
      usage: { inputTokens: 12 },
      purpose: "cache_warming",
    });
  });
});
