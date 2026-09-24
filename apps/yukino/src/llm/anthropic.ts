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

import {
  clampThinkingLevel,
  getMaxOutputTokens,
  getSupportedThinkingLevels,
  getThinkingLevel,
  MIN_THINKING_ANSWER_TOKENS,
  type ProviderConfig,
  resolveAPIKey,
  type ThinkingLevel,
  thinkingBudgetForLevel,
  toAnthropicThinkingEffort,
  toReasoningEffort,
} from "@/config/index.js";
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
// text block; block arrays (text/image) already use the provider shape.
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
      } // end if (m.thinkingBlocks)

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
            type: "tool_use", // tool use **request**
            id: tu.toolUseId,
            name: tu.toolName === "ComputerUse" ? "computer" : tu.toolName,
            input: tu.arguments,
          });
        }
      } // end if (m.toolUses)

      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
      }
      result.push({ role: "assistant", content: blocks });
    } //! end if (m.role === "assistant")
    else if (m.toolResults && m.toolResults.length > 0) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const tr of m.toolResults) {
        blocks.push({
          type: "tool_result", // tool result
          tool_use_id: tr.toolUseId,
          is_error: tr.isError,
          content: tr.contentBlocks?.length ? tr.contentBlocks : tr.content,
        });
      }
      if (m.content.length > 0) {
        blocks.push(...userBlocksFor(m.content));
      }

      result.push({ role: "user", content: blocks });
    } //! end if (m.toolResults && m.toolResults.length > 0)
    // The first message's role MUST be user
    else {
      // Summary (role: "user")
      // Kept user messages (with no intervening assistant turn)
      //
      // Merge consecutive user text messages to maintain alternation.
      // After compaction the summary (user) may be followed by kept user messages with no intervening assistant turn. The Anthropic API requires strict user/assistant alternation,
      // so we merge them into a single user entry with multiple text blocks.
      // Only merge when the previous entry is a plain-text user (not a tool_result user).

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
            // content[0].type !== "tool_result"
            (content[0].type === "text" || content[0].type === "image")))
      ) {
        canMerge = true;
      }

      if (canMerge) {
        // Convert
        if (typeof content === "string") {
          // First assign to prev.content, then assign to content
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
  /** Effective logical level for budget or explicitly configured adaptive mode. */
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

    // Mark last user message tail for cache control
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
            type: "ephemeral", // Prompt cache
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
            } // end if (block.type === "thinking")
            else if (block.type === "tool_use") {
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
          } // end case "content_block_start"

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "thinking_delta") {
              thinkingAccumulate += delta.thinking;
              yield {
                type: "thinking_delta",
                text: delta.thinking,
              };
            }
            // end if (delta.type === "thinking_delta")
            else if (delta.type === "signature_delta") {
              thinkingSignature += delta.signature;
            }
            // end if (delta.type === "signature_delta")
            else if (delta.type === "text_delta") {
              yield {
                type: "text_delta",
                text: delta.text,
              };
            }
            // end if (delta.type === "text_delta")
            else if (delta.type === "input_json_delta") {
              jsonAccumulate += delta.partial_json;
              yield {
                type: "tool_call_delta",
                text: delta.partial_json,
              };
            } // end if (delta.type === "input_json_delta")
            break;
          } // end case "content_block_delta"

          case "content_block_stop": {
            if (inThinking) {
              yield {
                type: "thinking_complete",
                thinking: thinkingAccumulate,
                signature: thinkingSignature,
              };
              inThinking = false;
            } // end if (inThinking)

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
              } // end if (jsonAccumulate)

              yield {
                type: "tool_call_complete",
                toolId: currentToolId,
                toolName: currentToolName,
                arguments: args,
              };

              // Reset
              currentToolName = "";
              currentToolId = "";
              jsonAccumulate = "";
            } // end if (currentToolName)
            break;
          } // end case "content_block_stop"

          case "message_delta": {
            if (event.delta.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage.output_tokens) {
              outputTokens = event.usage.output_tokens;

              if (event.usage.input_tokens) {
                inputTokens = event.usage.input_tokens;
              }
              if (event.usage.cache_read_input_tokens) {
                cacheReadInputTokens = event.usage.cache_read_input_tokens;
              }
              if (event.usage.cache_creation_input_tokens) {
                cacheCreationInputTokens =
                  event.usage.cache_creation_input_tokens;
              }
            }
            break;
          } // end case "message_delta"

          case "message_start": {
            inputTokens = event.message.usage.input_tokens;
            outputTokens = event.message.usage.output_tokens;
            cacheReadInputTokens =
              event.message.usage.cache_read_input_tokens ?? 0;
            cacheCreationInputTokens =
              event.message.usage.cache_creation_input_tokens ?? 0;
            break;
          } // end "message_start"
        }
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
 * @param messages
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

    // Sets the property of target, equivalent to target[propertyKey] = value when receiver === target.
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
    } // end if (err.status === 401)

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
    } // end if (err.status === 429)

    return new LLMError(
      `Anthropic API error (${asString(err.status)}): ${err.message}`,
    );
  } // end if (err instanceof Anthropic.APIError)

  return new NetworkError(`Network error: ${asErrorString(err)}`);
}
