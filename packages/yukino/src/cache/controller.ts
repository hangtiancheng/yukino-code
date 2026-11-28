import type { AgentEvent } from "@/agent/events.js";
import { CACHE_STATUS_REASONS } from "@/cache/constants.js";
import { resolveCachePolicy, type CachePolicy } from "@/cache/policy.js";
import {
  SessionRequestTracker,
  type MainRequestSnapshot,
} from "@/cache/requests.js";
import { CacheWarmingScheduler, type WarmingStatus } from "@/cache/warming.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import type { ExecutionContext } from "@/cost/context.js";
import type { LLMClient } from "@/llm/client.js";
import type { SessionStorageTarget } from "@/session/lease.js";
import { assertBoundedJson } from "@/session/records.js";
import type { ToolRegistry } from "@/tools/registry.js";

export interface RuntimeCacheStatus {
  policy: CachePolicy;
  warmingMode: "off" | "streaming" | "idle";
  warming: Omit<WarmingStatus, "identity">;
}

export class RuntimeCacheController {
  readonly requests: SessionRequestTracker;
  readonly warming: CacheWarmingScheduler;
  readonly client: LLMClient;
  private foreground = false;
  private runContext?: ExecutionContext;
  private runInvalidated = false;
  private disposal?: Promise<void>;
  private unsubscribe: () => void;
  private hostGuard?: () => string | undefined;

  constructor(
    private readonly options: {
      provider: ProviderConfig;
      client: LLMClient;
      conversation: ConversationManager;
      context: ExecutionContext;
      systemPrompt: string;
      cwd: string;
      storageTarget?: SessionStorageTarget | null;
      registry: ToolRegistry;
      toolFilter: () => (name: string) => boolean;
      goalStatus: () => string | undefined;
      cacheGuard?: () => string | undefined;
      branch: (requestBranch: string) => boolean;
    },
  ) {
    this.hostGuard = options.cacheGuard;
    this.requests = new SessionRequestTracker({
      client: options.client,
      provider: options.provider,
      conversation: options.conversation,
      sessionId: options.context.sessionId,
      systemPrompt: options.systemPrompt,
    });
    this.client = this.requests.client;
    this.warming = new CacheWarmingScheduler({
      provider: options.provider,
      client: this.client,
      context: options.context,
      storageTarget: options.storageTarget,
      guard: () => this.guard(),
    });
    this.requests.setHandlers({
      start: () => this.warming.beginRequest(),
      finish: (request) => {
        this.warming.endRequest();
        if (this.foreground && !this.runInvalidated && request) {
          this.schedule(request, "streaming");
        }
      },
      invalidate: (reason) => this.invalidate(reason),
    });
    this.unsubscribe = options.registry.subscribe(() => {
      void this.invalidate("schema_change");
    });
  }

  get isForegroundActive(): boolean {
    return this.foreground;
  }
  setGuard(guard: () => string | undefined): void {
    this.hostGuard = guard;
  }
  getGuard(): (() => string | undefined) | undefined {
    return this.hostGuard;
  }

  private guard(): string | undefined {
    if (this.disposal) {
      return "disposed";
    }
    try {
      const hostReason = this.hostGuard?.();
      if (hostReason) {
        return hostReason;
      }
    } catch {
      return "guard_blocked";
    }
    const goal = this.options.goalStatus();
    if (goal === "paused" || goal === "budget_limited") {
      return goal;
    }
    const request = this.requests.getLatest();
    if (!request) {
      return "no_main_request";
    }
    if (request.thinking !== this.client.getThinkingLevel?.()) {
      return "thinking_change";
    }
    try {
      const branch = request.options.cacheScope?.branch;
      if (branch === undefined || !this.options.branch(branch)) {
        return "branch_change";
      }
    } catch {
      return "branch_change";
    }
    try {
      const tools = this.options.registry.getAllSchemas(
        this.client.protocol ?? this.options.provider.protocol,
        this.options.toolFilter(),
      );
      assertBoundedJson(tools);
      if (JSON.stringify(tools) !== JSON.stringify(request.tools)) {
        return "schema_change";
      }
    } catch {
      return "unsafe_schema";
    }
    return undefined;
  }

