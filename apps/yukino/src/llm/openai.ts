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

import OpenAI from "openai";

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
  type ProviderConfig,
  resolveAPIKey,
  type ThinkingLevel,
  toReasoningEffort,
} from "@/config/index.js";
import type {
  ConversationManager,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from "@/conversation/index.js";
import { ensureToolPairing } from "@/conversation/pairing.js";
import { createChildLogger } from "@/logger/index.js";
import type { ProviderToolSchema, ToolSchema } from "@/tools/types.js";
import {
  asRecord,
  asString,
  contentToText,
  isRecord,
  strArg,
} from "@/utils/index.js";

const log = createChildLogger({ module: "llm" });

enum OpenAIErrorCode {
  /** 413 Payload Too Large — The request entity is larger than the server is willing or able to process. */
  PromptTooLong = 413,
  /** 401 Unauthorized — The request lacks valid authentication credentials. */
  InvalidAPIKey = 401,
  /** 429 Too Many Requests — The client has sent too many requests in a given amount of time, triggering rate limiting. */
  RateLimitError = 429,
  /** 400 Bad Request — The request was invalid or malformed. */
  BadRequest = 400,
}

type ResponseComputerAction = NonNullable<
  OpenAI.Responses.ResponseComputerToolCall["action"]
>;

function computerActionArguments(
  action: OpenAI.Responses.ComputerAction | ResponseComputerAction,
): Record<string, unknown> {
  switch (action.type) {
    case "scroll":
      return {
        type: "scroll",
        x: action.x,
        y: action.y,
        scrollX: action.scroll_x,
        scrollY: action.scroll_y,
        ...(action.keys?.length ? { keys: action.keys } : {}),
      };
    case "click":
    case "double_click":
    case "drag":
    case "move": {
      const { keys, ...rest } = action;
      return {
        ...rest,
        ...(keys?.length ? { keys } : {}),
      };
    }
    default:
      return { ...action };
  }
}

function computerCallArguments(
  item: OpenAI.Responses.ResponseComputerToolCall,
): Record<string, unknown> {
  const actions = item.actions ?? (item.action ? [item.action] : []);
  return {
    actions: actions.map(computerActionArguments),
    pendingSafetyChecks: item.pending_safety_checks.map((check) => ({
      id: check.id,
      ...(check.code ? { code: check.code } : {}),
      ...(check.message ? { message: check.message } : {}),
    })),
    status: item.status,
  };
}

function toOpenAIResponsesTool(
  schema: ProviderToolSchema,
): OpenAI.Responses.Tool {
  if ("input_schema" in schema) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const tool = schema as ToolSchema;
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      strict: tool.strict ?? false,
    };
  }
  if (
    "type" in schema &&
    schema.type === "function" &&
    "parameters" in schema
  ) {
    return { ...schema };
  }
  throw new Error(
    "OpenAI Responses received a tool schema serialized for another protocol.",
  );
}

function toOpenAICompatTool(
  schema: ProviderToolSchema,
): OpenAI.ChatCompletionFunctionTool {
  if ("input_schema" in schema) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const tool = schema as ToolSchema;
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        strict: tool.strict ?? false,
      },
    };
  }
  if ("function" in schema) {
    return { ...schema };
  }
  throw new Error(
    "OpenAI Chat Completions received a tool schema serialized for another protocol.",
  );
}

export class OpenAIClient implements LLMClient {
  readonly protocol = "openai" as const;

  private client: OpenAI;
  private model: string;
  private systemPrompt: string;
  private maxOutputTokens: number;
  private thinkingLevel: ThinkingLevel;
  private config: ProviderConfig;

  constructor(config: ProviderConfig, systemPrompt: string) {
    const apiKey = resolveAPIKey(config);
    if (!apiKey) {
      throw new AuthenticationError(
        "OpenAI API key not found, set OPENAI_API_KEY in ~/.yukino/config.yaml, or via OPENAI_API_KEY env variable.",
      );
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config.base_url,
    });
    this.model = config.model;
    this.systemPrompt = systemPrompt;
    this.maxOutputTokens = getMaxOutputTokens(config);
    this.config = { ...config };
    this.thinkingLevel = getThinkingLevel(config);
  }
  async *stream(
    conversation: ConversationManager,
    toolSchemas: ProviderToolSchema[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // Reconcile tool-call/result pairing before sending the request, for the same reasons as the Anthropic branch
    const messages = buildOpenAIInput(
      ensureToolPairing(conversation.getMessages()),
    );

    const input: OpenAI.Responses.ResponseCreateParamsStreaming["input"] = [];
    input.push({
      role: "system" as const,
      content: this.systemPrompt,
    });

    for (const message of messages) {
      input.push(message);
    }

    const tools = toolSchemas.map(toOpenAIResponsesTool);

    const effort = toReasoningEffort(this.getThinkingLevel(), this.config);
    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: this.model,
      input,
      stream: true,
      max_output_tokens: this.maxOutputTokens,
      ...(tools.length > 0 ? { tools } : {}),
      // Only explicit reasoning:false omits the field. Off sends none to defeat
      // server-default reasoning; requesting a summary while off is unnecessary.
      ...(effort !== null
        ? {
            reasoning: {
              effort,
              ...(effort !== "none" ? { summary: "auto" } : {}),
            },
          }
        : {}),
    };

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    // There is no cache_creation concept here, so it stays 0.
    const cacheCreationInputTokens = 0;

    try {
      const stream = await this.client.responses.create(params, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      let currentToolName = "";
      let currentToolId = "";
      let jsonAccumulate = "";
      let reasoningId = "";
      let reasoningText = "";
      let sawTerminalResponse = false;

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield {
            type: "text_delta",
            text: event.delta,
          };
        } // end if (event.type === "response.output_text.delta")
        else if (event.type === "response.reasoning_summary_text.delta") {
          reasoningText += event.delta;
          yield { type: "thinking_delta", text: event.delta };
        } else if (event.type === "response.reasoning_summary_text.done") {
          yield {
            type: "thinking_complete",
            thinking: reasoningText,
            signature: reasoningId,
          };
        } else if (event.type === "response.function_call_arguments.delta") {
          jsonAccumulate += event.delta;
          yield {
            type: "tool_call_delta",
            text: event.delta,
          };
        } // end if (event.type === "response.function_call_arguments.delta")
        else if (event.type === "response.output_item.added") {
          if (event.item.type === "function_call") {
            currentToolName = event.item.name;
            currentToolId = event.item.call_id;
            jsonAccumulate = "";

            yield {
              type: "tool_call_start",
              toolName: currentToolName,
              toolId: currentToolId,
            };
          } else if (event.item.type === "computer_call") {
            yield {
              type: "tool_call_start",
              toolName: "ComputerUse",
              toolId: event.item.call_id,
            };
          } else if (event.item.type === "reasoning") {
            reasoningId = event.item.id ?? "";
            reasoningText = "";
          }
        } // end if (event.type === "response.output_item.added")
        else if (event.type === "response.output_item.done") {
          if (event.item.type === "function_call" && currentToolName) {
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

            // Reset
            currentToolName = "";
            currentToolId = "";
            jsonAccumulate = "";
          } else if (event.item.type === "computer_call") {
            yield {
              type: "tool_call_complete",
              toolId: event.item.call_id,
              toolName: "ComputerUse",
              arguments: computerCallArguments(event.item),
              providerItemId: event.item.id,
            };
          }
        } // end if (event.type === "response.output_item.done")
        else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete"
        ) {
          sawTerminalResponse = true;
          const usage = event.response.usage;
          if (usage) {
            outputTokens = usage.output_tokens;

            // Responses API exposes the cached prefix via
            // input_tokens_details.cached_tokens, absent -> 0.
            // There is no cache_creation concept here, so it stays 0.
            cacheReadInputTokens =
              usage.input_tokens_details?.cached_tokens ?? 0;

            // input_tokens already includes the cached prefix;
            // subtract so the usage anchor (input + cache_read) doesn't double-count it.
            inputTokens = Math.max(
              0,
              usage.input_tokens - cacheReadInputTokens,
            );
          } // end if (usage)

          // Parse the actual stop reason from the Responses API.
          // When the response status is "incomplete",
          // check incomplete_details.reason
          // for 'max_output_tokens' so the agent loop's max_tokens recovery can trigger.
          // Otherwise default to "end_turn".
          let stopReason = "end_turn";
          const resp = event.response;
          if (
            event.type === "response.incomplete" ||
            resp.status === "incomplete"
          ) {
            // 'max_output_tokens' | 'content_filter'
            const details = resp.incomplete_details;
            if (details?.reason === "max_output_tokens") {
              stopReason = "max_tokens";
            } else {
              throw new LLMError(
                `Response incomplete: ${details?.reason ?? "unknown reason"}`,
              );
            }
          }

          yield {
            type: "stream_end",
            stopReason,
            usage: {
              inputTokens,
              outputTokens,
              cacheReadInputTokens,
              cacheCreationInputTokens, // 0
            },
          };
        } else if (event.type === "response.failed") {
          const error = event.response.error;
          const message = `${error?.code ?? "unknown"}: ${error?.message ?? "Response failed"}`;
          throw containsContextLengthError(message)
            ? new ContextTooLongError(message)
            : new LLMError(message);
        } else if (event.type === "error") {
          const message = `${event.code ?? "unknown"}: ${event.message}`;
          throw containsContextLengthError(message)
            ? new ContextTooLongError(message)
            : new LLMError(message);
        }
      }
      if (!sawTerminalResponse) {
        throw new NetworkError(
          "OpenAI Responses stream ended before a terminal response event",
        );
      }
    } catch (err) {
      log.error({ err }, "llm operation failed");
      throw classifyOpenAIError(err);
    }
  }
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
  setMaxOutputTokens(maxTokens: number): void {
    this.maxOutputTokens = maxTokens;
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
}

