import { z } from "zod";

import type { RuntimeCacheStatus } from "@/cache/controller.js";
import type { RequestObservation } from "@/cache/requests.js";
import type { CostSummary } from "@/cost/types.js";
import type { AgentRuntime } from "@/runtime/types.js";

export interface RuntimeStatus {
  observedAt: number;
  sessionId: string;
  model: string;
  contextWindow: number;
  request:
    | (RequestObservation & {
        inputTotalTokens: number | null;
        cachePrefixTokens: number | null;
        contextTokens: number | null;
      })
    | null;
  run: { runId: string; active: boolean; cost: CostSummary } | null;
  session: { sessionId: string; cost: CostSummary } | null;
  history: { sessionId: string; cost: CostSummary }[];
  cache: RuntimeCacheStatus;
}

const count = z.number().int().nonnegative();
const usage = z.strictObject({
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  cacheReadInputTokens: count.optional(),
  cacheCreationInputTokens: count.optional(),
  cacheCreationByTTL: z.record(z.string(), count).optional(),
  reasoningTokens: count.optional(),
});
const amounts = z.record(
  z.string().regex(/^[A-Z]{3}$/u),
  z.strictObject({
    amount: z.number().nonnegative().nullable(),
    knownAmount: z.number().nonnegative(),
    unknownAttempts: count,
  }),
);
const costSummary = z.strictObject({
  attempts: count,
  requests: count,
  incompleteAttempts: count,
  usage: usage,
  estimated: amounts,
  providerReported: amounts,
  unknownCurrencyEstimates: count,
  unknownProviderAmounts: count,
});
export const RuntimeStatusSchema = z.strictObject({
  observedAt: count,
  sessionId: z.string(),
  model: z.string(),
  contextWindow: count,
  request: z
    .strictObject({
      runId: z.string(),
      sessionId: z.string(),
      model: z.string(),
      contextWindow: count,
      startedAt: count,
      observedAt: count,
      usage: usage.nullable(),
      usageComplete: z.boolean(),
      inputTotalTokens: count.nullable(),
      cachePrefixTokens: count.nullable(),
      contextTokens: count.nullable(),
    })
    .nullable(),
  run: z
    .strictObject({ runId: z.string(), active: z.boolean(), cost: costSummary })
    .nullable(),
  session: z
    .strictObject({ sessionId: z.string(), cost: costSummary })
    .nullable(),
  history: z.array(
    z.strictObject({ sessionId: z.string(), cost: costSummary }),
  ),
  cache: z.strictObject({
    policy: z.strictObject({
      mode: z.enum(["off", "short", "long"]),
      reason: z.string().optional(),
      ttlSeconds: count.optional(),
      minTokens: count.optional(),
      mapping: z.enum(["anthropic_ephemeral", "openai_retention"]).optional(),
      bestEffort: z.literal(true),
    }),
    warmingMode: z.enum(["off", "streaming", "idle"]),
    warming: z.strictObject({
      state: z.enum([
        "off",
        "scheduled",
        "running",
        "idle",
        "paused",
        "disposed",
      ]),
      skipReason: z.string().optional(),
      decision: z
        .strictObject({
          allowed: z.boolean(),
          reason: z.string().optional(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/u)
            .optional(),
          netBenefit: z.number().optional(),
          warmCost: z.number().nonnegative().optional(),
        })
        .optional(),
      lastCost: costSummary.optional(),
    }),
  }),
});

export async function controlRuntimeWarming(
  runtime: AgentRuntime,
  action: string,
): Promise<string> {
  const command = action.trim().toLowerCase();
  if (command === "stop") {
    await runtime.cache.pause("user_stopped");
  } else if (command === "resume") {
    runtime.cache.resume();
  } else if (command !== "" && command !== "status") {
    throw new Error("Usage: /warming [status|stop|resume]");
  }
  const status = runtime.cache.getStatus();
  return `Warming: ${status.warmingMode} / ${status.warming.state}${status.warming.skipReason ? ` · ${status.warming.skipReason}` : ""}`;
}

