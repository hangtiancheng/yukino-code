import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { COST_FORMAT } from "@/cost/constants.js";
import { withExecutionContext } from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import { estimateUsage, snapshotPrice } from "@/cost/pricing.js";
import type { UsageSnapshot } from "@/cost/types.js";
import { normalizeAnthropicUsage, normalizeOpenAIUsage } from "@/llm/events.js";

const now = Date.parse("2026-01-01T00:00:00Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function provider(): ProviderConfig {
  return ProviderConfigSchema.parse({
    name: "priced",
    protocol: "anthropic",
    base_url: "https://example.invalid",
    model: "opaque",
    price: {
      currency: "USD",
      source: "local declaration",
      effective_at: "2025-01-01T00:00:00Z",
      input: 2,
      output: 10,
      cache_read: 0.2,
      cache_write: 3,
      cache_creation_ttl: [
        { ttl_seconds: 300, rate: 3 },
        { ttl_seconds: 3600, rate: 4 },
      ],
      tiers: [
        {
          above_input_tokens: 100,
          input: 4,
          output: 20,
          cache_read: 0.4,
          cache_creation_ttl: [
            { ttl_seconds: 300, rate: 6 },
            { ttl_seconds: 3600, rate: 8 },
          ],
        },
      ],
    },
  });
}
const usage: UsageSnapshot = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadInputTokens: 20,
  cacheCreationInputTokens: 30,
  cacheCreationByTTL: { "300": 10, "3600": 20 },
  reasoningTokens: 4,
};
const context = {
  sessionId: "session",
  runId: "main-run",
  agentId: "agent",
  purpose: "main" as const,
};

function persistentPath(): string {
  const root = mkdtempSync(join(tmpdir(), "yukino-cost-"));
  roots.push(root);
  return join(root, "ledger.jsonl");
}

describe("explicit pricing and normalized usage", () => {
  it("normalizes all three protocols without double-counting cache or reasoning", () => {
    expect(
      normalizeAnthropicUsage(
        {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 10,
            ephemeral_1h_input_tokens: 20,
          },
        },
        true,
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheCreationByTTL: { "300": 10, "3600": 20 },
    });
    for (const normalized of [
      normalizeOpenAIUsage({
        input_tokens: 30,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 4 },
      }),
      normalizeOpenAIUsage({
        prompt_tokens: 30,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 4 },
      }),
    ]) {
      expect(normalized).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        reasoningTokens: 4,
      });
    }
  });
  it("uses whole-request context tiers and itemized TTL rates", () => {
    const price = snapshotPrice(provider(), now);
    expect(estimateUsage(usage, price).amount).toBeCloseTo(184 / 1_000_000);
    expect(
      estimateUsage({ ...usage, inputTokens: 60 }, price).amount,
    ).toBeCloseTo(568 / 1_000_000);
    expect(
      estimateUsage({ ...usage, cacheCreationByTTL: undefined }, price).amount,
    ).toBeNull();
    expect(
      estimateUsage({ ...usage, cacheCreationByTTL: { "999": 30 } }, price)
        .amount,
    ).toBeNull();
  });
  it("never guesses price, currency, missing usage, or expired prices", () => {
    const config = provider();
    expect(snapshotPrice({ ...config, price: undefined }, now)).toBeNull();
    expect(
      estimateUsage(usage, {
        ...config.price,
        currency: null,
        source: "unknown",
        effective_at: "2025-01-01T00:00:00Z",
      }),
    ).toEqual({ currency: null, amount: null });
    expect(
      estimateUsage({ inputTokens: 1 }, config.price ?? null).amount,
    ).toBeNull();
    expect(
      snapshotPrice(config, Date.parse("2024-01-01T00:00:00Z")),
    ).toBeNull();
    expect(
      snapshotPrice(
        {
          ...config,
          price: {
            ...config.price,
            currency: "USD",
            source: "expired",
            effective_at: "2025-01-01T00:00:00Z",
            effective_until: "2026-01-01T00:00:00Z",
          },
        },
        now,
      ),
    ).toBeNull();
    expect(
      ProviderConfigSchema.safeParse({
        ...config,
        price: { ...config.price, input: -1 },
      }).success,
    ).toBe(false);
  });
});

