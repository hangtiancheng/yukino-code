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

// TypeScript client for the Yukino agent bridge's protobuf/Connect transport
// (yukino/pb). It is the Node/Ink counterpart of the browser connect-web
// client: the generated AgentService description is shared, only the transport
// differs (createConnectTransport here, http/1.1).
//
// The client maps the generated Event oneof onto a discriminated union
// (RemoteEvent) whose agent-progress cases are exactly the UI's AgentEvent, so
// a RemoteAgent can feed the existing use-agent-output handler without the UI
// knowing the events crossed an RPC boundary.

import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import type { AgentEvent } from "@/agent/events.js";
import {
  AgentService,
  Base64ImageSourceSchema,
  ContentBlockSchema,
  ImageBlockSchema,
  PermissionResponse,
  type ContentBlock,
  type Event,
  type Question,
} from "@/pb/yukino/v1/agent_pb.js";

/** A permission answer, matching the local agent's onPermissionRequest result. */
export type PermissionAnswer = "allow" | "deny" | "allowAlways";

/** An inline (base64) or remote (url) image source for a multimodal turn. */
export type RpcImageSource =
  { base64: { mediaType: string; data: string } } | { url: string };

/** One content block of a user turn: text or an image. */
export type RpcContentBlock = { text: string } | { image: RpcImageSource };

/** One AskUserQuestion item as the UI renders it. */
export interface RpcQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/**
 * RemoteEvent is the superset the bridge emits: the AgentEvent progress cases
 * the UI already renders, plus session-lifecycle and prompt cases that only the
 * RPC transport surfaces (the local agent handles those in-process).
 */
export type RemoteEvent =
  | AgentEvent
  | {
      type: "session_connected";
      model: string;
      streaming: boolean;
      ready: boolean;
      permissionMode: string;
    }
  | { type: "session_ready" }
  | {
      type: "session_commands";
      commands: { name: string; description: string }[];
    }
  | { type: "context_cleared" }
  | { type: "command_done" }
  | { type: "run_start"; userMessageId: string }
  | { type: "stream_end"; text: string; messageId: string }
  | { type: "system"; message: string }
  | {
      type: "rpc_permission_request";
      id: string;
      toolName: string;
      description: string;
    }
  | { type: "question_ask"; id: string; questions: RpcQuestion[] };

