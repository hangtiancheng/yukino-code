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

/**
 * Strict type definitions for the Yukino Remote web client.
 *
 * These mirror the WebSocket message shapes emitted by the remote server.
 * Field names are kept in lowerCamelCase to match the server's JSON output.
 */

/* ───────────────────────── Server → Client messages ───────────────────────── */

export interface ConnectedPayload {
  session: string;
  cwd: string;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export interface SystemPayload {
  message: string;
}

export interface ReplayUserPayload {
  content: string;
}

export interface ReplayAssistantPayload {
  content: string;
}

export interface StreamTextPayload {
  text: string;
}

export interface StreamEndPayload {
  text: string;
}

export interface ThinkingTextPayload {
  text: string;
}

/** Args are an opaque JSON object coming from the agent; we only peek at a few
 *  well-known preview fields and otherwise stringify the rest. */
export type ToolArgs = Record<string, unknown> | null;

export interface ToolUsePayload {
  toolId: string;
  toolName: string;
  args: ToolArgs;
}

export interface ToolResultPayload {
  toolId: string;
  toolName: string;
  output: string;
  isError: boolean;
  elapsed: number;
}

export interface PermissionRequestPayload {
  id: string;
  toolName: string;
  description: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserPayload {
  id: string;
  questions: Question[];
}

export interface TurnCompletePayload {
  turn: number;
}

export interface LoopCompletePayload {
  totalTurns: number;
  elapsed: number;
}

export interface UsagePayload {
  inputTokens: number;
  outputTokens: number;
}

export interface ErrorPayload {
  message: string;
}

export interface CompactPayload {
  message: string;
}

export interface RetryPayload {
  reason: string;
  waitMs: number;
}

/** Discriminated union of all server messages. `type` is the discriminant. */
export type ServerMessage =
  | { type: "connected"; data: ConnectedPayload }
  | { type: "commands"; data: SlashCommand[] }
  | { type: "system"; data: SystemPayload }
  | { type: "clear"; data: null }
  | { type: "command_done"; data: null }
  | { type: "replay_user"; data: ReplayUserPayload }
  | { type: "replay_assistant"; data: ReplayAssistantPayload }
  | { type: "stream_text"; data: StreamTextPayload }
  | { type: "stream_end"; data: StreamEndPayload }
  | { type: "thinking_text"; data: ThinkingTextPayload }
  | { type: "tool_use"; data: ToolUsePayload }
  | { type: "tool_result"; data: ToolResultPayload }
  | { type: "permission_request"; data: PermissionRequestPayload }
  | { type: "ask_user"; data: AskUserPayload }
  | { type: "turn_complete"; data: TurnCompletePayload }
  | { type: "loop_complete"; data: LoopCompletePayload }
  | { type: "usage"; data: UsagePayload }
  | { type: "error"; data: ErrorPayload }
  | { type: "compact"; data: CompactPayload }
  | { type: "retry"; data: RetryPayload }
  | { type: "pong"; data: null };

/* ───────────────────────── Client → Server messages ───────────────────────── */

export type PermissionResponse = "allow" | "deny" | "allowAlways";

export interface UserMessagePayload {
  content: string;
}

export interface PermissionResponsePayload {
  id: string;
  response: PermissionResponse;
}

export interface AskUserResponsePayload {
  id: string;
  answers: Record<string, string>;
}

export type ClientMessage =
  | { type: "user_message"; data: UserMessagePayload }
  | { type: "permission_response"; data: PermissionResponsePayload }
  | { type: "ask_user_response"; data: AskUserResponsePayload }
  | { type: "cancel"; data: null }
  | { type: "ping"; data: Record<string, never> };

/* ───────────────────────── Chat item model ───────────────────────── */

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

export type ToolStatus = "running" | "ok" | "err";

export interface UserItem {
  kind: "user";
  id: string;
  content: string;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  content: string;
  streaming: boolean;
}

export interface SystemItem {
  kind: "system";
  id: string;
  content: string;
}

export interface ErrorItem {
  kind: "error";
  id: string;
  content: string;
}

export interface ThinkingItem {
  kind: "thinking";
  id: string;
  content: string;
  /** When true the thinking block is finalized and its header shows "Thought". */
  done: boolean;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  toolId: string;
  toolName: string;
  args: ToolArgs;
  status: ToolStatus;
  output: string;
  isError: boolean;
  elapsed: number;
}

export interface PermissionItem {
  kind: "permission";
  id: string;
  toolName: string;
  description: string;
  responded: boolean;
  response: PermissionResponse | null;
}

export interface AskUserItem {
  kind: "askUser";
  id: string;
  questions: Question[];
  answered: boolean;
}

export interface DoneItem {
  kind: "done";
  id: string;
  elapsed: number;
}

export type ChatItem =
  | UserItem
  | AssistantItem
  | SystemItem
  | ErrorItem
  | ThinkingItem
  | ToolItem
  | PermissionItem
  | AskUserItem
  | DoneItem;

/* ───────────────────────── Derived helper types ───────────────────────── */

/** A message key used to correlate tool_use with later tool_result events. */
export function toolKey(toolName: string, toolId: string): string {
  return `${toolName}_${toolId}`;
}