// OpenAI.Responses.ResponseInputContent;

// Official Responses API input item types, narrowed to the variants this
// converter actually emits (the full ResponseInputItem union is much wider).
export type OpenAIMessageParam =
  | OpenAI.Responses.EasyInputMessage
  | OpenAI.Responses.ResponseComputerToolCall
  | OpenAI.Responses.ResponseInputItem.ComputerCallOutput
  | OpenAI.Responses.ResponseFunctionToolCall
  | OpenAI.Responses.ResponseInputItem.FunctionCallOutput
  | OpenAI.Responses.ResponseReasoningItem;

function imageDataUrl(block: unknown): string | null {
  if (!isRecord(block) || block.type !== "image" || !isRecord(block.source)) {
    return null;
  }
  if (block.source.type === "url") {
    return strArg(block.source, "url") || null;
  }
  if (block.source.type !== "base64") {
    return null;
  }
  const mediaType = strArg(block.source, "media_type");
  const data = strArg(block.source, "data");
  return mediaType && data ? `data:${mediaType};base64,${data}` : null;
}

function documentForResponses(
  block: unknown,
): OpenAI.Responses.ResponseInputFile | null {
  if (
    !isRecord(block) ||
    block.type !== "document" ||
    !isRecord(block.source)
  ) {
    return null;
  }
  const title =
    typeof block.title === "string" && block.title
      ? block.title
      : "tool-result";
  if (block.source.type === "url") {
    const fileUrl = strArg(block.source, "url");
    return fileUrl ? { type: "input_file", file_url: fileUrl } : null;
  }
  if (block.source.type === "base64") {
    const data = strArg(block.source, "data");
    return data
      ? { type: "input_file", file_data: data, filename: `${title}.pdf` }
      : null;
  }
  if (block.source.type === "text") {
    const data = strArg(block.source, "data");
    return data
      ? {
          type: "input_file",
          file_data: Buffer.from(data, "utf-8").toString("base64"),
          filename: `${title}.txt`,
        }
      : null;
  }
  return null;
}

