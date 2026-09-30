import type { StreamEvent } from "./events.js";

import type {
  ProviderConfig,
  ThinkingLevel,
} from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import { registerLlmClient } from "@/telemetry/instrumentation.js";
import type { ProviderToolSchema, ToolProtocol } from "@/tools/types.js";

export interface LLMClient
  extends Partial<MaxTokensSetter>, Partial<ThinkingLevelControl> {
  readonly protocol?: ToolProtocol;

  stream(
    conversationManager: ConversationManager,
    toolSchemas: ProviderToolSchema[],
    abortSignal?: AbortSignal,
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
