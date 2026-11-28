import { randomUUID } from "node:crypto";

import { WARMING_MAX_OUTPUT_TOKENS } from "@/cache/constants.js";
import { createCacheIdentity } from "@/cache/identity.js";
import { resolveCachePolicy } from "@/cache/policy.js";
import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { ConversationManager, type Message } from "@/conversation/index.js";
import { withExecutionContext, type ExecutionContext } from "@/cost/context.js";
import { estimateUsage, type PriceSnapshot } from "@/cost/pricing.js";
import type { CostSummary, Money, UsageSnapshot } from "@/cost/types.js";
import {
  measureClient,
  type LLMClient,
  type LLMStreamOptions,
} from "@/llm/client.js";
import {
  acquireSessionRunLease,
  type SessionRunLeaseHandle,
  type SessionStorageTarget,
} from "@/session/lease.js";
import { assertBoundedJson } from "@/session/records.js";
import type { ProviderToolSchema } from "@/tools/types.js";
import { cancelOnSignal } from "@/utils/cancel.js";

export interface WarmingClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface WarmingRequest {
  conversation: ConversationManager;
  tools: ProviderToolSchema[];
  systemPrompt: string;
  options: LLMStreamOptions;
}

export interface WarmingCandidate extends WarmingRequest {
  project: string;
  branch: string;
  inputTokens: number;
  cachedAt: number;
  lastActivityAt: number;
  price: PriceSnapshot | null;
  parentRunId?: string;
}

export function snapshotWarmingRequest(
  conversation: ConversationManager,
  tools: ProviderToolSchema[],
  options: LLMStreamOptions | undefined,
  systemPrompt: string,
): WarmingRequest {
  const replayOptions: LLMStreamOptions = {};
  if (options) {
    if (
      Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null
    ) {
      throw new Error("Invalid request options");
    }
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(options),
    )) {
      if (!("value" in descriptor)) {
        throw new Error("Request accessors are not allowed");
      }
      if (
        key !== "attemptObserver" &&
        key !== "signal" &&
        descriptor.enumerable
      ) {
        Object.defineProperty(replayOptions, key, descriptor);
      }
    }
  }
  const data = {
    messages: conversation.getMessages(),
    tools,
    options: replayOptions,
    systemPrompt,
  };
  assertBoundedJson(data);
  const snapshot = structuredClone(data);
  snapshot.options.systemPrompt ??= snapshot.systemPrompt;
  return {
    conversation: new ReplayConversation(snapshot.messages),
    tools: snapshot.tools,
    options: snapshot.options,
    systemPrompt: snapshot.options.systemPrompt,
  };
}

function snapshotCandidate(candidate: WarmingCandidate): WarmingCandidate {
  const request = snapshotWarmingRequest(
    candidate.conversation,
    candidate.tools,
    candidate.options,
    candidate.systemPrompt,
  );
  assertBoundedJson(candidate.price);
  return { ...candidate, ...request, price: structuredClone(candidate.price) };
}

export interface WarmingDecision {
  allowed: boolean;
  reason?: string;
  currency?: string;
  netBenefit?: number;
  warmCost?: number;
}

/** Pure policy: unknown money is not free and currencies are never converted. */
export function warmingBenefit(
  probability: number,
  miss: Money,
  hit: Money,
  warm: Money,
  threshold: number,
): WarmingDecision {
  if (
    !miss.currency ||
    miss.currency !== hit.currency ||
    miss.currency !== warm.currency ||
    miss.amount === null ||
    hit.amount === null ||
    warm.amount === null
  ) {
    return { allowed: false, reason: "unknown_price_or_currency" };
  }
  const netBenefit = probability * (miss.amount - hit.amount) - warm.amount;
  return {
    allowed: netBenefit > threshold,
    reason: netBenefit > threshold ? undefined : "below_threshold",
    currency: miss.currency,
    netBenefit,
    warmCost: warm.amount,
  };
}