  private schedule(
    request: MainRequestSnapshot,
    trigger: "streaming" | "idle",
  ): void {
    if (
      this.disposal ||
      this.runInvalidated ||
      this.requests.active ||
      this.options.provider.warming?.mode !== trigger ||
      request.context.runId !== this.runContext?.runId ||
      request.context.sessionId !== this.runContext.sessionId ||
      request.context.ledger !== this.runContext.ledger ||
      request.context.parentRunId ||
      !request.usageComplete ||
      !request.usage ||
      request.completedAt === undefined
    ) {
      return;
    }
    const usage = request.usage;
    const values = [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadInputTokens,
      usage.cacheCreationInputTokens,
    ];
    if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return;
    }
    const knownCache =
      usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    this.warming.schedule(
      {
        conversation: request.conversation,
        tools: request.tools,
        systemPrompt: request.systemPrompt,
        options: request.options,
        project: request.options.cacheScope?.project ?? this.options.cwd,
        branch: request.options.cacheScope?.branch ?? request.context.sessionId,
        inputTokens: knownCache + usage.inputTokens,
        cachedAt: knownCache > 0 ? request.completedAt : Number.NaN,
        lastActivityAt: request.startedAt,
        price: request.price,
        parentRunId: request.context.runId,
      },
      trigger,
    );
  }

  async beginRun(context: ExecutionContext): Promise<void> {
    this.foreground = true;
    this.runContext = context;
    this.runInvalidated = false;
    this.requests.clear();
    await this.warming.setForegroundActive(true);
  }

  async endRun(successful: boolean): Promise<void> {
    this.foreground = false;
    await this.warming.setForegroundActive(false);
    if (this.runInvalidated) {
      return;
    }
    if (!successful) {
      await this.invalidate("run_not_successful");
      return;
    }
    const request = this.requests.getLatest();
    if (request) {
      this.schedule(request, "idle");
    }
  }

  async handleAgentEvent(event: AgentEvent): Promise<void> {
    const goal = this.options.goalStatus();
    const reason =
      event.type === "compact"
        ? "compaction"
        : event.type === "error"
          ? "request_failed"
          : event.type === "loop_complete" && event.stopReason === "interrupted"
            ? "interrupted"
            : event.type === "loop_complete" &&
                event.stopReason === "budget_limited"
              ? "budget_limited"
              : goal === "paused" || goal === "budget_limited"
                ? goal
                : undefined;
    if (reason) {
      await this.invalidate(reason);
    }
  }

  async invalidate(reason: string): Promise<void> {
    this.requests.clear();
    this.runInvalidated = true;
    await this.warming.invalidate(reason);
  }
  async pause(reason = "user_stopped"): Promise<void> {
    this.requests.clear();
    this.runInvalidated = true;
    await this.warming.pause(reason);
  }
  resume(): void {
    this.warming.resume();
  }
  getStatus(): RuntimeCacheStatus {
    const { identity: _identity, ...warming } = this.warming.getStatus();
    const safeReason = (reason: string | undefined) =>
      reason === undefined || CACHE_STATUS_REASONS.has(reason)
        ? reason
        : "guard_blocked";
    warming.skipReason = safeReason(warming.skipReason);
    if (warming.decision) {
      warming.decision.reason = safeReason(warming.decision.reason);
    }
    return {
      policy: resolveCachePolicy(this.options.provider),
      warmingMode: this.options.provider.warming?.mode ?? "off",
      warming,
    };
  }
  dispose(): Promise<void> {
    this.disposal ??= Promise.resolve().then(async () => {
      this.unsubscribe();
      this.requests.dispose();
      await this.warming.dispose();
    });
    return this.disposal;
  }
}