/** AgentRpc wraps the generated client and the Event→RemoteEvent mapping. */
export interface AgentRpc {
  /** Streams every bridge event until the call is aborted or the server stops. */
  watch(signal?: AbortSignal): AsyncIterable<RemoteEvent>;
  /** Queues one text-only user turn; resolves with whether it was accepted. */
  sendPrompt(content: string): Promise<boolean>;
  /** Queues one multimodal turn (text + image blocks). */
  sendPromptBlocks(blocks: RpcContentBlock[]): Promise<boolean>;
  /** Answers a pending permission prompt; resolves with whether it applied. */
  respondPermission(id: string, answer: PermissionAnswer): Promise<boolean>;
  /** Answers a pending question prompt; resolves with whether it applied. */
  respondQuestions(
    id: string,
    answers: Record<string, string>,
  ): Promise<boolean>;
  /** Interrupts the running turn, if any. */
  cancel(): Promise<void>;
  /** Liveness check. */
  ping(): Promise<void>;
  /** Switches the session's active LLM provider by name. */
  selectProvider(name: string): Promise<{
    model: string;
    protocol: string;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
}

const PERMISSION_WIRE: Record<PermissionAnswer, PermissionResponse> = {
  allow: PermissionResponse.ALLOW,
  deny: PermissionResponse.DENY,
  allowAlways: PermissionResponse.ALLOW_ALWAYS,
};

function mapQuestions(questions: Question[]): RpcQuestion[] {
  return questions.map((q) => ({
    question: q.question,
    header: q.header,
    multiSelect: q.multiSelect,
    options: q.options.map((o) => ({
      label: o.label,
      description: o.description,
    })),
  }));
}

/** toProtoContentBlock maps one convenient block to the generated ContentBlock. */
function toProtoContentBlock(b: RpcContentBlock): ContentBlock {
  if ("text" in b) {
    return create(ContentBlockSchema, {
      block: { case: "text", value: b.text },
    });
  }
  const src = b.image;
  const image =
    "base64" in src
      ? create(ImageBlockSchema, {
          source: {
            case: "base64",
            value: create(Base64ImageSourceSchema, {
              mediaType: src.base64.mediaType,
              data: src.base64.data,
            }),
          },
        })
      : create(ImageBlockSchema, { source: { case: "url", value: src.url } });
  return create(ContentBlockSchema, { block: { case: "image", value: image } });
}

/** mapEvent translates one generated Event into a RemoteEvent (or null when empty). */
export function mapEvent(ev: Event): RemoteEvent | null {
  const e = ev.event;
  switch (e.case) {
    case "sessionConnected":
      return {
        type: "session_connected",
        model: e.value.model,
        streaming: e.value.streaming,
        ready: e.value.ready,
        permissionMode: e.value.permissionMode,
      };
    case "sessionReady":
      return { type: "session_ready" };
    case "sessionCommands":
      return {
        type: "session_commands",
        commands: e.value.commands.map((c) => ({
          name: c.name,
          description: c.description,
        })),
      };
    case "contextCleared":
      return { type: "context_cleared" };
    case "commandDone":
      return { type: "command_done" };
    case "runStart":
      return { type: "run_start", userMessageId: e.value.userMessageId };
    case "streamText":
      return { type: "stream_text", text: e.value.text };
    case "streamEnd":
      return {
        type: "stream_end",
        text: e.value.text,
        messageId: e.value.messageId,
      };
    case "thinkingText":
      return { type: "thinking_text", text: e.value.text };
    case "thinkingComplete":
      return {
        type: "thinking_complete",
        thinking: e.value.thinking,
        signature: e.value.signature,
      };
    case "toolUse":
      return {
        type: "tool_use",
        toolName: e.value.toolName,
        toolId: e.value.toolId,
        args: e.value.args ?? {},
      };
    case "toolResult":
      return {
        type: "tool_result",
        toolName: e.value.toolName,
        toolId: e.value.toolId,
        output: e.value.output,
        isError: e.value.isError,
        elapsed: e.value.elapsed,
      };
    case "turnComplete":
      return { type: "turn_complete" };
    case "loopComplete":
      return { type: "loop_complete", stopReason: e.value.stopReason };
    case "usage":
      return {
        type: "usage",
        usage: {
          inputTokens: e.value.inputTokens,
          outputTokens: e.value.outputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
    case "system":
      return { type: "system", message: e.value.message };
    case "error":
      return { type: "error", error: new Error(e.value.message) };
    case "compact":
      return { type: "compact", message: e.value.message };
    case "retry":
      return {
        type: "retry",
        reason: e.value.reason,
        delay: Number(e.value.waitMs),
      };
    case "permissionRequest":
      return {
        type: "rpc_permission_request",
        id: e.value.id,
        toolName: e.value.toolName,
        description: e.value.description,
      };
    case "questionAsk":
      return {
        type: "question_ask",
        id: e.value.id,
        questions: mapQuestions(e.value.questions),
      };
    default:
      return null;
  }
}

/** Options for createAgentRpc. */
export interface AgentRpcOptions {
  /** Base URL of the yukino-agent Connect server, e.g. http://127.0.0.1:7860. */
  url: string;
}

/** createAgentRpc builds a Node/Ink client for the bridge's Connect transport. */
export function createAgentRpc(opts: AgentRpcOptions): AgentRpc {
  const transport = createConnectTransport({
    baseUrl: opts.url,
    httpVersion: "1.1",
  });
  const client = createClient(AgentService, transport);

  return {
    async *watch(signal?: AbortSignal): AsyncIterable<RemoteEvent> {
      for await (const ev of client.watch({}, { signal })) {
        const mapped = mapEvent(ev);
        if (mapped) {
          yield mapped;
        }
      }
    },
    async sendPrompt(content: string): Promise<boolean> {
      const res = await client.sendPrompt({
        content: [{ text: content }].map(toProtoContentBlock),
      });
      return res.queued;
    },
    async sendPromptBlocks(blocks: RpcContentBlock[]): Promise<boolean> {
      const res = await client.sendPrompt({
        content: blocks.map(toProtoContentBlock),
      });
      return res.queued;
    },
    async respondPermission(
      id: string,
      answer: PermissionAnswer,
    ): Promise<boolean> {
      const res = await client.respondPermission({
        id,
        response: PERMISSION_WIRE[answer],
      });
      return res.applied;
    },
    async respondQuestions(
      id: string,
      answers: Record<string, string>,
    ): Promise<boolean> {
      const res = await client.respondQuestions({ id, answers });
      return res.applied;
    },
    async cancel(): Promise<void> {
      await client.cancel({});
    },
    async ping(): Promise<void> {
      await client.ping({});
    },
    async selectProvider(name: string) {
      const res = await client.selectProvider({ name });
      return {
        model: res.model,
        protocol: res.protocol,
        contextWindow: res.contextWindow,
        maxOutputTokens: res.maxOutputTokens,
      };
    },
  };
}