export function formatRuntimeStatus(status: RuntimeStatus): string {
  const money = (
    values: CostSummary["estimated"],
    unknownCurrency = 0,
    unknownLabel = "unknown currency/price",
  ): string => {
    const amounts = Object.entries(values).map(([currency, value]) =>
      value.amount === null
        ? `${currency} unknown (${String(value.unknownAttempts)} attempts${value.knownAmount > 0 ? `; known ${value.knownAmount.toPrecision(6)}` : ""})`
        : `${currency} ${value.amount.toPrecision(6)}`,
    );
    if (unknownCurrency) {
      amounts.push(`${unknownLabel} (${String(unknownCurrency)} attempts)`);
    }
    return amounts.join(" · ") || "no reported amount";
  };
  const costs = (label: string, cost: CostSummary): string[] => [
    `${label}: ${String(cost.requests)} requests / ${String(cost.attempts)} attempts${cost.incompleteAttempts ? ` · ${String(cost.incompleteAttempts)} incomplete` : ""}`,
    `  Estimate: ${money(cost.estimated, cost.unknownCurrencyEstimates)}`,
    `  Provider: ${money(cost.providerReported, cost.unknownProviderAmounts, "not supplied")}`,
  ];
  const request = status.request;
  const lines = [
    `Context (last actual request): ${request?.inputTotalTokens === undefined || request.inputTotalTokens === null ? "unknown" : String(request.inputTotalTokens)} in / ${request?.usage?.outputTokens === undefined ? "unknown" : String(request.usage.outputTokens)} out${request ? ` · ${request.usageComplete ? "complete" : "partial"}` : ""}`,
    `Cache prefix: ${request?.cachePrefixTokens === undefined || request.cachePrefixTokens === null ? "unknown" : String(request.cachePrefixTokens)} tokens`,
    ...(status.run
      ? costs("Root run including delegated work", status.run.cost)
      : ["Root run: not started"]),
    ...(status.session ? costs("Actual session", status.session.cost) : []),
    `Historical sources: ${String(status.history.length)} (not new spending)`,
    `Cache: ${status.cache.policy.mode}${status.cache.policy.ttlSeconds ? ` · TTL ${String(status.cache.policy.ttlSeconds)}s` : ""}`,
    `Warming: ${status.cache.warmingMode} / ${status.cache.warming.state}${status.cache.warming.skipReason ? ` · ${status.cache.warming.skipReason}` : ""}`,
  ];
  return lines.join("\n");
}

export function getRuntimeStatus(runtime: AgentRuntime): RuntimeStatus {
  const request = runtime.cache.requests.getObservation();
  const context = runtime.executionContext;
  const ledger = context?.ledger;
  const total = (...tokens: (number | undefined)[]): number | null =>
    tokens.every((value) => Number.isSafeInteger(value) && (value ?? -1) >= 0)
      ? tokens.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
  let rootRunId = context?.runId;
  if (context && ledger) {
    const runs = new Map(
      ledger
        .getRuns()
        .filter((run) => run.sessionId === context.sessionId)
        .map((run) => [run.runId, run]),
    );
    if (!runs.has(context.runId)) {
      rootRunId = undefined;
    }
    const visited = new Set<string>();
    while (rootRunId && !visited.has(rootRunId)) {
      visited.add(rootRunId);
      const parent = runs.get(rootRunId)?.parentRunId;
      if (!parent) {
        break;
      }
      rootRunId = parent;
    }
  }
  const sessionId = ledger?.sessionId ?? runtime.sessionId;
  const historicalSessions = new Set(
    ledger
      ?.getEntries()
      .filter((entry) => entry.sessionId !== sessionId)
      .map((entry) => entry.sessionId),
  );
  return {
    observedAt: Date.now(),
    sessionId: runtime.sessionId,
    model: runtime.provider.model,
    contextWindow: runtime.contextWindow,
    request: request
      ? {
          ...request,
          inputTotalTokens: total(
            request.usage?.inputTokens,
            request.usage?.cacheReadInputTokens,
            request.usage?.cacheCreationInputTokens,
          ),
          cachePrefixTokens: total(
            request.usage?.cacheReadInputTokens,
            request.usage?.cacheCreationInputTokens,
          ),
          contextTokens: total(
            request.usage?.inputTokens,
            request.usage?.outputTokens,
            request.usage?.cacheReadInputTokens,
            request.usage?.cacheCreationInputTokens,
          ),
        }
      : null,
    run:
      rootRunId && ledger
        ? {
            runId: rootRunId,
            active: runtime.cache.isForegroundActive,
            cost: ledger.summary({
              sessionId,
              runId: rootRunId,
              includeDescendants: true,
            }),
          }
        : null,
    session: ledger ? { sessionId, cost: ledger.summary({ sessionId }) } : null,
    history: ledger
      ? [...historicalSessions].map((id) => ({
          sessionId: id,
          cost: ledger.summary({ sessionId: id }),
        }))
      : [],
    cache: runtime.cache.getStatus(),
  };
}
