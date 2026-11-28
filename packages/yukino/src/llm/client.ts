import type {
  ProviderConfig,
  SamplingParams,
  ThinkingLevel,
} from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import { bindExecutionContext, getExecutionContext } from "@/cost/context.js";
import type { ExecutionLedger } from "@/cost/ledger.js";
import { observeRequests, type RequestAttempt } from "@/cost/requests.js";
import type { StreamEvent } from "@/llm/events.js";
import { registerLlmClient } from "@/telemetry/instrumentation.js";
import type { ProviderToolSchema, ToolProtocol } from "@/tools/types.js";

export interface LLMStreamOptions {
  systemPrompt?: string;
  samplingParams?: SamplingParams;
  maxOutputTokens?: number;
  /** Answer space to preserve when the provider uses a fixed thinking budget. */
  answerReserveTokens?: number;
  maxRetries?: number;
  cacheMode?: "off" | "short" | "long";
  cacheIdentity?: string;
  cacheScope?: { project: string; branch: string };
  cacheTTLSeconds?: number;
  warming?: boolean;
  /** Injected clients report cumulative partial usage at their request boundary. */
  attemptObserver?: RequestAttempt;
}

export interface LLMOutputBudget {
  maxOutputTokens: number;
  /** Planning allowance for the provider-native reasoning effort. */
  thinkingTokens: number;
}

export interface LLMClient
  extends Partial<MaxTokensSetter>, Partial<ThinkingLevelControl> {
  readonly protocol?: ToolProtocol;
  readonly observesRequests?: boolean;
  readonly supportsCacheWarming?: boolean;

  getOutputBudget?(): LLMOutputBudget;

  stream(
    conversationManager: ConversationManager,
    toolSchemas: ProviderToolSchema[],
    abortSignal?: AbortSignal,
    options?: LLMStreamOptions,
  ): AsyncGenerator<StreamEvent>;

  setSystemPrompt(prompt: string): void;
}

export interface MaxTokensSetter {
  setMaxOutputTokens(maxTokens: number): void;
}

/** Runtime control of the effective logical thinking level. */
export interface ThinkingLevelControl {
  /** Applies the level and returns the effective one, which may be clamped by the provider. */
  setThinkingLevel(level: ThinkingLevel): ThinkingLevel;
  getThinkingLevel(): ThinkingLevel;
  getSupportedThinkingLevels?(): readonly ThinkingLevel[];
}

export function measureClient(
  client: LLMClient,
  provider: ProviderConfig,
  ledger?: ExecutionLedger,
): LLMClient {
  return {
    protocol: client.protocol,
    observesRequests: true,
    supportsCacheWarming: client.supportsCacheWarming,
    setSystemPrompt: (prompt) => {
      client.setSystemPrompt(prompt);
    },
    ...(client.setMaxOutputTokens
      ? { setMaxOutputTokens: client.setMaxOutputTokens.bind(client) }
      : {}),
    ...(client.getOutputBudget
      ? { getOutputBudget: client.getOutputBudget.bind(client) }
      : {}),
    ...(client.setThinkingLevel
      ? { setThinkingLevel: client.setThinkingLevel.bind(client) }
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
    stream: (conversation, tools, signal, options) => {
      const context = getExecutionContext();
      async function* stream(): AsyncGenerator<StreamEvent> {
        if (client.observesRequests) {
          yield* client.stream(conversation, tools, signal, options);
        } else {
          yield* observeRequests(
            provider,
            (attempt) => {
              attempt.start();
              return client.stream(conversation, tools, signal, {
                ...options,
                maxRetries: 0,
                attemptObserver: attempt,
              });
            },
            signal,
            options,
            ledger,
          );
        }
      }
      return bindExecutionContext(
        stream(),
        context ??
          (ledger
            ? {
                sessionId: ledger.sessionId,
                runId: "unattributed",
                agentId: "unattributed",
                purpose: "main",
                ledger,
              }
            : undefined),
      );
    },
  };
}

// Dynamic imports keep provider SDKs lazy: only the module for the configured
// protocol is loaded at runtime.
export async function createClient(
  config: ProviderConfig,
  systemPrompt: string,
) {
  switch (config.protocol) {
    case "anthropic": {
      const { AnthropicClient } = await import("./anthropic.js");
      return registerLlmClient(new AnthropicClient(config, systemPrompt), {
        model: config.model,
        protocol: config.protocol,
      });
    }

    case "openai": {
      const { OpenAIClient } = await import("./openai.js");
      return registerLlmClient(new OpenAIClient(config, systemPrompt), {
        model: config.model,
        protocol: config.protocol,
      });
    }

    case "openai-compat": {
      const { OpenAICompatClient } = await import("./openai.js");
      return registerLlmClient(new OpenAICompatClient(config, systemPrompt), {
        model: config.model,
        protocol: config.protocol,
      });
    }

    default:
      throw new Error(`Unknown protocol: ${String(config.protocol)}`);
  }
}
