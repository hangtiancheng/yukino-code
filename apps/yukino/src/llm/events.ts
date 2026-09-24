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

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  // Cache token counts from the API usage block. Anthropic reports these directly;
  // OpenAI/compat usually report 0 (or only cache_read via prompt_tokens_details.cached_tokens).
  // They anchor the compact judgement's
  // real-token baseline (input + cache_read + cache_creation + output).
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
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
      providerItemId?: string;
    }
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };
