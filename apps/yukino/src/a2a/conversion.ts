import { randomUUID } from "node:crypto";

import { Role } from "@a2a-js/sdk";
import type {
  Message,
  Part,
  Task,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { z } from "zod";

import type { AgentEvent } from "@/agent/events.js";

/** Discriminator key inside structured data parts owned by yukino. */
export const YUKINO_DATA_KEY = "yukino";

export const PermissionRequestDataSchema = z.object({
  [YUKINO_DATA_KEY]: z.literal("permission-request"),
  permissionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  reason: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export type PermissionRequestData = z.infer<typeof PermissionRequestDataSchema>;

export const PermissionResponseDataSchema = z.object({
  [YUKINO_DATA_KEY]: z.literal("permission-response"),
  permissionId: z.string(),
  decision: z.enum(["allow", "deny", "allowAlways"]),
});

export type PermissionResponseData = z.infer<
  typeof PermissionResponseDataSchema
>;

export type PermissionDecision = PermissionResponseData["decision"];

export const ThinkingDataSchema = z.object({
  [YUKINO_DATA_KEY]: z.literal("thinking"),
  text: z.string(),
});

export const ToolCallDataSchema = z.object({
  [YUKINO_DATA_KEY]: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export const ToolResultDataSchema = z.object({
  [YUKINO_DATA_KEY]: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  isError: z.boolean(),
  elapsed: z.number(),
  output: z.string(),
});

export type ThinkingData = z.infer<typeof ThinkingDataSchema>;
export type ToolCallData = z.infer<typeof ToolCallDataSchema>;
export type ToolResultData = z.infer<typeof ToolResultDataSchema>;

export type YukinoData =
  PermissionRequestData | ThinkingData | ToolCallData | ToolResultData;

/** Tool result outputs above this length are truncated in published events. */
export const MAX_TOOL_OUTPUT_LENGTH = 8000;

export function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

export function dataPart(data: YukinoData): Part {
  return {
    content: { $case: "data", value: data },
    metadata: undefined,
    filename: "",
    mediaType: "application/json",
  };
}

export function agentMessage(
  taskId: string,
  contextId: string,
  parts: Part[],
): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function taskStatus(state: TaskState, message?: Message): TaskStatus {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  };
}

export function statusUpdate(
  taskId: string,
  contextId: string,
  state: TaskState,
  message?: Message,
): TaskStatusUpdateEvent {
  return {
    taskId,
    contextId,
    status: taskStatus(state, message),
    metadata: undefined,
  };
}

export function taskSnapshot(
  taskId: string,
  contextId: string,
  state: TaskState,
  message?: Message,
): Task {
  return {
    id: taskId,
    contextId,
    status: taskStatus(state, message),
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

/** Extracts and concatenates the text parts of a message. */
export function messageText(message: Message): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.content?.$case === "text") {
      chunks.push(part.content.value);
    }
  }
  return chunks.join("\n\n").trim();
}

function partData(message: Message): unknown[] {
  const values: unknown[] = [];
  for (const part of message.parts) {
    if (part.content?.$case === "data") {
      values.push(part.content.value);
    }
  }
  return values;
}

/** Finds the first yukino permission-response data part, if any. */
export function findPermissionResponse(
  message: Message,
): PermissionResponseData | null {
  for (const value of partData(message)) {
    const parsed = PermissionResponseDataSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
}

/** Maps a yukino agent event to an A2A status-update message, if any. */
export function agentEventToMessage(
  event: AgentEvent,
  taskId: string,
  contextId: string,
): Message | null {
  switch (event.type) {
    case "stream_text":
      return agentMessage(taskId, contextId, [textPart(event.text)]);
    case "thinking_text":
      return agentMessage(taskId, contextId, [
        dataPart({ yukino: "thinking", text: event.text }),
      ]);
    case "tool_use":
      return agentMessage(taskId, contextId, [
        dataPart({
          yukino: "tool-call",
          toolCallId: event.toolId,
          toolName: event.toolName,
          args: event.args,
        }),
      ]);
    case "tool_result": {
      const truncated = event.output.length > MAX_TOOL_OUTPUT_LENGTH;
      const output = truncated
        ? `${event.output.slice(0, MAX_TOOL_OUTPUT_LENGTH)}\n… [truncated]`
        : event.output;
      return agentMessage(taskId, contextId, [
        dataPart({
          yukino: "tool-result",
          toolCallId: event.toolId,
          toolName: event.toolName,
          isError: event.isError,
          elapsed: event.elapsed,
          output,
        }),
      ]);
    }
    default:
      return null;
  }
}