function documentForChat(
  block: unknown,
): OpenAI.ChatCompletionContentPart.File | null {
  if (
    !isRecord(block) ||
    block.type !== "document" ||
    !isRecord(block.source)
  ) {
    return null;
  }
  const title =
    typeof block.title === "string" && block.title
      ? block.title
      : "tool-result";
  if (block.source.type === "base64") {
    const data = strArg(block.source, "data");
    return data
      ? { type: "file", file: { file_data: data, filename: `${title}.pdf` } }
      : null;
  }
  if (block.source.type === "text") {
    const data = strArg(block.source, "data");
    return data
      ? {
          type: "file",
          file: {
            file_data: Buffer.from(data, "utf-8").toString("base64"),
            filename: `${title}.txt`,
          },
        }
      : null;
  }
  return null;
}

function toolOutputForResponses(
  tr: ToolResultBlock,
): OpenAI.Responses.ResponseInputItem.FunctionCallOutput["output"] {
  if (!tr.contentBlocks?.length) {
    return tr.content;
  }

  const rich: OpenAI.Responses.ResponseFunctionCallOutputItemList = [];
  if (tr.content) {
    rich.push({ type: "input_text", text: tr.content });
  }
  for (const block of tr.contentBlocks) {
    const imageUrl = imageDataUrl(block);
    if (imageUrl) {
      rich.push({ type: "input_image", image_url: imageUrl, detail: "auto" });
      continue;
    }
    const file = documentForResponses(block);
    if (file) {
      rich.push(file);
    }
  }
  return rich.length > 0 ? rich : tr.content;
}

function computerActionsForResponses(
  args: Record<string, unknown>,
): OpenAI.Responses.ComputerActionList {
  if (!Array.isArray(args.actions)) {
    return [];
  }
  const actions: OpenAI.Responses.ComputerActionList = [];
  for (const raw of args.actions) {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      continue;
    }
    if (raw.type === "scroll") {
      actions.push({
        type: "scroll",
        x: Number(raw.x),
        y: Number(raw.y),
        scroll_x: Number(raw.scrollX),
        scroll_y: Number(raw.scrollY),
        ...(Array.isArray(raw.keys) ? { keys: raw.keys.map(String) } : {}),
      });
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    actions.push(raw as unknown as OpenAI.Responses.ComputerAction);
  }
  return actions;
}

function safetyChecksForResponses(
  args: Record<string, unknown>,
): OpenAI.Responses.ResponseInputItem.ComputerCallOutput.AcknowledgedSafetyCheck[] {
  if (!Array.isArray(args.pendingSafetyChecks)) {
    return [];
  }
  return args.pendingSafetyChecks.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.id !== "string") {
      return [];
    }
    return [
      {
        id: raw.id,
        ...(typeof raw.code === "string" ? { code: raw.code } : {}),
        ...(typeof raw.message === "string" ? { message: raw.message } : {}),
      },
    ];
  });
}

function computerScreenshotUrl(tr: ToolResultBlock): string | undefined {
  for (const block of tr.contentBlocks ?? []) {
    const url = imageDataUrl(block);
    if (url) {
      return url;
    }
  }
  return undefined;
}

function collectRichParts(
  tr: ToolResultBlock,
): OpenAI.ChatCompletionContentPart[] {
  if (!tr.contentBlocks?.length) {
    return [];
  }

  const rich: OpenAI.ChatCompletionContentPart[] = [];
  for (const block of tr.contentBlocks) {
    const imageUrl = imageDataUrl(block);
    if (imageUrl) {
      rich.push({ type: "image_url", image_url: { url: imageUrl } });
      continue;
    }
    const file = documentForChat(block);
    if (file) {
      rich.push(file);
    }
  }
  if (rich.length === 0) {
    return [];
  }
  return [
    {
      type: "text",
      text: `[Rich content returned by tool call ${tr.toolUseId}]`,
    },
    ...rich,
  ];
}

// User message content → Responses API parts. Text blocks become input_text,
// image blocks become input_image data URLs; other block types are dropped.
function userContentsFor(
  content: Message["content"],
): string | OpenAI.Responses.ResponseInputContent[] {
  if (typeof content === "string") {
    return content;
  }
  const parts: OpenAI.Responses.ResponseInputContent[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "input_text", text: strArg(block, "text") });
    } else {
      const url = imageDataUrl(block);
      if (url) {
        parts.push({ type: "input_image", image_url: url, detail: "auto" });
      }
    }
  }
  return parts;
}

