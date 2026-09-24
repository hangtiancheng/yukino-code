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

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

import type { FileStateCache } from "./file-state-cache.js";

import type { FileHistory } from "@/file-history/index.js";
import type { Decision, PermissionChecker } from "@/permissions/index.js";
import type { TaskManager } from "@/subagent/task-manager.js";

export type ToolCategory = "read" | "write" | "command";

type AnthropicToolResultContent = NonNullable<
  Anthropic.ToolResultBlockParam["content"]
>;
export type ToolResultContentBlock = Exclude<
  AnthropicToolResultContent,
  string
>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type TextToolResultBlock = Extract<ToolResultContentBlock, { type: "text" }>;
type ImageToolResultBlock = Extract<ToolResultContentBlock, { type: "image" }>;
type DocumentToolResultBlock = Extract<
  ToolResultContentBlock,
  { type: "document" }
>;
type ImageMediaType = Extract<
  ImageToolResultBlock["source"],
  { type: "base64" }
>["media_type"];

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isImageMediaType(value: string): value is ImageMediaType {
  return IMAGE_MEDIA_TYPES.has(value);
}

function normalizeTextBlock(value: unknown): TextToolResultBlock | null {
  return isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string"
    ? { type: "text", text: value.text }
    : null;
}

function normalizeImageBlock(value: unknown): ImageToolResultBlock | null {
  if (!isRecord(value) || value.type !== "image" || !isRecord(value.source)) {
    return null;
  }
  if (value.source.type === "url" && typeof value.source.url === "string") {
    return { type: "image", source: { type: "url", url: value.source.url } };
  }
  if (
    value.source.type === "base64" &&
    typeof value.source.media_type === "string" &&
    isImageMediaType(value.source.media_type) &&
    typeof value.source.data === "string"
  ) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: value.source.media_type,
        data: value.source.data,
      },
    };
  }
  return null;
}

function normalizeDocumentBlock(
  value: Record<string, unknown>,
): DocumentToolResultBlock | null {
  if (value.type !== "document" || !isRecord(value.source)) {
    return null;
  }

  let source: DocumentToolResultBlock["source"] | null = null;
  if (value.source.type === "url" && typeof value.source.url === "string") {
    source = { type: "url", url: value.source.url };
  } else if (
    value.source.type === "base64" &&
    value.source.media_type === "application/pdf" &&
    typeof value.source.data === "string"
  ) {
    source = {
      type: "base64",
      media_type: "application/pdf",
      data: value.source.data,
    };
  } else if (
    value.source.type === "text" &&
    value.source.media_type === "text/plain" &&
    typeof value.source.data === "string"
  ) {
    source = {
      type: "text",
      media_type: "text/plain",
      data: value.source.data,
    };
  } else if (value.source.type === "content") {
    if (typeof value.source.content === "string") {
      source = { type: "content", content: value.source.content };
    } else if (Array.isArray(value.source.content)) {
      const content: (TextToolResultBlock | ImageToolResultBlock)[] = [];
      for (const raw of value.source.content) {
        const block = normalizeTextBlock(raw) ?? normalizeImageBlock(raw);
        if (!block) {
          return null;
        }
        content.push(block);
      }
      source = { type: "content", content };
    }
  }
  if (!source) {
    return null;
  }

  return {
    type: "document",
    source,
    ...(typeof value.title === "string" || value.title === null
      ? { title: value.title }
      : {}),
    ...(typeof value.context === "string" || value.context === null
      ? { context: value.context }
      : {}),
  };
}

export function normalizeToolResultContentBlock(
  value: unknown,
): ToolResultContentBlock | null {
  const text = normalizeTextBlock(value);
  if (text) {
    return text;
  }
  const image = normalizeImageBlock(value);
  if (image) {
    return image;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === "tool_reference" && typeof value.tool_name === "string") {
    return { type: "tool_reference", tool_name: value.tool_name };
  }
  if (
    value.type === "search_result" &&
    typeof value.source === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.content)
  ) {
    const content: TextToolResultBlock[] = [];
    for (const raw of value.content) {
      const block = normalizeTextBlock(raw);
      if (!block) {
        return null;
      }
      content.push(block);
    }
    return {
      type: "search_result",
      source: value.source,
      title: value.title,
      content,
    };
  }
  return normalizeDocumentBlock(value);
}

export function isToolResultContentBlock(
  value: unknown,
): value is ToolResultContentBlock {
  return normalizeToolResultContentBlock(value) !== null;
}

export interface ToolResult {
  output: string;
  contentBlocks?: ToolResultContentBlock[];
  isError: boolean;
}

