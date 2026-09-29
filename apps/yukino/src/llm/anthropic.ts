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

import Anthropic from "@anthropic-ai/sdk";

import type { LLMClient } from "./client.js";
import {
  AuthenticationError,
  containsContextLengthError,
  ContextTooLongError,
  LLMError,
  NetworkError,
  RateLimitError,
} from "./errors.js";
import type { StreamEvent } from "./events.js";

import { resolveAPIKey } from "@/config/index.js";
import {
  clampThinkingLevel,
  getMaxOutputTokens,
  getSupportedThinkingLevels,
  getThinkingLevel,
  MIN_THINKING_ANSWER_TOKENS,
  type ProviderConfig,
  type ThinkingLevel,
  thinkingBudgetForLevel,
  toAnthropicThinkingEffort,
  toReasoningEffort,
} from "@/config/provider-config.js";
import type { ConversationManager, Message } from "@/conversation/index.js";
import { ensureToolPairing } from "@/conversation/pairing.js";
import { createChildLogger } from "@/logger/index.js";
import {
  isOfficialAnthropicEndpoint,
  NATIVE_TOOL_USE_BETA,
} from "@/mcp/strategy.js";
import { normalizeToolResultContentBlock } from "@/tools/types.js";
import type {
  AnthropicToolSchema,
  ProviderToolSchema,
  ToolSchema,
} from "@/tools/types.js";
import {
  asErrorString,
  asRecord,
  asString,
  contentToText,
  isRecord,
  strArg,
} from "@/utils/index.js";

/**
 * Place the cache breakpoint on the last non-deferred tool.
 *
 * Tool schemas are stable across turns, so marking the tail caches the entire
 * tool block almost for free. However, the breakpoint must not land on a tool
 * with defer_loading: a tool carrying both defer_loading and cache_control
 * causes the API to reject the entire request. MCP tools are registered after
 * built-in tools, so the array tail is often a deferred tool — we must scan
 * backwards. Built-in tools are never deferred, so a valid slot always exists.
 */
export function markToolsForCache(
  tools: {
    defer_loading?: boolean;
    cache_control?: Anthropic.CacheControlEphemeral | null;
  }[],
): void {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (t.defer_loading === true) {
      continue;
    }
    t.cache_control = { type: "ephemeral" };
    return;
  }
}

/**
 * Whether any tool in this batch has defer_loading set.
 *
 * The beta header is only sent when it is actually needed: endpoints that do not
 * recognize it reject the request outright, and the dispatch / eager paths do not
 * use it at all.
 */
export function needsToolSearchBeta(
  toolSchemas: ProviderToolSchema[],
): boolean {
  return toolSchemas.some(
    (schema) => "defer_loading" in schema && schema.defer_loading === true,
  );
}

function toAnthropicToolSchema(
  schema: ProviderToolSchema,
  useExplicitCustomType: boolean,
): AnthropicToolSchema {
  if ("input_schema" in schema) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const tool = schema as ToolSchema;
    const { cache_control: cacheControl, ...rest } = tool;
    if (!useExplicitCustomType) {
      delete rest.type;
    }
    return {
      ...rest,
      ...(useExplicitCustomType ? { type: "custom" as const } : {}),
      ...(tool.defer_loading !== true && cacheControl
        ? { cache_control: cacheControl }
        : {}),
    };
  }
  throw new Error(
    "Anthropic received a tool schema serialized for another protocol.",
  );
}

const log = createChildLogger({ module: "llm" });

enum AnthropicErrorCode {
  /**
   * 413 Request Too Large — the request body itself exceeds size limits.
   * Note: prompt-too-long (token count over the context window) arrives as
   * 400 invalid_request_error, not 413.
   */
  PromptTooLong = 413,
  /** 401 Unauthorized — The request lacks valid authentication credentials. */
  InvalidAPIKey = 401,
  /** 429 Too Many Requests — The client has sent too many requests in a given amount of time, triggering rate limiting. */
  RateLimitError = 429,
  /** 400 Bad Request — invalid_request_error; carries "prompt is too long: N tokens > M maximum" on context overflow. */
  BadRequest = 400,
}