// User message content → Chat Completions parts (text / image_url).
function userPartsFor(
  content: Message["content"],
): string | OpenAI.ChatCompletionContentPart[] {
  if (typeof content === "string") {
    return content;
  }
  const parts: OpenAI.ChatCompletionContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: strArg(block, "text") });
    } else {
      const url = imageDataUrl(block);
      if (url) {
        parts.push({ type: "image_url", image_url: { url } });
      }
    }
  }
  return parts;
}

// Convert Yukino's conversation into Responses API input items:
// assistant tool calls become function_call items and
// tool results become function_call_output items,
// so multi-turn tool use works over the Responses endpoint.
export function buildOpenAIInput(messages: Message[]): OpenAIMessageParam[] {
  const result: OpenAIMessageParam[] = [];
  const computerCalls = new Map<string, ToolUseBlock>();
  for (const message of messages) {
    for (const toolUse of message.toolUses ?? []) {
      if (toolUse.toolName === "ComputerUse") {
        computerCalls.set(toolUse.toolUseId, toolUse);
      }
    }
  }

  for (const m of messages) {
    if (m.thinkingBlocks) {
      for (const tb of m.thinkingBlocks) {
        result.push({
          type: "reasoning",
          id: tb.signature,
          summary: [{ type: "summary_text", text: tb.thinking }],
        } satisfies OpenAIMessageParam);
      }
    }

    if (m.toolUses && m.toolUses.length > 0) {
      const assistantText =
        typeof m.content === "string" ? m.content : contentToText(m.content);
      if (assistantText) {
        result.push({
          role: "assistant",
          content: assistantText,
        });
      }

      for (const tu of m.toolUses) {
        if (tu.toolName === "ComputerUse") {
          const status = tu.arguments.status;
          result.push({
            type: "computer_call",
            id: tu.providerItemId ?? tu.toolUseId,
            call_id: tu.toolUseId,
            status:
              status === "in_progress" || status === "incomplete"
                ? status
                : "completed",
            actions: computerActionsForResponses(tu.arguments),
            pending_safety_checks: safetyChecksForResponses(tu.arguments),
          });
        } else {
          result.push({
            type: "function_call",
            name: tu.toolName,
            call_id: tu.toolUseId,
            arguments: JSON.stringify(tu.arguments),
          });
        }
      }
    } // end if (m.toolUses && m.toolUses.length > 0)
    else if (m.toolResults && m.toolResults.length > 0) {
      for (const tr of m.toolResults) {
        const computerCall = computerCalls.get(tr.toolUseId);
        if (computerCall) {
          const imageUrl = computerScreenshotUrl(tr);
          result.push({
            type: "computer_call_output",
            call_id: tr.toolUseId,
            output: {
              type: "computer_screenshot",
              ...(imageUrl ? { image_url: imageUrl } : {}),
            },
            acknowledged_safety_checks: safetyChecksForResponses(
              computerCall.arguments,
            ),
          });
          if (tr.isError || !imageUrl) {
            result.push({ role: "user", content: tr.content });
          }
        } else {
          result.push({
            type: "function_call_output",
            call_id: tr.toolUseId,
            output: toolOutputForResponses(tr),
          });
        }
      }
      if (m.content.length > 0) {
        result.push({ role: "user", content: userContentsFor(m.content) });
      }
    } // end if (m.toolResults && m.toolResults.length > 0)
    else if (m.role === "assistant") {
      result.push({
        role: "assistant",
        content:
          typeof m.content === "string" ? m.content : contentToText(m.content),
      });
    } else {
      result.push({
        role: m.role,
        content: userContentsFor(m.content),
      });
    }
  }

  return result;
}

// LLM client for openai-compat (Chat Completions) endpoints.
export class OpenAICompatClient implements LLMClient {
  readonly protocol = "openai-compat" as const;

  private client: OpenAI;
  private model: string;
  private systemPrompt: string;
  private maxOutputTokens: number;
  private thinkingLevel: ThinkingLevel;
  private config: ProviderConfig;

