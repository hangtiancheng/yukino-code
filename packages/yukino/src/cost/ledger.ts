import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ProviderConfig } from "@/config/provider-config.js";
import { COST_DIRECTORY, COST_FORMAT } from "@/cost/constants.js";
import type { ExecutionContext } from "@/cost/context.js";
import { estimateUsage, snapshotPrice } from "@/cost/pricing.js";
import {
  CostEntrySchema,
  LedgerRecordSchema,
  MoneySchema,
  RunRelationSchema,
  UsageSnapshotSchema,
  type CostEntry,
  type CostSummary,
  type EntryFilter,
  type LedgerRecord,
  type Money,
  type RunRelation,
  type UsageSnapshot,
} from "@/cost/types.js";
import { getYukinoDir, projectKey } from "@/storage/index.js";
import { openPrivateFileSync, readPrivateFileSync } from "@/storage/private.js";
import { withFileSyncLock } from "@/teams/file-lock.js";

export interface CostLedgerOptions {
  sessionId: string;
  cwd?: string;
  persist?: boolean | string;
  clock?: () => number;
}

export interface AttemptObserver {
  readonly requestId: string;
  readonly attemptId: string;
  snapshot(usage: UsageSnapshot, providerAmount?: Money): void;
  finish(
    outcome: Exclude<CostEntry["outcome"], "pending">,
    usageComplete?: boolean,
  ): void;
}

export class ExecutionLedger {
  readonly sessionId: string;
  readonly path?: string;
  private readonly clock: () => number;
  private entries = new Map<string, CostEntry>();
  private runs = new Map<string, RunRelation>();
  private revision = 0;

  constructor(options: CostLedgerOptions) {
    if (!options.sessionId) {
      throw new Error("Ledger session ID is required");
    }
    this.sessionId = options.sessionId;
    this.clock = options.clock ?? Date.now;
    if (options.persist) {
      const fileName = `${createHash("sha256").update(options.sessionId).digest("hex")}.jsonl`;
      this.path =
        typeof options.persist === "string"
          ? options.persist
          : join(
              getYukinoDir(),
              COST_DIRECTORY,
              projectKey(options.cwd ?? process.cwd()),
              fileName,
            );
      if (!isAbsolute(this.path)) {
        throw new Error("Ledger persistence path must be absolute");
      }
      withFileSyncLock(this.path, () => {
        this.readHistory();
      });
    }
  }

  now(): number {
    return this.clock();
  }

  private readHistory(): void {
    if (!this.path || !existsSync(this.path)) {
      return;
    }
    const data = readPrivateFileSync(this.path, "utf8");
    if (data && !data.endsWith("\n")) {
      throw new Error("Truncated execution ledger; refusing to append");
    }
    this.entries.clear();
    this.runs.clear();
    this.revision = 0;
    for (const line of data.split("\n").filter(Boolean)) {
      const raw: unknown = JSON.parse(line);
      const record = LedgerRecordSchema.parse(raw);
      if (record.revision !== this.revision + 1) {
        throw new Error("Invalid execution ledger revision");
      }
      if (record.type === "run") {
        this.assertRun(record.run);
        this.runs.set(runKey(record.run), record.run);
      } else {
        if (!this.runs.has(runKey(record.entry))) {
          throw new Error("Execution ledger attempt has no registered run");
        }
        this.assertRun(runRelation(record.entry));
        const previous = this.entries.get(record.entry.attemptId);
        if (previous) {
          assertSameAttempt(previous, record.entry);
          if (
            previous.outcome !== "pending" &&
            JSON.stringify(previous) !== JSON.stringify(record.entry)
          ) {
            throw new Error("Execution ledger rewrites a finalized attempt");
          }
        }
        this.entries.set(record.entry.attemptId, record.entry);
      }
      this.revision = record.revision;
    }
  }

  private update(apply: () => void): void {
    if (this.path) {
      withFileSyncLock(this.path, () => {
        this.readHistory();
        apply();
      });
    } else {
      apply();
    }
  }

