import { z } from "zod";
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  // Cache token counts from the API usage block. Anthropic reports both fields
  // directly; OpenAI/compat has no cache-creation concept (always 0) and
  // reports cache reads via input_tokens_details.cached_tokens (Responses API)
  // or prompt_tokens_details.cached_tokens (Chat Completions). inputTokens
  // excludes the cached prefix on every protocol, so the four fields sum to
  // the real-token baseline (input + cache_read + cache_creation + output)
  // that anchors the compact judgement.
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Optional write buckets keyed by explicit TTL seconds. */
  cacheCreationByTTL?: Record<string, number>;
  /** Diagnostic subset of outputTokens, never a fifth billable category. */
  reasoningTokens?: number;
}

export function normalizeAnthropicUsage(
  raw: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    } | null;
  },
  full = false,
): Partial<UsageInfo> {
  return {
    ...(typeof raw.input_tokens === "number"
      ? { inputTokens: raw.input_tokens }
      : {}),
    ...(typeof raw.output_tokens === "number"
      ? { outputTokens: raw.output_tokens }
      : {}),
    ...(typeof raw.cache_read_input_tokens === "number" || full
      ? { cacheReadInputTokens: raw.cache_read_input_tokens ?? 0 }
      : {}),
    ...(typeof raw.cache_creation_input_tokens === "number" || full
      ? { cacheCreationInputTokens: raw.cache_creation_input_tokens ?? 0 }
      : {}),
    ...(raw.cache_creation
      ? {
          cacheCreationByTTL: {
            ...(typeof raw.cache_creation.ephemeral_5m_input_tokens ===
              "number" || full
              ? { "300": raw.cache_creation.ephemeral_5m_input_tokens ?? 0 }
              : {}),
            ...(typeof raw.cache_creation.ephemeral_1h_input_tokens ===
              "number" || full
              ? { "3600": raw.cache_creation.ephemeral_1h_input_tokens ?? 0 }
              : {}),
          },
        }
      : {}),
  };
}

export function normalizeOpenAIUsage(raw: {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}): Partial<UsageInfo> {
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  const cached =
    raw.input_tokens_details?.cached_tokens ??
    raw.prompt_tokens_details?.cached_tokens ??
    0;
  const reasoning =
    raw.output_tokens_details?.reasoning_tokens ??
    raw.completion_tokens_details?.reasoning_tokens;
  return {
    ...(input !== undefined
      ? { inputTokens: Math.max(0, input - cached) }
      : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

const ToolArgumentsSchema = z.record(z.string(), z.unknown());

export function parseToolArguments(raw: string): {
  arguments: Record<string, unknown>;
  parseError?: string;
} {
  if (!raw.trim()) {
    return { arguments: {} };
  }

  try {
    const parsed = ToolArgumentsSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? { arguments: parsed.data }
      : {
          arguments: {},
          parseError: "Invalid tool arguments: expected a JSON object",
        };
  } catch (error) {
    return {
      arguments: {},
      parseError: `Invalid tool arguments JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    };
  }
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "redacted_thinking_complete"; data: string }
  | { type: "tool_call_start"; toolName: string; toolId: string }
  | { type: "tool_call_delta"; text: string }
  | {
      type: "tool_call_complete";
      toolId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      parseError?: string;
      providerItemId?: string;
    }
  | {
      type: "usage_snapshot";
      usage: Partial<UsageInfo>;
      providerAmount?: { currency: string | null; amount: number | null };
    }
  | {
      type: "stream_end";
      stopReason: string;
      usage: UsageInfo;
      usageComplete?: boolean;
      providerAmount?: { currency: string | null; amount: number | null };
    };