// User message content → Anthropic blocks. String content becomes a single
// text block; block arrays are normalized to the provider shape
// (text/image/document/search_result). tool_reference and unsupported blocks
// are rejected.
function userBlocksFor(
  content: Message["content"],
): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content.map((raw) => {
    const block = normalizeToolResultContentBlock(raw);
    if (!block || block.type === "tool_reference") {
      throw new Error(
        `Unsupported user content block: ${strArg(raw, "type", "unknown")}`,
      );
    }
    return block;
  });
}

export function buildAnthropicMessages(
  messages: Message[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.thinkingBlocks) {
        for (const tb of m.thinkingBlocks) {
          blocks.push({
            type: "thinking",
            thinking: tb.thinking,
            signature: tb.signature,
          });
        }
      }

      // Assistant content is model-produced text; flatten defensively.
      const assistantText =
        typeof m.content === "string" ? m.content : contentToText(m.content);
      if (assistantText) {
        blocks.push({
          type: "text",
          text: assistantText,
        });
      }

      if (m.toolUses) {
        for (const tu of m.toolUses) {
          blocks.push({
            type: "tool_use",
            id: tu.toolUseId,
            name: tu.toolName === "ComputerUse" ? "computer" : tu.toolName,
            input: tu.arguments,
          });
        }
      }

      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
      }
      result.push({ role: "assistant", content: blocks });
    } else if (m.toolResults && m.toolResults.length > 0) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const tr of m.toolResults) {
        blocks.push({
          type: "tool_result",
          tool_use_id: tr.toolUseId,
          is_error: tr.isError,
          content: tr.contentBlocks?.length ? tr.contentBlocks : tr.content,
        });
      }
      if (m.content.length > 0) {
        blocks.push(...userBlocksFor(m.content));
      }

      result.push({ role: "user", content: blocks });
    } else {
      // Collapse consecutive plain user messages into a single entry: after
      // compaction the summary (user) may be followed by kept user messages
      // with no intervening assistant turn, so they become one user entry
      // with multiple text blocks. Only merge when the previous entry is a
      // plain user message (string, or first block text/image), never into a
      // tool_result user entry — a user message right after tool results
      // (e.g. a reminder) still starts a new entry, so the output can
      // contain consecutive user entries.
      if (result.length === 0) {
        result.push({
          role: "user",
          content: userBlocksFor(m.content),
        });
        continue;
      }

      let canMerge = false;
      const prev = result[result.length - 1];
      let content = prev.content;
      if (
        prev.role === "user" &&
        (typeof content === "string" ||
          (Array.isArray(content) &&
            content.length > 0 &&
            (content[0].type === "text" || content[0].type === "image")))
      ) {
        canMerge = true;
      }

      if (canMerge) {
        if (typeof content === "string") {
          content = prev.content =
            content.trim().length > 0
              ? [
                  {
                    type: "text",
                    text: content,
                  },
                ]
              : [];
        }
        content.push(...userBlocksFor(m.content));
      } else {
        result.push({
          role: "user",
          content: userBlocksFor(m.content),
        });
      }
    }
  }

  return result;
}

export class AnthropicClient implements LLMClient {
  readonly protocol = "anthropic" as const;

  private client: Anthropic;
  private model: string;
  /** Effective logical thinking level (clamped to what the provider supports);
   *  translated to a token budget or an adaptive effort per request. */
  private thinkingLevel: ThinkingLevel;
  private systemPrompt: string;
  private maxOutputTokens: number;
  private config: ProviderConfig;
  private useExplicitCustomToolType: boolean;