  constructor(config: ProviderConfig, systemPrompt: string) {
    const apiKey = resolveAPIKey(config);
    if (!apiKey) {
      throw new AuthenticationError(
        "OpenAI API key not found. Set OPENAI_API_KEY in ~/.yukino/config.yaml, or via OPENAI_API_KEY env variable.",
      );
    }
    this.client = new OpenAI({ apiKey, baseURL: config.base_url });
    this.model = config.model;
    this.systemPrompt = systemPrompt;
    this.maxOutputTokens = getMaxOutputTokens(config);
    this.config = { ...config };
    this.thinkingLevel = getThinkingLevel(config);
  }
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
  setMaxOutputTokens(maxTokens: number): void {
    this.maxOutputTokens = maxTokens;
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
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: this.systemPrompt,
      },

      ...buildChatCompletionMessages(
        ensureToolPairing(conversation.getMessages()),
      ),
    ];

    const tools = toolSchemas.map(toOpenAICompatTool);

    const effort = toReasoningEffort(this.getThinkingLevel(), this.config);
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.maxOutputTokens,
      ...(tools.length > 0 ? { tools } : {}),
      // Configured non-reasoning providers omit the field; off otherwise sends
      // none explicitly so a server default cannot silently enable reasoning.
      ...(effort !== null ? { reasoning_effort: effort } : {}),
    };

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    // There is no cache_creation concept here, so it stays 0.
    const cacheCreationInputTokens = 0;

    try {
      const stream = await this.client.chat.completions.create(params, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      const toolCalls = new Map<
        number,
        {
          id: string;
          name: string;
          args: string;
        }
      >();

      /** enum: "length" | "tool_calls" */
      let finishReason: string | null = null;
      let reasoningAccumulate = "";

      for await (const chunk of stream) {
        // Usage may arrive in a trailing chunk with empty choices,
        // so check it before the delta guard.
        if (chunk.usage) {
          outputTokens = chunk.usage.completion_tokens ?? 0;
          cacheReadInputTokens =
            chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          inputTokens = Math.max(
            0,
            (chunk.usage.prompt_tokens ?? 0) - cacheReadInputTokens,
          );
        }

        if (chunk.choices.length === 0) {
          continue;
        }
        const delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta =
          chunk.choices[0].delta;
        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        } // end if (delta.content)

        // const reasoningContent = delta.reasoning_content;
        const reasoningContent = strArg(asRecord(delta), "reasoning_content");
        if (reasoningContent) {
          reasoningAccumulate += reasoningContent;
          yield { type: "thinking_delta", text: reasoningContent };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls.has(tc.index)) {
              toolCalls.set(tc.index, {
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
                args: "",
              });

              if (tc.id) {
                yield {
                  type: "tool_call_start",
                  toolName: tc.function?.name ?? "",
                  toolId: tc.id ?? "",
                };
              }
            } // end if (!toolCalls.has(tc.index))

            const existing = toolCalls.get(tc.index);
            if (existing) {
              if (tc.id) {
                existing.id = tc.id;
              }

              if (tc.function?.name) {
                existing.name = tc.function.name;
              }

              if (tc.function?.arguments) {
                existing.args += tc.function.arguments;
                yield {
                  type: "tool_call_delta",
                  text: tc.function.arguments,
                };
              }
            } // end if (existing)
          }
        } // end if (delta.tool_calls)

        if (chunk.choices[0].finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
          if (reasoningAccumulate) {
            yield {
              type: "thinking_complete",
              thinking: reasoningAccumulate,
              signature: "",
            };
            reasoningAccumulate = "";
          }
          for (const tu of toolCalls.values()) {
            let args: Record<string, unknown> = {};
            const jsonArgs = tu.args;
            if (jsonArgs) {
              try {
                const parsed: unknown = JSON.parse(jsonArgs);
                args = isRecord(parsed) ? asRecord(parsed) : {};
              } catch (err) {
                log.error({ err }, "llm operation failed");
                args = {};
              }
            }
            // Emit unconditionally: some compat servers send "" (or nothing)
            // instead of "{}" for no-argument tool calls, and gating the
            // completion on non-empty arguments would silently drop the call.
            yield {
              type: "tool_call_complete",
              toolName: tu.name,
              toolId: tu.id,
              arguments: args,
            };
          }
        }
      }

      if (finishReason === null) {
        throw new NetworkError(
          "Chat Completions stream ended before a finish reason",
        );
      }

      // Map Chat Completions finish_reason to Yukino's internal stop reason.
      // "length" means the model hit max_tokens
      // "tool_calls" means tool use;
      // "stop" (or anything else) means normal end_turn

      let stopReason: string;
      if (finishReason === "length") {
        stopReason = "max_tokens";
      } else if (finishReason === "tool_calls" || toolCalls.size > 0) {
        stopReason = "tool_use";
      } else {
        stopReason = "end_turn";
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
      throw classifyOpenAIError(err);
    }
  }
}
function classifyOpenAIError(err: unknown) {
  if (err instanceof LLMError) {
    return err;
  }
  if (err instanceof OpenAI.APIError) {
    if (
      err.status === OpenAIErrorCode.PromptTooLong ||
      (err.status === OpenAIErrorCode.BadRequest &&
        containsContextLengthError(err.message))
    ) {
      return new ContextTooLongError(`Context Too Long: ${err.message}`);
    }

    if (err.status === OpenAIErrorCode.InvalidAPIKey) {
      return new AuthenticationError(`Invalid API key: ${err.message}`);
    }

    if (err.status === OpenAIErrorCode.RateLimitError) {
      const headers: unknown = err.headers;
      return new RateLimitError(
        "Rate limit error, please wait.",
        headers instanceof Headers
          ? (headers.get("retry-after") ?? undefined)
          : undefined,
      );
    }

    return new LLMError(
      `OpenAI API error (${asString(err.status)}): ${err.message}`,
    );
  }

  return new NetworkError(
    `Network error: ${err instanceof Error ? err.message : asString(err)}`,
  );
}

