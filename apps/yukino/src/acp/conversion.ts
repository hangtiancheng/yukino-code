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

import { isAbsolute, resolve } from "node:path";

import { RequestError } from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCallLocation,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";

import type { AgentEvent } from "@/agent/events.js";
import { COMPACT_BOUNDARY, type SessionMessage } from "@/session/index.js";
import { contentToText, strArg } from "@/utils/index.js";

export function promptToText(prompt: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of prompt) {
    switch (block.type) {
      case "text":
        if (block.text.trim()) {
          parts.push(block.text);
        }
        break;
      case "resource_link":
        parts.push(`Resource: ${block.name} (${block.uri})`);
        break;
      case "resource":
        if ("text" in block.resource) {
          parts.push(`Resource: ${block.resource.uri}\n${block.resource.text}`);
          break;
        }
        throw RequestError.invalidParams(undefined, "Binary resources are not supported.");
      case "image":
        throw RequestError.invalidParams(undefined, "Image prompts are not supported.");
      case "audio":
        throw RequestError.invalidParams(undefined, "Audio prompts are not supported.");
    }
  }

  const text = parts.join("\n\n").trim();
  if (!text) {
    throw RequestError.invalidParams(undefined, "Prompt must contain text or a resource link.");
  }
  return text;
}

export function toolKind(toolName: string): ToolKind {
  if (/^(ReadFile)$/u.test(toolName)) {
    return "read";
  }
  if (/^(WriteFile|EditFile)$/u.test(toolName)) {
    return "edit";
  }
  if (/^(Glob|Grep|ToolSearch)$/u.test(toolName)) {
    return "search";
  }
  if (/^(Bash|PowerShell|ComputerUse)$/u.test(toolName)) {
    return "execute";
  }
  if (/^(Agent|TaskCreate|TaskGet|TaskList|TaskUpdate|TaskStop)$/u.test(toolName)) {
    return "think";
  }
  if (toolName === "ExitPlanMode") {
    return "switch_mode";
  }
  return "other";
}

export function toolLocations(
  args: Record<string, unknown>,
  workDir: string,
): ToolCallLocation[] | undefined {
  const path = strArg(args, "file_path") || strArg(args, "path");
  if (!path) {
    return undefined;
  }
  return [{ path: isAbsolute(path) ? path : resolve(workDir, path) }];
}

function toolCallUpdate(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  workDir: string,
): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: toolName,
    kind: toolKind(toolName),
    status: "pending",
    rawInput: args,
    locations: toolLocations(args, workDir),
  };
}

function toolResultUpdate(
  toolCallId: string,
  output: string,
  isError: boolean,
  elapsed?: number,
): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: isError ? "failed" : "completed",
    content: output ? [{ type: "content", content: { type: "text", text: output } }] : undefined,
    rawOutput: {
      output,
      isError,
      ...(elapsed === undefined ? {} : { elapsed }),
    },
  };
}

export function agentEventToUpdate(
  event: AgentEvent,
  workDir: string,
  contextWindow: number,
): SessionUpdate | null {
  switch (event.type) {
    case "stream_text":
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.text },
      };
    case "thinking_text":
      return {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.text },
      };
    case "tool_use":
      return toolCallUpdate(event.toolName, event.toolId, event.args, workDir);
    case "tool_result":
      return toolResultUpdate(event.toolId, event.output, event.isError, event.elapsed);
    case "usage":
      return {
        sessionUpdate: "usage_update",
        used:
          event.usage.inputTokens +
          event.usage.cacheReadInputTokens +
          event.usage.cacheCreationInputTokens,
        size: contextWindow,
      };
    default:
      return null;
  }
}

export function addUsage(total: Usage, event: Extract<AgentEvent, { type: "usage" }>): Usage {
  const inputTokens = total.inputTokens + event.usage.inputTokens;
  const outputTokens = total.outputTokens + event.usage.outputTokens;
  const cachedReadTokens = (total.cachedReadTokens ?? 0) + event.usage.cacheReadInputTokens;
  const cachedWriteTokens = (total.cachedWriteTokens ?? 0) + event.usage.cacheCreationInputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
  };
}

export function emptyUsage(): Usage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };
}

export function stopReason(reason: string): StopReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "max_turn_requests":
      return "max_turn_requests";
    case "refusal":
      return "refusal";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return "end_turn";
  }
}

export function* historyNotifications(
  sessionId: string,
  messages: SessionMessage[],
  workDir: string,
): Generator<SessionNotification> {
  for (const message of messages) {
    if (
      message.type === COMPACT_BOUNDARY ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      continue;
    }

    const text = contentToText(message.content);
    if (text) {
      yield {
        sessionId,
        update: {
          sessionUpdate:
            message.role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: { type: "text", text },
        },
      };
    }

    for (const tool of message.tool_uses ?? []) {
      yield {
        sessionId,
        update: toolCallUpdate(tool.tool_name, tool.tool_use_id, tool.arguments ?? {}, workDir),
      };
    }

    for (const result of message.tool_results ?? []) {
      const output = contentToText(result.content);
      yield {
        sessionId,
        update: toolResultUpdate(result.tool_use_id, output, result.is_error ?? false),
      };
    }
  }
}