class ReplayConversation extends ConversationManager {
  constructor(private readonly messages: Message[]) {
    super();
  }
  override getMessages(): Message[] {
    return structuredClone(this.messages);
  }
}

export interface WarmingStatus {
  state: "off" | "scheduled" | "running" | "idle" | "paused" | "disposed";
  skipReason?: string;
  identity?: string;
  decision?: WarmingDecision;
  lastCost?: CostSummary;
}

export class CacheWarmingScheduler {
  private readonly provider: ProviderConfig;
  private readonly client: LLMClient;
  private readonly context: ExecutionContext;
  private readonly clock: WarmingClock;
  private status: WarmingStatus = { state: "off", skipReason: "disabled" };
  private candidate?: WarmingCandidate;
  private cancelTimer?: () => void;
  private abortController?: AbortController;
  private running?: Promise<void>;
  private generation = 0;
  private paused = false;
  private foregroundActive = false;
  private foregroundRequests = 0;
  private readonly guard?: () => string | undefined;
  private readonly storageTarget?: SessionStorageTarget | null;
  private disposed = false;
  private lastWarm = new Map<string, number>();

  constructor(options: {
    provider: ProviderConfig;
    client: LLMClient;
    context: ExecutionContext;
    storageTarget?: SessionStorageTarget | null;
    clock?: WarmingClock;
    guard?: () => string | undefined;
  }) {
    this.provider = ProviderConfigSchema.parse(options.provider);
    this.client = measureClient(options.client, this.provider);
    this.context = options.context;
    this.storageTarget = options.storageTarget;
    this.guard = options.guard;
    this.clock = options.clock ?? {
      now: Date.now,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        timer.unref();
        return () => {
          clearTimeout(timer);
        };
      },
    };
    if (this.provider.warming?.mode && this.provider.warming.mode !== "off") {
      this.status = { state: "idle" };
    }
  }

  getStatus(): WarmingStatus {
    return structuredClone(this.status);
  }
  cost(): CostSummary {
    return this.context.ledger.summary({ purpose: "cache_warming" });
  }

  private decide(candidate: WarmingCandidate): WarmingDecision {
    const config = this.provider.warming;
    if (!config || config.mode === "off") {
      return { allowed: false, reason: "disabled" };
    }
    const reason = this.guard?.();
    if (reason) {
      return { allowed: false, reason };
    }
    const cache = resolveCachePolicy(
      this.provider,
      candidate.options.cacheMode,
    );
    if (
      cache.mode === "off" ||
      !this.provider.cache?.capabilities?.replayable ||
      !this.client.supportsCacheWarming
    ) {
      return { allowed: false, reason: "unsupported_replay" };
    }
    if (
      !Number.isSafeInteger(candidate.inputTokens) ||
      candidate.inputTokens < (cache.minTokens ?? 0)
    ) {
      return { allowed: false, reason: "below_min_length" };
    }
    const now = this.clock.now();
    if (now - candidate.lastActivityAt >= config.max_idle_ms) {
      return { allowed: false, reason: "max_idle" };
    }
    if (
      !Number.isFinite(candidate.cachedAt) ||
      candidate.cachedAt > now ||
      now - candidate.cachedAt >= (cache.ttlSeconds ?? 0) * 1000
    ) {
      return { allowed: false, reason: "expired_or_unknown_cache" };
    }
    const price =
      candidate.price &&
      now >= Date.parse(candidate.price.effective_at) &&
      (!candidate.price.effective_until ||
        now < Date.parse(candidate.price.effective_until))
        ? candidate.price
        : null;
    const base: UsageSnapshot = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const miss =
      cache.mapping === "anthropic_ephemeral"
        ? { ...base, cacheCreationInputTokens: candidate.inputTokens }
        : { ...base, inputTokens: candidate.inputTokens };
    const hit = { ...base, cacheReadInputTokens: candidate.inputTokens };
    return warmingBenefit(
      config.reuse_probability,
      estimateUsage(miss, price, cache.ttlSeconds),
      estimateUsage(hit, price),
      estimateUsage({ ...hit, outputTokens: WARMING_MAX_OUTPUT_TOKENS }, price),
      config.net_benefit_threshold,
    );
  }

  schedule(
    candidate: WarmingCandidate,
    trigger: "streaming" | "idle" = "idle",
  ): WarmingDecision {
    if (
      this.disposed ||
      this.paused ||
      this.foregroundRequests > 0 ||
      (trigger === "idle" && this.foregroundActive)
    ) {
      const reason = this.disposed
        ? "disposed"
        : this.paused
          ? (this.status.skipReason ?? "paused")
          : "foreground_active";
      this.status.skipReason = reason;
      return { allowed: false, reason };
    }
    if (!this.provider.warming || this.provider.warming.mode === "off") {
      this.status.skipReason = "disabled";
      return { allowed: false, reason: "disabled" };
    }
    if (this.provider.warming.mode !== trigger) {
      this.status.skipReason = "mode_mismatch";
      return { allowed: false, reason: "mode_mismatch" };
    }
    try {
      candidate = snapshotCandidate(candidate);
    } catch {
      this.status.skipReason = "unsafe_snapshot";
      return { allowed: false, reason: "unsafe_snapshot" };
    }
    const decision = this.decide(candidate);
    this.status.decision = decision;
    if (!decision.allowed) {
      this.status.skipReason = decision.reason;
      return decision;
    }
    const identity =
      candidate.options.cacheIdentity ??
      createCacheIdentity({
        provider: this.provider.name,
        endpoint: this.provider.base_url,
        model: this.provider.model,
        system: candidate.systemPrompt,
        tools: candidate.tools,
        project: candidate.project,
        branch: candidate.branch,
      });
    if (
      (this.status.state === "running" || this.status.state === "scheduled") &&
      this.status.identity === identity
    ) {
      if (this.status.state === "scheduled") {
        this.candidate = candidate;
      }
      return { ...decision, allowed: false, reason: "deduplicated" };
    }
    if (this.running) {
      this.abortController?.abort();
      return { ...decision, allowed: false, reason: "cancelling_previous" };
    }
    this.cancelTimer?.();
    this.generation++;
    this.candidate = candidate;
    this.status = {
      ...this.status,
      state: "scheduled",
      identity,
      decision,
      skipReason: undefined,
    };
    const frequency = this.provider.warming?.frequency_ms ?? 0;
    const last = this.lastWarm.get(identity);
    const delay =
      last === undefined
        ? frequency
        : Math.max(0, last + frequency - this.clock.now());
    this.arm(delay);
    return decision;
  }

  private arm(delay: number): void {
    const generation = this.generation;
    this.cancelTimer = this.clock.schedule(() => {
      this.cancelTimer = undefined;
      this.running = this.run(generation).finally(() => {
        this.running = undefined;
      });
    }, delay);
  }

  private async run(generation: number): Promise<void> {
    const candidate = this.candidate;
    if (
      !candidate ||
      generation !== this.generation ||
      this.paused ||
      this.disposed ||
      this.foregroundRequests > 0 ||
      (this.provider.warming?.mode === "idle" && this.foregroundActive)
    ) {
      return;
    }
    const decision = this.decide(candidate);
    if (!decision.allowed) {
      this.status = {
        ...this.status,
        state: "idle",
        skipReason: decision.reason,
        decision,
      };
      return;
    }
    this.status.state = "running";
    const controller = new AbortController();
    this.abortController = controller;
    const stopTimeout = this.clock.schedule(() => {
      controller.abort();
    }, 30_000);
    const runId = randomUUID();
    let lease: SessionRunLeaseHandle | undefined;
    try {
      if (this.storageTarget === undefined && this.context.ledger.path) {
        throw new Error(
          "Cache warming requires the root session storage target",
        );
      }
      lease = this.storageTarget
        ? acquireSessionRunLease(this.storageTarget, "warming")
        : undefined;
      await withExecutionContext(
        {
          ...this.context,
          runId,
          parentRunId: candidate.parentRunId ?? this.context.runId,
          purpose: "cache_warming",
        },
        async () => {
          const replay = snapshotWarmingRequest(
            candidate.conversation,
            candidate.tools,
            candidate.options,
            candidate.systemPrompt,
          );
          const iterator = this.client.stream(
            replay.conversation,
            replay.tools,
            controller.signal,
            {
              ...replay.options,
              maxOutputTokens: WARMING_MAX_OUTPUT_TOKENS,
              maxRetries: 0,
              warming: true,
            },
          );
          try {
            while (
              !(await cancelOnSignal(() => iterator.next(), controller.signal))
                .done
            ) {
              const reason = this.guard?.();
              if (reason) {
                controller.abort();
              }
              controller.signal.throwIfAborted();
            }
          } finally {
            if (controller.signal.aborted) {
              void iterator.return(undefined).catch(() => undefined);
            }
          }
        },
      );
      if (generation === this.generation && !controller.signal.aborted) {
        this.lastWarm.set(this.status.identity ?? "", this.clock.now());
        if (this.lastWarm.size > 128) {
          const oldest = this.lastWarm.keys().next().value;
          if (oldest !== undefined) {
            this.lastWarm.delete(oldest);
          }
        }
        const entries = this.context.ledger.getEntries({ runId });
        const confirmed = entries.some(
          (entry) =>
            entry.usageComplete &&
            (entry.usage?.cacheReadInputTokens ?? 0) +
              (entry.usage?.cacheCreationInputTokens ?? 0) >=
              candidate.inputTokens,
        );
        if (confirmed) {
          candidate.cachedAt = this.clock.now();
          this.status.state = "scheduled";
          this.arm(this.provider.warming?.frequency_ms ?? 0);
        } else {
          this.status = {
            ...this.status,
            state: "idle",
            skipReason: "unconfirmed_cache",
          };
        }
      }
    } catch {
      if (generation === this.generation) {
        this.status = {
          ...this.status,
          state: "idle",
          skipReason: controller.signal.aborted
            ? "cancelled"
            : "request_failed",
        };
      }
    } finally {
      stopTimeout();
      this.status.lastCost = this.context.ledger.summary({ runId });
      try {
        lease?.release();
      } finally {
        if (this.abortController === controller) {
          this.abortController = undefined;
        }
      }
    }
  }

  async cancel(reason: string): Promise<void> {
    this.generation++;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.candidate = undefined;
    this.abortController?.abort();
    this.status = {
      ...this.status,
      state: this.disposed
        ? "disposed"
        : this.paused
          ? "paused"
          : !this.provider.warming || this.provider.warming.mode === "off"
            ? "off"
            : "idle",
      skipReason: reason,
    };
    await this.running;
  }
  async pause(reason = "paused"): Promise<void> {
    this.paused = true;
    await this.cancel(reason);
  }
  resume(): void {
    if (!this.disposed) {
      this.paused = false;
      const off =
        !this.provider.warming || this.provider.warming.mode === "off";
      this.status = {
        ...this.status,
        state: off ? "off" : "idle",
        skipReason: off ? "disabled" : undefined,
      };
    }
  }
  async setForegroundActive(active: boolean): Promise<void> {
    this.foregroundActive = active;
    if (active) {
      await this.cancel("foreground_active");
    }
  }
  async beginRequest(): Promise<void> {
    this.foregroundRequests++;
    await this.cancel("foreground_active");
  }
  endRequest(): void {
    this.foregroundRequests = Math.max(0, this.foregroundRequests - 1);
  }
  async invalidate(reason: string): Promise<void> {
    await this.cancel(reason);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel("disposed");
  }
}