  constructor(config: ProviderConfig, systemPrompt: string) {
    const apiKey = resolveAPIKey(config);
    if (!apiKey) {
      throw new AuthenticationError(
        "Anthropic API key not found, set ANTHROPIC_API_KEY in ~/.yukino/config.yaml, or via ANTHROPIC_API_KEY env variable.",
      );
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: config.base_url,
    });
    this.useExplicitCustomToolType = isOfficialAnthropicEndpoint(
      config.base_url,
    );
    this.model = config.model;
    this.config = { ...config };
    this.thinkingLevel = getThinkingLevel(config);
    this.systemPrompt = systemPrompt;
    this.maxOutputTokens = getMaxOutputTokens(config);
  }
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
  setMaxOutputTokens(maxTokens: number): void {
    this.config = { ...this.config, max_output_tokens: maxTokens };
    this.maxOutputTokens = getMaxOutputTokens(this.config);
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

  async *stream(
    conversation: ConversationManager,
    toolSchemas: ProviderToolSchema[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // Reconcile tool-call/result pairing before sending the request: interruptions,
    // session restores, and concurrent interleaving can all leave dangling tool_use
    // entries, and a missing pairing causes the API to reject the request outright.
    const messages = buildAnthropicMessages(
      ensureToolPairing(conversation.getMessages()),
    );
    // Tools with defer_loading stay in tools[], but the server hides them from the model; the model must first
    // fetch a tool_reference via ToolSearch before it can call them. This field is only accepted with the beta header.
    const sendToolSearchBeta = needsToolSearchBeta(toolSchemas);
    const antToolSchemas = toolSchemas.map((schema) =>
      toAnthropicToolSchema(schema, this.useExplicitCustomToolType),
    );

    markToolsForCache(antToolSchemas);

    markLastUserTailForCache(messages);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      stream: true,
      system: [
        {
          type: "text",
          text: this.systemPrompt,
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
      messages,
      ...(antToolSchemas.length > 0
        ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          { tools: antToolSchemas as Anthropic.Tool[] }
        : {}),
    };

    const level = this.getThinkingLevel();
    if (this.config.reasoning !== false) {
      if (level === "off") {
        params.thinking = { type: "disabled" };
      } else if (this.config.thinking_mode === "adaptive") {
        const effort = toAnthropicThinkingEffort(level, this.config);
        if (effort !== null) {
          params.thinking = { type: "adaptive" };
          params.output_config = { effort };
        }
      } else {
        // Share the strict output ceiling and reserve answer room. Availability
        // already ensures that at least the minimum thinking budget fits.
        const effort = toReasoningEffort(level, this.config);
        if (effort !== null && effort !== "none") {
          params.thinking = {
            type: "enabled",
            budget_tokens: Math.min(
              thinkingBudgetForLevel(effort),
              this.maxOutputTokens - MIN_THINKING_ANSWER_TOKENS,
            ),
          };
        }
      }
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    let stopReason = "end_turn";

    let thinkingAccumulate = "";
    let thinkingSignature = "";
    let inThinking = false;
    // Terminal-event guard: a stream cut between message_start and
    // message_stop (gateway dropping the SSE) must not be committed as a
    // complete end_turn turn with near-zero usage.
    let sawMessageStop = false;

    try {
      const betas = [...(sendToolSearchBeta ? [NATIVE_TOOL_USE_BETA] : [])];
      const response = this.client.messages.stream(params, {
        ...(abortSignal ? { signal: abortSignal } : {}),
        ...(betas.length > 0
          ? { headers: { "anthropic-beta": betas.join(",") } }
          : {}),
      });

      let currentToolName = "";
      let currentToolId = "";
      let jsonAccumulate = "";

      for await (const event of response) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "thinking") {
              inThinking = true;
              thinkingAccumulate = "";
              thinkingSignature = "";
            } else if (block.type === "tool_use") {
              currentToolId = block.id;
              currentToolName =
                block.name === "computer" ? "ComputerUse" : block.name;
              jsonAccumulate = "";
              yield {
                type: "tool_call_start",
                toolName: currentToolName,
                toolId: currentToolId,
              };
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "thinking_delta") {
              thinkingAccumulate += delta.thinking;
              yield {
                type: "thinking_delta",
                text: delta.thinking,
              };
            } else if (delta.type === "signature_delta") {
              thinkingSignature += delta.signature;
            } else if (delta.type === "text_delta") {
              yield {
                type: "text_delta",
                text: delta.text,
              };
            } else if (delta.type === "input_json_delta") {
              jsonAccumulate += delta.partial_json;
              yield {
                type: "tool_call_delta",
                text: delta.partial_json,
              };
            }
            break;
          }

          case "content_block_stop": {
            if (inThinking) {
              yield {
                type: "thinking_complete",
                thinking: thinkingAccumulate,
                signature: thinkingSignature,
              };
              inThinking = false;
            }

            if (currentToolName) {
              let args: Record<string, unknown> = {};
              if (jsonAccumulate) {
                try {
                  const parsed: unknown = JSON.parse(jsonAccumulate);
                  args = isRecord(parsed) ? asRecord(parsed) : {};
                } catch (err) {
                  log.error({ err }, "llm operation failed");
                  args = {};
                }
              }

              yield {
                type: "tool_call_complete",
                toolId: currentToolId,
                toolName: currentToolName,
                arguments: args,
              };

              currentToolName = "";
              currentToolId = "";
              jsonAccumulate = "";
            }
            break;
          }

          case "message_delta": {
            if (event.delta.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            // Apply each usage field independently: a delta whose
            // output_tokens is 0 but which carries input/cache fields must
            // still update those. SDK types allow null for the optional
            // fields, hence the typeof guards.
            const deltaUsage = event.usage;
            if (typeof deltaUsage.output_tokens === "number") {
              outputTokens = deltaUsage.output_tokens;
            }
            if (typeof deltaUsage.input_tokens === "number") {
              inputTokens = deltaUsage.input_tokens;
            }
            if (typeof deltaUsage.cache_read_input_tokens === "number") {
              cacheReadInputTokens = deltaUsage.cache_read_input_tokens;
            }
            if (typeof deltaUsage.cache_creation_input_tokens === "number") {
              cacheCreationInputTokens = deltaUsage.cache_creation_input_tokens;
            }
            break;
          }

          case "message_stop": {
            sawMessageStop = true;
            break;
          }

          case "message_start": {
            inputTokens = event.message.usage.input_tokens;
            outputTokens = event.message.usage.output_tokens;
            cacheReadInputTokens =
              event.message.usage.cache_read_input_tokens ?? 0;
            cacheCreationInputTokens =
              event.message.usage.cache_creation_input_tokens ?? 0;
            break;
          }
        }
      }

      // Without message_stop the response is truncated, not complete: yield
      // no stream_end — a NetworkError lets the run's recovery paths retry
      // instead of persisting a half response as a finished turn.
      if (!sawMessageStop) {
        throw new NetworkError(
          "Anthropic stream ended without message_stop; response was truncated",
        );
      }

      yield {
        type: "stream_end",
        stopReason,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
        },
      };
    } catch (err) {
      log.error({ err }, "llm operation failed");
      throw classifyAnthropicError(err);
    }
  }
}