describe("append-only execution ledger", () => {
  it("merges cumulative snapshots, commits once and stores provider money separately", () => {
    const path = persistentPath();
    const ledger = createCostLedger({
      sessionId: "session",
      persist: path,
      clock: () => now,
    });
    const attempt = ledger.beginAttempt(context, provider());
    attempt.snapshot(usage, { currency: "EUR", amount: 0.7 });
    const lines = readFileSync(path, "utf8").split("\n").length;
    attempt.snapshot(usage, { currency: "EUR", amount: 0.7 });
    expect(readFileSync(path, "utf8").split("\n").length).toBe(lines);
    attempt.snapshot({ outputTokens: 8 });
    attempt.finish("completed", true);
    attempt.finish("completed", true);
    attempt.snapshot({ outputTokens: 100 });
    expect(ledger.summary()).toMatchObject({
      attempts: 1,
      requests: 1,
      incompleteAttempts: 0,
      usage: { outputTokens: 8 },
      providerReported: { EUR: { amount: 0.7 } },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = createCostLedger({ sessionId: "session", persist: path });
    expect(reopened.getEntries()).toEqual(ledger.getEntries());
    expect(readFileSync(path, "utf8")).not.toContain("api_key");
  });
  it("keeps historical price snapshots immutable and fork replay idempotent", () => {
    const config = provider();
    const ledger = createCostLedger({ sessionId: "session", clock: () => now });
    const attempt = ledger.beginAttempt(context, config);
    if (config.price) {
      config.price.output = 999;
    }
    attempt.snapshot(usage);
    attempt.finish("completed", true);
    const original = ledger.getEntries();
    const fork = createCostLedger({
      sessionId: "fork",
      persist: persistentPath(),
    });
    fork.replay(original);
    fork.replay(original);
    expect(fork.summary().attempts).toBe(1);
    expect(fork.summary().estimated).toEqual(ledger.summary().estimated);
    expect(fork.getEntries()[0].price?.output).toBe(10);
  });
  it("separates currencies, unknown attempts and delegated runs", () => {
    const ledger = createCostLedger({ sessionId: "session", clock: () => now });
    for (const currency of ["USD", "EUR", null]) {
      const config = provider();
      if (config.price) {
        config.price.currency = currency;
      }
      const attempt = ledger.beginAttempt(
        {
          ...context,
          runId: String(currency),
          parentRunId: "main-run",
          purpose: "subagent",
        },
        config,
      );
      attempt.snapshot(usage);
      attempt.finish("completed", true);
    }
    const summary = ledger.summary({
      runId: "main-run",
      includeDescendants: true,
    });
    expect(Object.keys(summary.estimated).sort()).toEqual(["EUR", "USD"]);
    expect(summary.unknownCurrencyEstimates).toBe(1);
    expect(summary.attempts).toBe(3);
    expect(ledger.summary({ runId: "main-run" }).attempts).toBe(0);
  });
  it("preserves pending/partial history without inventing final usage", () => {
    const path = persistentPath();
    const ledger = createCostLedger({
      sessionId: "session",
      persist: path,
      clock: () => now,
    });
    const attempt = ledger.beginAttempt(context, provider());
    attempt.snapshot({ inputTokens: 12 });
    const resumed = createCostLedger({ sessionId: "session", persist: path });
    expect(resumed.getEntries()[0]).toMatchObject({
      outcome: "incomplete",
      usageComplete: false,
      usage: { inputTokens: 12 },
      estimate: { amount: null },
    });
  });
  it("keeps unknown currency totals null and merges partial TTL buckets cumulatively", () => {
    const ledger = createCostLedger({ sessionId: "session", clock: () => now });
    const partial = ledger.beginAttempt(context, provider());
    partial.snapshot({ inputTokens: 1 });
    partial.finish("error");
    expect(ledger.summary().estimated.USD).toEqual({
      amount: null,
      knownAmount: 0,
      unknownAttempts: 1,
    });
    const complete = ledger.beginAttempt(context, provider());
    complete.snapshot({ ...usage, cacheCreationByTTL: { "300": 10 } });
    complete.snapshot({ cacheCreationByTTL: { "3600": 20 } });
    complete.snapshot({ cacheCreationByTTL: { "3600": 20 } });
    complete.finish("completed", true);
    expect(ledger.getEntries()[1].usage?.cacheCreationByTTL).toEqual({
      "300": 10,
      "3600": 20,
    });
    expect(ledger.summary().estimated.USD.amount).toBeNull();
    expect(ledger.summary().estimated.USD.knownAmount).toBeCloseTo(
      184 / 1_000_000,
    );
  });
  it("rejects replay with a different price snapshot for an existing attempt", () => {
    const ledger = createCostLedger({ sessionId: "session", clock: () => now });
    const attempt = ledger.beginAttempt(context, provider());
    attempt.snapshot(usage);
    attempt.finish("completed", true);
    const entries = ledger.getEntries();
    if (entries[0].price) {
      entries[0].price.output = 999;
    }
    expect(() => {
      ledger.replay(entries);
    }).toThrow("snapshot changed");
  });
  it("persists unbilled run parents under the attempt lock and imports them without new spending", () => {
    const path = persistentPath();
    const first = createCostLedger({
      sessionId: "session",
      persist: path,
      clock: () => now,
    });
    const second = createCostLedger({
      sessionId: "session",
      persist: path,
      clock: () => now,
    });
    first.registerRun({
      sessionId: "session",
      runId: "workflow",
      parentRunId: context.runId,
    });
    second.registerRun({
      sessionId: "session",
      runId: "nested-workflow",
      parentRunId: "workflow",
    });
    const attempt = first.beginAttempt(
      {
        ...context,
        runId: "paid-child",
        parentRunId: "nested-workflow",
        purpose: "workflow",
      },
      provider(),
    );
    attempt.snapshot(usage);
    attempt.finish("completed", true);
    second.registerRun(context);
    const history = readFileSync(path, "utf8");
    first.registerRun({
      sessionId: "session",
      runId: "workflow",
      parentRunId: context.runId,
    });
    expect(readFileSync(path, "utf8")).toBe(history);
    const reopened = createCostLedger({ sessionId: "session", persist: path });
    const total = reopened.summary();
    expect(total).toMatchObject({ attempts: 1, requests: 1 });
    for (const runId of [context.runId, "workflow", "nested-workflow"]) {
      expect(reopened.summary({ runId, includeDescendants: true })).toEqual(
        total,
      );
      expect(reopened.summary({ runId }).attempts).toBe(0);
    }
    const forkPath = persistentPath();
    const fork = createCostLedger({ sessionId: "fork", persist: forkPath });
    fork.replay(reopened.getEntries(), reopened.getRuns());
    const imported = readFileSync(forkPath, "utf8");
    fork.replay(reopened.getEntries(), reopened.getRuns());
    expect(readFileSync(forkPath, "utf8")).toBe(imported);
    expect(
      fork.summary({ runId: context.runId, includeDescendants: true }),
    ).toEqual(total);
    expect(
      createCostLedger({ sessionId: "fork", persist: forkPath }).getRuns(),
    ).toEqual(reopened.getRuns());
  });

  it("validates run ownership, identities and cycles without appending invalid or duplicate records", () => {
    const path = persistentPath();
    const ledger = createCostLedger({ sessionId: "session", persist: path });
    const a = { sessionId: "session", runId: "A", parentRunId: "B" };
    ledger.registerRun(a);
    const history = readFileSync(path, "utf8");
    ledger.registerRun(a);
    expect(readFileSync(path, "utf8")).toBe(history);
    for (const run of [
      { ...a, parentRunId: "C" },
      { ...a, runId: "B", parentRunId: "A" },
      { ...a, runId: "C", parentRunId: "C" },
      { ...a, runId: "" },
      { ...a, parentRunId: "" },
      { ...a, sessionId: "foreign" },
    ]) {
      expect(() => {
        ledger.registerRun(run);
      }).toThrow();
      expect(readFileSync(path, "utf8")).toBe(history);
    }
    expect(() => {
      withExecutionContext(
        { ...context, ledger, sessionId: "foreign" },
        () => undefined,
      );
    }).toThrow("session IDs differ");
    expect(ledger.summary()).toMatchObject({ attempts: 0, requests: 0 });
    expect(
      ledger.summary({ runId: "B", includeDescendants: true }).attempts,
    ).toBe(0);
  });

  it("rejects malformed persisted run graphs and invalid shared revisions", () => {
    for (const records of [
      [{ runId: "A", parentRunId: "A" }],
      [
        { runId: "A", parentRunId: "B" },
        { runId: "B", parentRunId: "A" },
      ],
      [
        { runId: "A", parentRunId: "B" },
        { runId: "A", parentRunId: "C" },
      ],
      [{ runId: "A", parentRunId: "" }],
    ]) {
      const path = persistentPath();
      writeFileSync(
        path,
        records
          .map((run, index) =>
            JSON.stringify({
              format: COST_FORMAT,
              revision: index + 1,
              type: "run",
              run: { sessionId: "session", ...run },
            }),
          )
          .join("\n") + "\n",
        { mode: 0o600 },
      );
      expect(() =>
        createCostLedger({ sessionId: "session", persist: path }),
      ).toThrow();
    }
    const path = persistentPath();
    writeFileSync(
      path,
      JSON.stringify({
        format: COST_FORMAT,
        revision: 2,
        type: "run",
        run: { sessionId: "session", runId: "A" },
      }) + "\n",
      { mode: 0o600 },
    );
    expect(() =>
      createCostLedger({ sessionId: "session", persist: path }),
    ).toThrow("Invalid execution ledger revision");
  });

  it("reopens identical run records without attempts and walks deep ancestry iteratively", () => {
    const path = persistentPath();
    writeFileSync(
      path,
      [1, 2]
        .map((revision) =>
          JSON.stringify({
            format: COST_FORMAT,
            revision,
            type: "run",
            run: { sessionId: "session", runId: context.runId },
          }),
        )
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    const resumed = createCostLedger({ sessionId: "session", persist: path });
    expect(resumed.getRuns()).toHaveLength(1);
    expect(resumed.summary().attempts).toBe(0);
    const ledger = createCostLedger({ sessionId: "session", clock: () => now });
    for (let index = 512; index > 0; index--) {
      ledger.registerRun({
        sessionId: "session",
        runId: `run-${index}`,
        parentRunId: `run-${index - 1}`,
      });
    }
    const attempt = ledger.beginAttempt(
      { ...context, runId: "paid-leaf", parentRunId: "run-512" },
      provider(),
    );
    attempt.finish("error");
    expect(
      ledger.summary({ runId: "run-0", includeDescendants: true }).attempts,
    ).toBe(1);
    const exported = ledger.getRuns();
    exported[0].parentRunId = "foreign-root";
    expect(
      ledger.summary({ runId: "run-0", includeDescendants: true }).attempts,
    ).toBe(1);
    expect(() => {
      ledger.registerRun({
        sessionId: "session",
        runId: "run-0",
        parentRunId: "run-512",
      });
    }).toThrow("cycle");
  });

  it("keeps descendant graphs session-scoped when imported run IDs overlap", () => {
    const ledger = createCostLedger({ sessionId: "session", clock: () => now });
    const foreign = createCostLedger({
      sessionId: "foreign",
      clock: () => now,
    });
    ledger.registerRun({
      ...context,
      runId: "bridge",
      parentRunId: context.runId,
    });
    const localAttempt = ledger.beginAttempt(
      { ...context, runId: "child", parentRunId: "bridge" },
      provider(),
    );
    localAttempt.finish("error");
    const foreignAttempt = foreign.beginAttempt(
      {
        ...context,
        sessionId: "foreign",
        runId: "child",
        parentRunId: "other-root",
      },
      provider(),
    );
    foreignAttempt.finish("error");
    ledger.replay(foreign.getEntries(), foreign.getRuns());
    expect(ledger.summary().attempts).toBe(2);
    expect(
      ledger.summary({ runId: context.runId, includeDescendants: true })
        .attempts,
    ).toBe(1);
    expect(
      ledger.summary({ runId: "other-root", includeDescendants: true })
        .attempts,
    ).toBe(1);
  });

  it("serializes independent writers to the same ledger", () => {
    const path = persistentPath();
    const first = createCostLedger({
      sessionId: "session",
      persist: path,
      clock: () => now,
    });
    const second = createCostLedger({
      sessionId: "session",
      persist: path,
      clock: () => now,
    });
    const a = first.beginAttempt(context, provider());
    const b = second.beginAttempt(context, provider());
    a.snapshot(usage);
    b.snapshot(usage);
    a.finish("completed", true);
    b.finish("aborted");
    expect(first.summary().attempts).toBe(2);
    expect(second.summary().attempts).toBe(2);
  });
});