  private append(record: LedgerRecord): void {
    if (this.path) {
      const fd = openPrivateFileSync(this.path, "a");
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.revision = record.revision;
  }

  private assertRun(run: RunRelation): void {
    const existing = this.runs.get(runKey(run));
    if (existing) {
      if (existing.parentRunId !== run.parentRunId) {
        throw new Error("Execution ledger run parent changed");
      }
      return;
    }
    const visited = new Set([run.runId]);
    let parentRunId = run.parentRunId;
    while (parentRunId) {
      if (visited.has(parentRunId)) {
        throw new Error("Execution ledger run graph contains a cycle");
      }
      visited.add(parentRunId);
      parentRunId = this.runs.get(
        runKey({ sessionId: run.sessionId, runId: parentRunId }),
      )?.parentRunId;
    }
  }

  private saveRun(run: RunRelation): void {
    this.assertRun(run);
    const key = runKey(run);
    if (this.runs.has(key)) {
      return;
    }
    this.append({
      format: COST_FORMAT,
      revision: this.revision + 1,
      type: "run",
      run,
    });
    this.runs.set(key, structuredClone(run));
  }

  registerRun(context: RunRelation): void {
    const run = runRelation(context);
    if (run.sessionId !== this.sessionId) {
      throw new Error("Execution run session does not own this ledger");
    }
    this.update(() => {
      this.saveRun(run);
    });
  }

  getRuns(): RunRelation[] {
    this.update(() => undefined);
    return [...this.runs.values()].map((run) => structuredClone(run));
  }

  private save(value: CostEntry): void {
    const entry = CostEntrySchema.parse(value);
    const run = runRelation(entry);
    this.update(() => {
      const existing = this.entries.get(entry.attemptId);
      if (existing) {
        assertSameAttempt(existing, entry);
      }
      if (JSON.stringify(existing) === JSON.stringify(entry)) {
        return;
      }
      if (existing && existing.outcome !== "pending") {
        return;
      }
      this.saveRun(run);
      this.append({
        format: COST_FORMAT,
        revision: this.revision + 1,
        type: "attempt",
        entry,
      });
      this.entries.set(entry.attemptId, entry);
    });
  }

  beginAttempt(
    context: Omit<ExecutionContext, "ledger">,
    provider: ProviderConfig,
    requestId = randomUUID(),
    attempt = 0,
    cache?: { ttlSeconds?: number; identity?: string },
  ): AttemptObserver {
    if (context.sessionId !== this.sessionId) {
      throw new Error("Attempt session does not own this ledger");
    }
    const startedAt = this.now();
    const price = snapshotPrice(provider, startedAt);
    const entry: CostEntry = {
      sessionId: context.sessionId,
      runId: context.runId,
      parentRunId: context.parentRunId,
      agentId: context.agentId,
      purpose: context.purpose,
      requestId,
      attemptId: randomUUID(),
      attempt,
      provider: {
        name: provider.name,
        endpoint: provider.base_url,
        model: provider.model,
        protocol: provider.protocol,
      },
      startedAt,
      outcome: "pending",
      usage: null,
      usageComplete: false,
      price,
      estimate: { currency: price?.currency ?? null, amount: null },
      providerAmount: null,
      ...(cache?.ttlSeconds ? { cacheTTLSeconds: cache.ttlSeconds } : {}),
      ...(cache?.identity ? { cacheIdentity: cache.identity } : {}),
    };
    this.save(entry);
    let finished = false;
    return {
      requestId,
      attemptId: entry.attemptId,
      snapshot: (usage, providerAmount) => {
        if (finished) {
          return;
        }
        const snapshot = UsageSnapshotSchema.parse(usage);
        entry.usage = {
          ...entry.usage,
          ...snapshot,
          ...(snapshot.cacheCreationByTTL
            ? {
                cacheCreationByTTL: {
                  ...entry.usage?.cacheCreationByTTL,
                  ...snapshot.cacheCreationByTTL,
                },
              }
            : {}),
        };
        if (providerAmount) {
          entry.providerAmount = MoneySchema.parse(providerAmount);
        }
        entry.estimate = estimateUsage(
          entry.usage,
          entry.price,
          entry.cacheTTLSeconds,
        );
        this.save(entry);
      },
      finish: (outcome, usageComplete = false) => {
        if (finished) {
          return;
        }
        finished = true;
        entry.outcome = outcome;
        entry.endedAt = this.now();
        entry.usageComplete =
          usageComplete &&
          entry.usage !== null &&
          [
            entry.usage.inputTokens,
            entry.usage.outputTokens,
            entry.usage.cacheReadInputTokens,
            entry.usage.cacheCreationInputTokens,
          ].every((tokens) => tokens !== undefined);
        this.save(entry);
      },
    };
  }

  /** Include getRuns() when importing unbilled ancestors; attempt IDs and prices stay unchanged. */
  replay(
    entries: readonly CostEntry[],
    runs: readonly RunRelation[] = [],
  ): void {
    const relations = runs.map((run) => RunRelationSchema.parse(run));
    this.update(() => {
      for (const run of relations) {
        this.saveRun(run);
      }
    });
    for (const entry of entries) {
      this.save(entry);
    }
  }

  getEntries(filter: EntryFilter = {}): CostEntry[] {
    this.update(() => undefined);
    const runs = new Set<string>();
    if (filter.runId) {
      const children = new Map<string, string[]>();
      for (const run of this.runs.values()) {
        if (filter.sessionId && run.sessionId !== filter.sessionId) {
          continue;
        }
        runs.add(runKey({ sessionId: run.sessionId, runId: filter.runId }));
        if (run.parentRunId) {
          const parent = runKey({
            sessionId: run.sessionId,
            runId: run.parentRunId,
          });
          const descendants = children.get(parent) ?? [];
          descendants.push(runKey(run));
          children.set(parent, descendants);
        }
      }
      if (filter.includeDescendants) {
        const queue = [...runs];
        for (const parent of queue) {
          for (const child of children.get(parent) ?? []) {
            if (!runs.has(child)) {
              runs.add(child);
              queue.push(child);
            }
          }
        }
      }
    }
    return [...this.entries.values()]
      .filter(
        (entry) =>
          (!filter.runId || runs.has(runKey(entry))) &&
          ["sessionId", "parentRunId", "agentId", "purpose", "requestId"].every(
            (key) =>
              Reflect.get(filter, key) === undefined ||
              Reflect.get(filter, key) === Reflect.get(entry, key),
          ),
      )
      .map((entry) =>
        entry.outcome === "pending"
          ? { ...structuredClone(entry), outcome: "incomplete" as const }
          : structuredClone(entry),
      );
  }

  summary(filter: EntryFilter = {}): CostSummary {
    const entries = this.getEntries(filter);
    const result: CostSummary = {
      attempts: entries.length,
      requests: new Set(entries.map((entry) => entry.requestId)).size,
      incompleteAttempts: entries.filter((entry) => !entry.usageComplete)
        .length,
      usage: {},
      estimated: {},
      providerReported: {},
      unknownCurrencyEstimates: 0,
      unknownProviderAmounts: 0,
    };
    const addMoney = (target: CostSummary["estimated"], money: Money) => {
      if (!money.currency) {
        return false;
      }
      const total = target[money.currency] ?? {
        amount: 0,
        knownAmount: 0,
        unknownAttempts: 0,
      };
      if (money.amount === null) {
        total.unknownAttempts++;
        total.amount = null;
      } else {
        total.knownAmount += money.amount;
        if (total.amount !== null) {
          total.amount += money.amount;
        }
      }
      target[money.currency] = total;
      return true;
    };
    for (const entry of entries) {
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
      ] as const) {
        if (entry.usage?.[key] !== undefined) {
          result.usage[key] = (result.usage[key] ?? 0) + entry.usage[key];
        }
      }
      if (!addMoney(result.estimated, entry.estimate)) {
        result.unknownCurrencyEstimates++;
      }
      if (
        !entry.providerAmount ||
        !addMoney(result.providerReported, entry.providerAmount)
      ) {
        result.unknownProviderAmounts++;
      }
    }
    return result;
  }
}

function runKey(run: Pick<RunRelation, "sessionId" | "runId">): string {
  return JSON.stringify([run.sessionId, run.runId]);
}

function runRelation(context: RunRelation): RunRelation {
  return RunRelationSchema.parse({
    sessionId: context.sessionId,
    runId: context.runId,
    ...(context.parentRunId !== undefined
      ? { parentRunId: context.parentRunId }
      : {}),
  });
}

function assertSameAttempt(a: CostEntry, b: CostEntry): void {
  const immutable = (entry: CostEntry) => {
    const {
      usage: _usage,
      usageComplete: _usageComplete,
      outcome: _outcome,
      endedAt: _endedAt,
      estimate: _estimate,
      providerAmount: _providerAmount,
      ...identity
    } = entry;
    return JSON.stringify(identity);
  };
  if (immutable(a) !== immutable(b)) {
    throw new Error(
      "Execution ledger attempt identity or price snapshot changed",
    );
  }
}

export function createCostLedger(options: CostLedgerOptions): ExecutionLedger {
  return new ExecutionLedger(options);
}
