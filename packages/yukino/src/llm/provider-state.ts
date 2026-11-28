import { prepareCacheOptions } from "@/cache/request.js";
import {
  clampThinkingLevel,
  getMaxOutputTokens,
  getSupportedThinkingLevels,
  getThinkingLevel,
  thinkingBudgetForProvider,
  type ProviderConfig,
  type ThinkingLevel,
} from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import { observeRequests, type RequestAttempt } from "@/cost/requests.js";
import type {
  LLMClient,
  LLMOutputBudget,
  LLMStreamOptions,
} from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import type { ProviderToolSchema } from "@/tools/types.js";

export type ProviderStreamOptions = LLMStreamOptions & { systemPrompt: string };

export abstract class ProviderState implements LLMClient {
  readonly observesRequests = true;
  readonly supportsCacheWarming = true;
  protected config: ProviderConfig;
  private thinkingLevel: ThinkingLevel;

  constructor(
    config: ProviderConfig,
    private systemPrompt: string,
  ) {
    this.config = { ...config };
    this.thinkingLevel = getThinkingLevel(config);
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  stream(
    conversation: ConversationManager,
    tools: ProviderToolSchema[],
    signal?: AbortSignal,
    options?: LLMStreamOptions,
  ): AsyncGenerator<StreamEvent> {
    const systemPrompt = options?.systemPrompt ?? this.systemPrompt;
    const prepared = {
      ...prepareCacheOptions(this.config, systemPrompt, tools, options),
      systemPrompt,
    };
    return observeRequests(
      this.config,
      (attempt) =>
        this.streamAttempt(conversation, tools, attempt, signal, prepared),
      signal,
      prepared,
    );
  }

  protected abstract streamAttempt(
    conversation: ConversationManager,
    tools: ProviderToolSchema[],
    attempt: RequestAttempt,
    signal: AbortSignal | undefined,
    options: ProviderStreamOptions,
  ): AsyncGenerator<StreamEvent>;

  protected outputConfig(override?: number): ProviderConfig {
    return override === undefined
      ? this.config
      : { ...this.config, max_output_tokens: override };
  }

  setMaxOutputTokens(maxTokens: number): void {
    this.config = { ...this.config, max_output_tokens: maxTokens };
    this.setThinkingLevel(this.thinkingLevel);
  }

  setThinkingLevel(level: ThinkingLevel): ThinkingLevel {
    this.thinkingLevel = clampThinkingLevel(this.config, level);
    return this.thinkingLevel;
  }

  getThinkingLevel(): ThinkingLevel {
    return this.thinkingLevel;
  }

  getSupportedThinkingLevels(): readonly ThinkingLevel[] {
    return getSupportedThinkingLevels(this.config);
  }

  getOutputBudget(): LLMOutputBudget {
    return {
      maxOutputTokens: getMaxOutputTokens(this.config),
      thinkingTokens: thinkingBudgetForProvider(
        this.config,
        this.thinkingLevel,
      ),
    };
  }
}
