import {
  snapshotWarmingRequest,
  type WarmingRequest,
} from "@/cache/warming.js";
import {
  getContextWindow,
  type ProviderConfig,
  type ThinkingLevel,
} from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import {
  bindExecutionContext,
  getExecutionContext,
  type ExecutionContext,
} from "@/cost/context.js";
import { snapshotPrice, type PriceSnapshot } from "@/cost/pricing.js";
import { UsageSnapshotSchema, type Money } from "@/cost/types.js";
import type { LLMClient, LLMStreamOptions } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { assertBoundedJson } from "@/session/records.js";
import { registerLlmClient } from "@/telemetry/instrumentation.js";
import type { ProviderToolSchema } from "@/tools/types.js";

export interface MainRequestSnapshot extends WarmingRequest {
  context: ExecutionContext;
  startedAt: number;
  completedAt?: number;
  usage?: UsageInfo;
  usageComplete: boolean;
  providerAmount?: Money;
  price: PriceSnapshot | null;
  thinking?: ThinkingLevel;
}

export interface RequestObservation {
  runId: string;
  sessionId: string;
  model: string;
  contextWindow: number;
  startedAt: number;
  observedAt: number;
  usage: Partial<UsageInfo> | null;
  usageComplete: boolean;
}

interface RequestHandlers {
  start(): Promise<void>;
  finish(request?: MainRequestSnapshot): void;
  invalidate(reason: string): Promise<void>;
}

const trackedClients = new WeakSet<LLMClient>();

export function isTrackedRequestClient(client: LLMClient): boolean {
  return trackedClients.has(client);
}

export class SessionRequestTracker {
  readonly client: LLMClient;
  private latest?: MainRequestSnapshot;
  private observation?: RequestObservation;
  private observationSource?: {
    context: ExecutionContext;
    previousAttempts: Set<string>;
  };
  private handlers?: RequestHandlers;
  private generation = 0;
  private sequence = 0;
  private activeRequests = 0;
  private systemPrompt: string;

  constructor(
    private readonly options: {
      client: LLMClient;
      provider: ProviderConfig;
      conversation: ConversationManager;
      sessionId: string;
      systemPrompt: string;
      now?: () => number;
    },
  ) {
    const client = options.client;
    const setMaxOutputTokens = client.setMaxOutputTokens?.bind(client);
    const setThinkingLevel = client.setThinkingLevel?.bind(client);
    this.systemPrompt = options.systemPrompt;
    this.client = registerLlmClient(
      {
        get protocol() {
          return options.provider.protocol;
        },
        get observesRequests() {
          return client.observesRequests;
        },
        get supportsCacheWarming() {
          return client.supportsCacheWarming;
        },
        setSystemPrompt: (prompt) => {
          this.invalidateControl("system_change");
          this.systemPrompt = prompt;
          client.setSystemPrompt(prompt);
        },
        ...(setMaxOutputTokens
          ? {
              setMaxOutputTokens: (tokens: number) => {
                this.invalidateControl("output_change");
                setMaxOutputTokens(tokens);
              },
            }
          : {}),
        ...(client.getOutputBudget
          ? { getOutputBudget: client.getOutputBudget.bind(client) }
          : {}),
        ...(setThinkingLevel
          ? {
              setThinkingLevel: (level: ThinkingLevel) => {
                if (client.getThinkingLevel?.() !== level) {
                  this.invalidateControl("thinking_change");
                }
                return setThinkingLevel(level);
              },
            }
          : {}),
        ...(client.getThinkingLevel
          ? { getThinkingLevel: client.getThinkingLevel.bind(client) }
          : {}),
        ...(client.getSupportedThinkingLevels
          ? {
              getSupportedThinkingLevels:
                client.getSupportedThinkingLevels.bind(client),
            }
          : {}),
        stream: (conversation, tools, signal, streamOptions) => {
          const context = getExecutionContext();
          return bindExecutionContext(
            this.track(conversation, tools, signal, streamOptions, context),
            context,
          );
        },
      },
      {
        model: options.provider.model,
        protocol: client.protocol ?? options.provider.protocol,
      },
    );
    trackedClients.add(this.client);
  }

