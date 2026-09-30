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
}

export function parseToolArguments(raw: string): {
  arguments: Record<string, unknown>;
  parseError?: string;
} {
  if (!raw.trim()) {
    return { arguments: {} };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        arguments: {},
        parseError: "Invalid tool arguments: expected a JSON object",
      };
    }
    return { arguments: Object.fromEntries(Object.entries(parsed)) };
  } catch (error) {
    return {
      arguments: {},
      parseError: `Invalid tool arguments JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    };
  }
}

/** Events emitted by an LLM stream: text/thinking deltas, tool-call lifecycle, and stream end. */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
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
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };
