import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

import type { ProviderConfig } from "@/config/provider-config.js";
import {
  DEFAULT_REQUEST_RETRIES,
  MAX_REQUEST_RETRIES,
  MAX_REQUEST_RETRY_DELAY_MS,
  REQUEST_RETRY_DELAY_MS,
} from "@/cost/constants.js";
import { bindExecutionContext, getExecutionContext } from "@/cost/context.js";
import type { AttemptObserver, ExecutionLedger } from "@/cost/ledger.js";
import type { Money, UsageSnapshot } from "@/cost/types.js";
import type { LLMStreamOptions } from "@/llm/client.js";
import { NetworkError, RateLimitError, ServerError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";
import { retryAfterDelay } from "@/llm/retry.js";

export interface RequestAttempt {
  start(): void;
  snapshot(usage: UsageSnapshot, providerAmount?: Money): void;
  complete(usageComplete?: boolean): void;
}

export function observeRequests(
  provider: ProviderConfig,
  factory: (attempt: RequestAttempt) => AsyncGenerator<StreamEvent>,
  signal?: AbortSignal,
  options?: LLMStreamOptions,
  ledger?: ExecutionLedger,
): AsyncGenerator<StreamEvent> {
  const context = getExecutionContext();
  const owner = context?.ledger ?? ledger;
  const requestId = randomUUID();
  const identity = context
    ? {
        sessionId: context.sessionId,
        runId: context.runId,
        parentRunId: context.parentRunId,
        agentId: context.agentId,
        purpose: context.purpose,
      }
    : owner
      ? {
          sessionId: owner.sessionId,
          runId: requestId,
          agentId: "unattributed",
          purpose: "main" as const,
        }
      : undefined;
  const requestedRetries = options?.maxRetries ?? DEFAULT_REQUEST_RETRIES;
  const retries = options?.warming
    ? 0
    : Math.min(
        MAX_REQUEST_RETRIES,
        Math.max(
          0,
          Math.floor(
            Number.isFinite(requestedRetries)
              ? requestedRetries
              : DEFAULT_REQUEST_RETRIES,
          ),
        ),
      );

  async function* run(): AsyncGenerator<StreamEvent> {
    for (let index = 0; index <= retries; index++) {
      signal?.throwIfAborted();
      let observer: AttemptObserver | undefined;
      let started = false;
      let hasUsage = false;
      let delivered = false;
      let completed = false;
      let usageComplete = false;
      let outcome: "completed" | "error" | "aborted" | "incomplete" =
        "incomplete";
      const attempt: RequestAttempt = {
        start: () => {
          if (started) {
            return;
          }
          started = true;
          observer =
            owner && identity
              ? owner.beginAttempt(identity, provider, requestId, index, {
                  ttlSeconds: options?.cacheTTLSeconds,
                  identity: options?.cacheIdentity,
                })
              : undefined;
        },
        snapshot: (usage, amount) => {
          attempt.start();
          hasUsage = true;
          observer?.snapshot(usage, amount);
        },
        complete: (known = true) => {
          completed = true;
          usageComplete = known;
          outcome = "completed";
        },
      };
      let retryError: unknown;
      try {
        for await (const event of factory(attempt)) {
          if (event.type === "usage_snapshot") {
            attempt.snapshot(event.usage, event.providerAmount);
            continue;
          }
          if (event.type === "stream_end" && !completed) {
            attempt.snapshot(event.usage, event.providerAmount);
            attempt.complete(event.usageComplete ?? true);
          }
          delivered = true;
          yield event;
        }
        return;
      } catch (error) {
        outcome = signal?.aborted ? "aborted" : "error";
        if (
          index >= retries ||
          !started ||
          hasUsage ||
          delivered ||
          signal?.aborted ||
          !(
            error instanceof RateLimitError ||
            error instanceof ServerError ||
            error instanceof NetworkError
          )
        ) {
          throw error;
        }
        retryError = error;
      } finally {
        if (signal?.aborted && !completed) {
          outcome = "aborted";
        }
        observer?.finish(outcome, usageComplete);
      }
      const retryAfter =
        retryError instanceof RateLimitError ||
        retryError instanceof ServerError
          ? retryError.retryAfter
          : undefined;
      await setTimeout(
        retryAfterDelay(
          retryAfter,
          REQUEST_RETRY_DELAY_MS * 2 ** index,
          MAX_REQUEST_RETRY_DELAY_MS,
        ),
        undefined,
        { signal },
      );
    }
  }
  return bindExecutionContext(run(), context);
}
