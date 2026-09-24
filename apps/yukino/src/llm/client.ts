/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { StreamEvent } from "./events.js";

import type { ProviderConfig, ThinkingLevel } from "@/config/index.js";
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

// Use dynamic import for lazy loading
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