/**
 * Marks the last non-image content block of the last user message (the true
 * tail when every block is an image) with an ephemeral cache_control
 * breakpoint so the prompt prefix up to it is cached.
 */
export function markLastUserTailForCache(
  messages: Anthropic.Messages.MessageParam[],
) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") {
      continue;
    }

    let content = messages[i].content;
    if (
      (typeof content === "string" && content.length === 0) ||
      (Array.isArray(content) && content.length === 0)
    ) {
      return;
    }
    if (typeof content === "string") {
      content = messages[i].content = [
        {
          type: "text",
          text: content,
        },
      ];
    }
    // Prefer the last non-image block: some gateways reject cache_control on
    // image blocks. Fall back to the true tail if everything is an image.
    let last: Anthropic.Messages.ContentBlockParam =
      content[content.length - 1];
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j].type !== "image") {
        last = content[j];
        break;
      }
    }

    // Reflect.set avoids a type assertion when adding cache_control.
    Reflect.set(last, "cache_control", {
      type: "ephemeral",
    });
    return;
  }
}

function classifyAnthropicError(err: unknown) {
  if (err instanceof Anthropic.APIError) {
    if (
      err.status === AnthropicErrorCode.PromptTooLong ||
      (err.status === AnthropicErrorCode.BadRequest &&
        containsContextLengthError(err.message))
    ) {
      return new ContextTooLongError(`Prompt too long: ${err.message}`);
    }

    if (err.status === AnthropicErrorCode.InvalidAPIKey) {
      return new AuthenticationError(`Invalid API key: ${err.message}`);
    }

    if (err.status === AnthropicErrorCode.RateLimitError) {
      const headers: unknown = err.headers;
      const retryAfter =
        headers instanceof Headers ? headers.get("retry-after") : undefined;
      let message = "Rate Limited";
      if (retryAfter) {
        const s = Number.parseInt(asString(retryAfter));
        if (Number.isNaN(s)) {
          message += ", please wait.";
        } else {
          message += `, retry after ${asString(s)}s.`;
        }
      } else {
        message += ", please wait.";
      }

      return new RateLimitError(
        message,
        retryAfter ? asString(retryAfter) : undefined,
      );
    }

    return new LLMError(
      `Anthropic API error (${asString(err.status)}): ${err.message}`,
    );
  }

  return new NetworkError(`Network error: ${asErrorString(err)}`);
}