export type PermissionRequestHandler = (
  toolName: string,
  args: Record<string, unknown>,
  decision: Decision,
  toolCallId: string,
) => Promise<"allow" | "deny" | "allowAlways">;

export interface ToolContext {
  workDir: string;
  toolCallId?: string;
  backgroundTaskId?: string;
  /**
   * Owning session, when the call runs on the main thread. Lets tools persist
   * auxiliary artifacts (e.g. a backgrounded Bash command's output) into the
   * session's tool-results spill directory so the model can Read them back.
   */
  sessionId?: string;
  /**
   * Background task registry of the loop running this call. Subagent loops
   * inject their own manager so backgrounded Bash commands notify that loop
   * instead of the main thread; tools fall back to their host-wired default
   * when absent. Explicit `null` disables backgrounding for this call even
   * when the tool instance carries a host-wired manager (in-process teammate
   * turns use this: their per-turn drain disappears at turn end, so commands
   * backgrounded there could never deliver a notification).
   */
  taskManager?: TaskManager | null;
  abortSignal?: AbortSignal;
  fileHistory?: FileHistory | undefined;
  fileStateCache?: FileStateCache | undefined;
  permissionChecker?: PermissionChecker;
  onPermissionRequest?: PermissionRequestHandler;
}

/**
 * How MCP tools enter the context, written into ToolRegistry by mcp/strategy
 * after connecting to the server.
 *
 * eager    total schema size under one tenth of the context; all go into tools[],
 *          no deferral
 * native   official endpoint; tools stay in the array with defer_loading but the
 *          server does not show them to the model, and ToolSearch returns a
 *          tool_reference so the server expands the schema
 * dispatch other endpoints support neither of the above; MCP tools never enter
 *          tools[] at all and go through McpCall
 *
 * Why three modes: tools render after system and before messages, so any change to
 * the array invalidates the entire trailing conversation-history cache. In a test
 * with twenty thousand tokens of history, appending one tool to the end of tools
 * dropped the hit rate from 99.4% to 9.5%.
 */
export type McpLoadingMode = "eager" | "native" | "dispatch";

/** Extra capabilities the MCP tool wrapper exposes to dispatch and routing logic. */
export interface MCPToolLike extends Tool {
  mcpServerName: string;
  mcpInputSchema(): Record<string, unknown>;
  setDeferLoading(on: boolean): void;
}

export interface ToolSchema {
  name: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  /** For OpenAI, this must be "function"; for Anthropic, it can be "custom" or null */
  type?: "function" | "custom";
  defer_loading?: boolean;
  description: string;

  /** The input schema for the tool. */
  input_schema: {
    type: "object";
    properties: Record<string, object>;
    required?: string[];
    [keyword: string]: unknown;
  };
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
  eager_input_streaming?: boolean;
}

export type ToolProtocol = "anthropic" | "openai" | "openai-compat";

export type AnthropicToolSchema = ToolSchema | Anthropic.Tool;
export type OpenAIResponsesToolSchema = OpenAI.Responses.FunctionTool;
export type OpenAICompatToolSchema = OpenAI.ChatCompletionFunctionTool;
export type ProviderToolSchema =
  | ToolSchema
  | AnthropicToolSchema
  | OpenAIResponsesToolSchema
  | OpenAICompatToolSchema;

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;

  /**
   * Whether to defer loading. A deferred tool does not appear in the initial
   * tool list; the model must first pull its schema out via ToolSearch before
   * it can call it.
   *
   * Only MCP tools are set to true. MCP is configured per project, a single
   * server can easily expose dozens of tools with long schemas, and stuffing
   * all of them into the initial tool list would eat up a large chunk of the
   * context — especially since most of those tools won't be used in a given
   * session. Built-in tools are a fixed few dozen, a controllable count;
   * hiding them would only force the model into an extra ToolSearch round
   * trip, so they are never deferred and always ship their full schema.
   */
  deferred?: boolean;

  /**
   * Whether this particular invocation can run concurrently with others,
   * judged by actual arguments rather than just the tool category.
   *
   * When not implemented, falls back to category: read-only tools may run
   * concurrently, write and command tools may not. Currently Bash
   * (argument-dependent: ls vs rm are both Bash but have very different safety
   * profiles) and ComputerUse (always false — it drives a single physical
   * screen/mouse/keyboard) implement this.
   */
  isConcurrencySafe?(args: Record<string, unknown>): boolean;

  schema(): ToolSchema;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

export const SKIP_DIRS = new Set([
  ".agents",
  ".git", // Git
  ".yukino", // Yukino
  ".next", // Next.js
  ".venv", // Python venv
  ".mypy_cache", // Python mypy
  "__pycache__", // Python
  "dist", // Webpack, Vite
  "node_modules", // Node.js
]);