  private async *track(
    conversation: ConversationManager,
    tools: ProviderToolSchema[],
    signal: AbortSignal | undefined,
    streamOptions: LLMStreamOptions | undefined,
    context: ExecutionContext | undefined,
  ): AsyncGenerator<StreamEvent> {
    const { client, provider, now = Date.now } = this.options;
    const main =
      context?.purpose === "main" &&
      context.agentId === "main" &&
      context.sessionId === this.options.sessionId &&
      conversation === this.options.conversation &&
      (!streamOptions ||
        Object.getOwnPropertyDescriptor(streamOptions, "warming")?.value !==
          true);
    if (!main || !context) {
      if (context?.purpose === "compaction") {
        this.clear();
        await this.handlers?.invalidate("compaction");
      }
      yield* client.stream(conversation, tools, signal, streamOptions);
      return;
    }
    const sequence = ++this.sequence;
    this.activeRequests++;
    this.latest = undefined;
    let request: MainRequestSnapshot | undefined;
    let completed = false;
    const generation = this.generation;
    try {
      await this.handlers?.start();
      signal?.throwIfAborted();
      const observation: RequestObservation = {
        runId: context.runId,
        sessionId: context.sessionId,
        model: provider.model,
        contextWindow: getContextWindow(provider),
        startedAt: now(),
        observedAt: now(),
        usage: null,
        usageComplete: false,
      };
      this.observation = observation;
      this.observationSource = {
        context,
        previousAttempts: new Set(
          context.ledger
            .getEntries({
              sessionId: context.sessionId,
              runId: context.runId,
              purpose: "main",
              agentId: "main",
            })
            .map((entry) => entry.attemptId),
        ),
      };
      try {
        const replay = snapshotWarmingRequest(
          conversation,
          tools,
          streamOptions,
          this.systemPrompt,
        );
        const startedAt = now();
        request = {
          ...replay,
          context,
          startedAt,
          price: snapshotPrice(provider, startedAt),
          thinking: client.getThinkingLevel?.(),
          usageComplete: false,
        };
      } catch {
        // Unsafe or oversized data disables replay, not the foreground request.
      }
      for await (const event of client.stream(
        conversation,
        tools,
        signal,
        streamOptions,
      )) {
        if (event.type === "usage_snapshot" || event.type === "stream_end") {
          try {
            assertBoundedJson(event.usage);
            observation.usage = {
              ...observation.usage,
              ...UsageSnapshotSchema.parse(event.usage),
            };
            observation.observedAt = now();
            observation.usageComplete =
              event.type === "stream_end" &&
              (event.usageComplete ?? true) &&
              [
                observation.usage.inputTokens,
                observation.usage.outputTokens,
                observation.usage.cacheReadInputTokens,
                observation.usage.cacheCreationInputTokens,
              ].every(
                (tokens) => Number.isSafeInteger(tokens) && (tokens ?? -1) >= 0,
              );
          } catch {
            observation.usageComplete = false;
          }
        }
        if (event.type === "stream_end" && request) {
          try {
            assertBoundedJson({
              usage: event.usage,
              providerAmount: event.providerAmount,
            });
            request.usage = structuredClone(event.usage);
            request.providerAmount = structuredClone(event.providerAmount);
            request.usageComplete = event.usageComplete ?? true;
            request.completedAt = now();
          } catch {
            request = undefined;
          }
        }
        yield event;
      }
      completed = request?.completedAt !== undefined;
    } finally {
      this.activeRequests--;
      const valid =
        completed &&
        !signal?.aborted &&
        sequence === this.sequence &&
        generation === this.generation;
      if (valid) {
        this.latest = request;
      }
      this.handlers?.finish(valid ? request : undefined);
    }
  }

  private invalidateControl(reason: string): void {
    this.clear();
    void this.handlers?.invalidate(reason).catch(() => undefined);
  }
  getObservation(): RequestObservation | undefined {
    const observation = this.observation;
    const source = this.observationSource;
    if (observation && source && !observation.usageComplete) {
      const { context, previousAttempts } = source;
      const entry = context.ledger
        .getEntries({
          sessionId: context.sessionId,
          runId: context.runId,
          purpose: "main",
          agentId: "main",
        })
        .filter((attempt) => !previousAttempts.has(attempt.attemptId))
        .at(-1);
      if (entry?.usage) {
        observation.usage = entry.usage;
        observation.usageComplete = entry.usageComplete;
        observation.observedAt = entry.endedAt ?? observation.observedAt;
      }
    }
    return observation ? structuredClone(observation) : undefined;
  }
  getLatest(): MainRequestSnapshot | undefined {
    return this.latest;
  }
  get active(): number {
    return this.activeRequests;
  }
  setHandlers(handlers: RequestHandlers): void {
    this.handlers = handlers;
  }
  clear(): void {
    this.generation++;
    this.latest = undefined;
  }
  dispose(): void {
    this.clear();
    this.handlers = undefined;
  }
}