// Convert Yukino's conversation into Chat Completions messages,
// preserving assistant tool_calls and tool_results (role: "tool") turns
// so multi-turn tool use works over the openai-compat (Chat Completions) endpoint.

export function buildChatCompletionMessages(
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] {
  const params: OpenAI.ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    const reasoning = m.thinkingBlocks?.map((tb) => tb.thinking).join("") ?? "";
    const assistantText =
      typeof m.content === "string" ? m.content : contentToText(m.content);

    if (m.toolUses && m.toolUses.length > 0) {
      params.push({
        role: "assistant",
        content: assistantText || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: m.toolUses.map((tu) => ({
          id: tu.toolUseId,
          type: "function" as const,
          function: {
            name: tu.toolName,
            arguments: JSON.stringify(tu.arguments),
          },
        })),
      });
    } // end if (m.toolUses && m.toolUses.length > 0)
    else if (m.toolResults && m.toolResults.length > 0) {
      const pendingRichParts: OpenAI.ChatCompletionContentPart[] = [];
      for (const tr of m.toolResults) {
        params.push({
          role: "tool",
          tool_call_id: tr.toolUseId,
          content: tr.content,
        });
        pendingRichParts.push(...collectRichParts(tr));
      }
      if (m.content.length > 0) {
        const content = userPartsFor(m.content);
        pendingRichParts.push(
          ...(typeof content === "string"
            ? [{ type: "text" as const, text: content }]
            : content),
        );
      }
      if (pendingRichParts.length > 0) {
        params.push({
          role: "user",
          content: pendingRichParts,
        });
      }
    } // end if (m.toolResults && m.toolResults.length > 0)
    else if (m.role === "assistant") {
      params.push({
        role: "assistant",
        content: assistantText,
        ...(reasoning
          ? {
              reasoning_content: reasoning,
            }
          : {}),
      });
    } // end if (m.role === "assistant")
    else if (m.role === "system") {
      params.push({
        role: "system",
        content:
          typeof m.content === "string" ? m.content : contentToText(m.content),
      });
    } else {
      params.push({
        role: "user",
        content: userPartsFor(m.content),
      });
    }
  }
  return params;
}
