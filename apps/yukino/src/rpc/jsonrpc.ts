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

// JSON-RPC 2.0 client peer for the Yukino bridge's native transports — the
// websocket (yukino/ws) and stdio (yukino/stdio) servers. Both speak the same
// protocol the bridge fans out as notifications and answers as requests; only
// the framing differs (one websocket text frame vs one newline-delimited line),
// and that lives in each transport. This module owns request/response
// correlation and the notification→RemoteEvent mapping, so the two transports
// stay thin and behave identically to the Connect client in client.ts.
//
// Inbound payloads are validated with zod. Every notification field carries a
// .catch() default, so a bridge newer than this client — or a field that arrives
// mistyped — degrades to a sensible value instead of dropping the whole event.

import { safeParse, z } from "zod";

import type { RemoteEvent, RpcContentBlock, RpcQuestion } from "./client.js";

import { asError } from "@/utils/index.js";

/** An error reported by the bridge in a JSON-RPC error response. */
export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * JsonRpcPeer correlates requests with responses and dispatches notifications
 * over a single duplex text channel. The transport supplies `write` (send one
 * encoded message) and calls `feed` for each inbound message, plus `failAll`
 * when the channel dies so in-flight requests never hang.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners: ((
    method: string,
    params: unknown,
  ) => void)[] = [];

  constructor(private readonly write: (encoded: string) => void) {}

  /** Registers a handler invoked for every inbound notification. */
  onNotification(fn: (method: string, params: unknown) => void): void {
    this.notificationListeners.push(fn);
  }

  /** Sends one request and resolves with its result, or rejects on error. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const encoded = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write(encoded);
      } catch (err) {
        this.pending.delete(id);
        reject(asError(err));
      }
    });
  }

  /** Handles one inbound encoded message (a response or a notification). */
  feed(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return; // a malformed frame is dropped, not fatal to the stream
    }
    const parsed = safeParse(WireMessageSchema, json);
    if (!parsed.success) {
      return;
    }
    const msg = parsed.data;
    if (msg.method !== undefined) {
      // The bridge sends prompts as notifications, never as server→client
      // requests, so anything carrying a method is a notification.
      for (const fn of this.notificationListeners) {
        fn(msg.method, msg.params);
      }
      return;
    }
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new JsonRpcError(
            msg.error.message ?? "RPC error",
            msg.error.code,
            msg.error.data,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  /** Rejects every in-flight request; called when the channel dies. */
  failAll(err: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

// One decoded JSON-RPC message. A response carries id + result/error; a
// notification carries method. The envelope is shared, so every member is
// optional and a peer never chokes on either shape.
const WireMessageSchema = z.looseObject({
  jsonrpc: z.string().optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.number().optional(),
      message: z.string().optional(),
      data: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});

// Notification param schemas. Every field has a .catch() default so a missing
// or mistyped value degrades gracefully instead of dropping the whole event.
const SessionConnectedSchema = z.looseObject({
  model: z.string().catch(""),
  streaming: z.boolean().catch(false),
  ready: z.boolean().catch(false),
  permissionMode: z.string().catch(""),
});
const CommandsSchema = z
  .array(
    z.looseObject({
      name: z.string().catch(""),
      description: z.string().catch(""),
    }),
  )
  .catch([]);
const RunStartSchema = z.looseObject({ userMessageId: z.string().catch("") });
const TextSchema = z.looseObject({ text: z.string().catch("") });
const StreamEndSchema = z.looseObject({
  text: z.string().catch(""),
  messageId: z.string().catch(""),
});
const ThinkingCompleteSchema = z.looseObject({
  thinking: z.string().catch(""),
  signature: z.string().catch(""),
});
const ToolUseSchema = z.looseObject({
  toolName: z.string().catch(""),
  toolId: z.string().catch(""),
  args: z.record(z.string(), z.unknown()).catch({}),
});
const ToolResultSchema = z.looseObject({
  toolName: z.string().catch(""),
  toolId: z.string().catch(""),
  output: z.string().catch(""),
  isError: z.boolean().catch(false),
  elapsed: z.number().catch(0),
});
const LoopCompleteSchema = z.looseObject({ stopReason: z.string().catch("") });
const UsageSchema = z.looseObject({
  inputTokens: z.number().catch(0),
  outputTokens: z.number().catch(0),
});
const MessageSchema = z.looseObject({ message: z.string().catch("") });
const RetrySchema = z.looseObject({
  reason: z.string().catch(""),
  waitMs: z.number().catch(0),
});
const PermissionRequestSchema = z.looseObject({
  id: z.string().catch(""),
  toolName: z.string().catch(""),
  description: z.string().catch(""),
});
const QuestionAskSchema = z.looseObject({
  id: z.string().catch(""),
  questions: z
    .array(
      z.looseObject({
        question: z.string().catch(""),
        header: z.string().catch(""),
        multiSelect: z.boolean().catch(false),
        options: z
          .array(
            z.looseObject({
              label: z.string().catch(""),
              description: z.string().catch(""),
            }),
          )
          .catch([]),
      }),
    )
    .catch([]),
});

function parseEvent<S extends z.ZodType>(
  schema: S,
  params: unknown,
): z.infer<S> | null {
  const parsed = safeParse(schema, params);
  return parsed.success ? parsed.data : null;
}

/**
 * mapJsonRpcEvent translates one bridge notification into a RemoteEvent, or
 * null when the method is not part of the contract the UI understands. It is
 * the JSON-RPC counterpart of mapEvent in client.ts and produces exactly the
 * same shapes, so a RemoteAgent feeds the UI identically over any transport.
 */
export function mapJsonRpcEvent(
  method: string,
  params: unknown,
): RemoteEvent | null {
  switch (method) {
    case "session/connected": {
      const p = parseEvent(SessionConnectedSchema, params);
      return p
        ? {
            type: "session_connected",
            model: p.model,
            streaming: p.streaming,
            ready: p.ready,
            permissionMode: p.permissionMode,
          }
        : null;
    }
    case "session/ready":
      return { type: "session_ready" };
    case "session/commands": {
      const commands = parseEvent(CommandsSchema, params) ?? [];
      return {
        type: "session_commands",
        commands: commands.map((c) => ({
          name: c.name,
          description: c.description,
        })),
      };
    }
    case "session/context_cleared":
      return { type: "context_cleared" };
    case "session/command_done":
      return { type: "command_done" };
    case "agent/run_start": {
      const p = parseEvent(RunStartSchema, params);
      return p ? { type: "run_start", userMessageId: p.userMessageId } : null;
    }
    case "agent/stream_text": {
      const p = parseEvent(TextSchema, params);
      return p ? { type: "stream_text", text: p.text } : null;
    }
    case "agent/stream_end": {
      const p = parseEvent(StreamEndSchema, params);
      return p
        ? { type: "stream_end", text: p.text, messageId: p.messageId }
        : null;
    }
    case "agent/thinking_text": {
      const p = parseEvent(TextSchema, params);
      return p ? { type: "thinking_text", text: p.text } : null;
    }
    case "agent/thinking_complete": {
      const p = parseEvent(ThinkingCompleteSchema, params);
      return p
        ? {
            type: "thinking_complete",
            thinking: p.thinking,
            signature: p.signature,
          }
        : null;
    }
    case "agent/tool_use": {
      const p = parseEvent(ToolUseSchema, params);
      return p
        ? {
            type: "tool_use",
            toolName: p.toolName,
            toolId: p.toolId,
            args: p.args,
          }
        : null;
    }
    case "agent/tool_result": {
      const p = parseEvent(ToolResultSchema, params);
      return p
        ? {
            type: "tool_result",
            toolName: p.toolName,
            toolId: p.toolId,
            output: p.output,
            isError: p.isError,
            elapsed: p.elapsed,
          }
        : null;
    }
    case "agent/turn_complete":
      return { type: "turn_complete" };
    case "agent/loop_complete": {
      const p = parseEvent(LoopCompleteSchema, params);
      return p ? { type: "loop_complete", stopReason: p.stopReason } : null;
    }
    case "agent/usage": {
      const p = parseEvent(UsageSchema, params);
      return p
        ? {
            type: "usage",
            usage: {
              inputTokens: p.inputTokens,
              outputTokens: p.outputTokens,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          }
        : null;
    }
    case "agent/system": {
      const p = parseEvent(MessageSchema, params);
      return p ? { type: "system", message: p.message } : null;
    }
    case "agent/error": {
      const p = parseEvent(MessageSchema, params);
      return p ? { type: "error", error: new Error(p.message) } : null;
    }
    case "agent/compact": {
      const p = parseEvent(MessageSchema, params);
      return p ? { type: "compact", message: p.message } : null;
    }
    case "agent/retry": {
      const p = parseEvent(RetrySchema, params);
      return p ? { type: "retry", reason: p.reason, delay: p.waitMs } : null;
    }
    case "permission/request": {
      const p = parseEvent(PermissionRequestSchema, params);
      return p
        ? {
            type: "rpc_permission_request",
            id: p.id,
            toolName: p.toolName,
            description: p.description,
          }
        : null;
    }
    case "question/ask": {
      const p = parseEvent(QuestionAskSchema, params);
      return p
        ? {
            type: "question_ask",
            id: p.id,
            questions: p.questions.map((q): RpcQuestion => ({
              question: q.question,
              header: q.header,
              multiSelect: q.multiSelect,
              options: q.options.map((o) => ({
                label: o.label,
                description: o.description,
              })),
            })),
          }
        : null;
    }
    default:
      return null;
  }
}

/**
 * promptPayload converts the UI's content blocks into the session/prompt
 * params: the display text plus, only when an image is present, the
 * conversation-shaped block list the Go bridge forwards to the model. This
 * mirrors contentBlocksToGo on the Connect server, so a text-only turn stores
 * plain string content and a multimodal turn carries the full block list.
 */
export function promptPayload(blocks: RpcContentBlock[]): {
  content: string;
  blocks?: Record<string, unknown>[];
} {
  const textParts: string[] = [];
  const wire: Record<string, unknown>[] = [];
  let hasImage = false;
  for (const b of blocks) {
    if ("text" in b) {
      textParts.push(b.text);
      wire.push({ type: "text", text: b.text });
      continue;
    }
    const src = b.image;
    if ("base64" in src) {
      wire.push({
        type: "image",
        source: {
          type: "base64",
          media_type: src.base64.mediaType,
          data: src.base64.data,
        },
      });
    } else {
      wire.push({ type: "image", source: { type: "url", url: src.url } });
    }
    hasImage = true;
  }
  const content = textParts.join("");
  return hasImage ? { content, blocks: wire } : { content };
}

// The control requests answer with a single boolean flag under a known key.
const BoolFlagSchema = z.looseObject({
  queued: z.boolean().catch(false),
  applied: z.boolean().catch(false),
});
const ProviderResultSchema = z.looseObject({
  model: z.string().catch(""),
  protocol: z.string().catch(""),
  contextWindow: z.number().catch(0),
  maxOutputTokens: z.number().catch(0),
});

/** Reads the {queued}/{applied} boolean the respond and prompt requests return. */
export function readBoolFlag(res: unknown, key: "queued" | "applied"): boolean {
  const parsed = safeParse(BoolFlagSchema, res);
  return parsed.success ? parsed.data[key] : false;
}

/** Normalizes the session/select_provider result the bridge returns. */
export function readProviderResult(res: unknown): {
  model: string;
  protocol: string;
  contextWindow: number;
  maxOutputTokens: number;
} {
  const parsed = safeParse(ProviderResultSchema, res);
  return parsed.success
    ? parsed.data
    : { model: "", protocol: "", contextWindow: 0, maxOutputTokens: 0 };
}

/**
 * EventQueue bridges the transports' push-style notification callbacks to the
 * pull-style AsyncIterable that AgentRpc.watch() must return. Events are
 * buffered until a consumer awaits them; close() ends the iteration and wakes
 * any pending consumer so a dead channel never leaves watch() hanging.
 */
export class EventQueue {
  private readonly items: RemoteEvent[] = [];
  private readonly waiters: ((ev: RemoteEvent | null) => void)[] = [];
  private closed = false;

  push(ev: RemoteEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(ev);
    } else {
      this.items.push(ev);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *iterate(): AsyncGenerator<RemoteEvent> {
    for (;;) {
      const ev = await this.shift();
      if (ev === null) {
        return;
      }
      yield ev;
    }
  }

  private shift(): Promise<RemoteEvent | null> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
