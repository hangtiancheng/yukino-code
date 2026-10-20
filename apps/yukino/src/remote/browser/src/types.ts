import { z } from "zod";

import { McpAppSchema } from "@/mcp/apps.js";
import type { McpApp, McpAppRequest } from "@/mcp/apps.js";

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
  mcpApp?: McpApp;
}

export interface PermissionRequestPayload {
  id: string;
  toolName: string;
  description: string;
  rememberPatterns?: string[];
}

export interface QuestionOption {
  label: string;
  description?: string;
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
  stopReason: string;
  totalTurns: number;
  elapsed: number;
}

export interface UsagePayload {
  inputTokens: number;
  outputTokens: number;
  /** Live context-window occupancy (terminal footer parity). */
  contextTokens: number;
  contextWindow: number;
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

/** Live snapshot of model / permission mode / thinking level. */
export interface StatusPayload {
  model: string;
  provider: string;
  permissionMode: string;
  thinkingLevel: string;
  thinkingLevels: string[];
  sandboxEnabled: boolean;
  sandboxAutoAllow: boolean;
  contextWindow: number;
}

export interface SessionSummary {
  id: string;
  firstMessage: string;
  messageCount: number;
  /** ISO timestamp of the session file's last modification. */
  modTime: string;
}

export interface SessionListPayload {
  sessions: SessionSummary[];
}

export interface PlanApprovalPayload {
  id: string;
  planPath: string;
  planContent: string;
}

export interface SteeringPayload {
  text: string;
}

export interface TodoTask {
  id: string;
  subject: string;
  activeForm: string | null;
  status: string;
}

export interface TodoUpdatePayload {
  boardId: string;
  tasks: TodoTask[];
}

export interface SubagentInfo {
  toolCallId: string;
  role: string;
  background: boolean;
  turnCount: number;
  status: "running" | "completed" | "failed" | "stopped";
  activeTools: { toolId: string; toolName: string }[];
}

export interface BackgroundTaskInfo {
  id: string;
  name: string;
  kind: string;
  status: string;
}

export interface TeammateInfo {
  name: string;
  teamName: string;
  status: string;
  spinnerVerb: string;
  lastMessage: string | null;
  turnCount: number;
  toolUseCount: number;
  tokenCount: number;
  activeTools: { toolId: string; toolName: string }[];
}

export interface ModelInfo {
  id: string;
  name: string | null;
}

export interface ModelListPayload {
  status: "loading" | "ready" | "empty" | "error";
  models: ModelInfo[];
  current: string;
}

export interface ProviderInfo {
  name: string;
  protocol: string;
  base_url: string;
  model: string;
}

export interface ProviderListPayload {
  providers: ProviderInfo[];
  current: number;
}

export interface RewindSnapshot {
  index: number;
  /** Snapshot UUID, unique across sessions and head trimming. */
  id: string;
  userText: string;
  timestamp: string;
  fileCount: number;
}

export interface ThinkingFormPayload {
  current: string;
  levels: string[];
}

export interface FileCompleteResponsePayload {
  requestId: string;
  matches: string[];
}

export interface ImageResultPayload {
  clientId: string;
  path?: string;
  message?: string;
}

const slashCommandSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
});
const questionSchema = z.strictObject({
  question: z.string(),
  header: z.string(),
  options: z.array(
    z.strictObject({ label: z.string(), description: z.string().optional() }),
  ),
  multiSelect: z.boolean(),
});
const sessionSummarySchema = z.strictObject({
  id: z.string(),
  firstMessage: z.string(),
  messageCount: z.number(),
  modTime: z.string(),
});
const toolArgsSchema = z.record(z.string(), z.unknown()).nullable();

/** Complete runtime schema for frames crossing the WebSocket boundary. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("mcp_app_response"),
    data: z.strictObject({
      requestId: z.string(),
      result: z.unknown().optional(),
      error: z.string().optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("connected"),
    data: z.strictObject({
      session: z.string(),
      cwd: z.string(),
      streaming: z.boolean(),
    }),
  }),
  z.strictObject({
    type: z.literal("commands"),
    data: z.array(slashCommandSchema),
  }),
  z.strictObject({
    type: z.literal("status"),
    data: z.strictObject({
      model: z.string(),
      provider: z.string(),
      permissionMode: z.string(),
      thinkingLevel: z.string(),
      thinkingLevels: z.array(z.string()),
      sandboxEnabled: z.boolean(),
      sandboxAutoAllow: z.boolean(),
      contextWindow: z.number(),
    }),
  }),
  z.strictObject({
    type: z.literal("system"),
    data: z.strictObject({
      message: z.string(),
      markdown: z.boolean().optional(),
    }),
  }),
  z.strictObject({ type: z.literal("clear"), data: z.null() }),
  z.strictObject({ type: z.literal("command_done"), data: z.null() }),
  z.strictObject({
    type: z.literal("run_state"),
    data: z.strictObject({ streaming: z.boolean() }),
  }),
  z.strictObject({
    type: z.literal("replay_user"),
    data: z.strictObject({ content: z.string() }),
  }),
  z.strictObject({
    type: z.literal("replay_assistant"),
    data: z.strictObject({ content: z.string() }),
  }),
  z.strictObject({
    type: z.literal("stream_text"),
    data: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({
    type: z.literal("stream_end"),
    data: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({
    type: z.literal("thinking_text"),
    data: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({
    type: z.literal("tool_use"),
    data: z.strictObject({
      toolId: z.string(),
      toolName: z.string(),
      args: toolArgsSchema,
    }),
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    data: z.strictObject({
      toolId: z.string(),
      toolName: z.string(),
      output: z.string(),
      isError: z.boolean(),
      elapsed: z.number(),
      mcpApp: McpAppSchema.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("permission_request"),
    data: z.strictObject({
      id: z.string(),
      toolName: z.string(),
      description: z.string(),
      rememberPatterns: z.array(z.string()).optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("ask_user"),
    data: z.strictObject({
      id: z.string(),
      questions: z.array(questionSchema),
    }),
  }),
  z.strictObject({
    type: z.literal("request_expired"),
    data: z.strictObject({
      id: z.string(),
      kind: z.enum(["permission", "ask"]),
      response: z.enum(["allow", "deny", "allowAlways"]).optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("plan_approval_closed"),
    data: z.strictObject({ id: z.string() }),
  }),
  z.strictObject({
    type: z.literal("plan_approval_request"),
    data: z.strictObject({
      id: z.string(),
      planPath: z.string(),
      planContent: z.string(),
    }),
  }),
  z.strictObject({
    type: z.literal("session_list"),
    data: z.strictObject({ sessions: z.array(sessionSummarySchema) }),
  }),
  z.strictObject({
    type: z.literal("steering_queued"),
    data: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({
    type: z.literal("steering_delivered"),
    data: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({
    type: z.literal("turn_complete"),
    data: z.strictObject({ turn: z.number() }),
  }),
  z.strictObject({
    type: z.literal("loop_complete"),
    data: z.strictObject({
      stopReason: z.string(),
      totalTurns: z.number(),
      elapsed: z.number(),
    }),
  }),
  z.strictObject({
    type: z.literal("usage"),
    data: z.strictObject({
      inputTokens: z.number(),
      outputTokens: z.number(),
      contextTokens: z.number(),
      contextWindow: z.number(),
    }),
  }),
  z.strictObject({
    type: z.literal("error"),
    data: z.strictObject({ message: z.string() }),
  }),
  z.strictObject({
    type: z.literal("compact"),
    data: z.strictObject({ message: z.string() }),
  }),
  z.strictObject({
    type: z.literal("retry"),
    data: z.strictObject({ reason: z.string(), waitMs: z.number() }),
  }),
  z.strictObject({ type: z.literal("pong"), data: z.null() }),
  z.strictObject({
    type: z.literal("history"),
    data: z.strictObject({ entries: z.array(z.string()) }),
  }),
  z.strictObject({
    type: z.literal("todo_update"),
    data: z.strictObject({
      boardId: z.string(),
      tasks: z.array(
        z.strictObject({
          id: z.string(),
          subject: z.string(),
          activeForm: z.string().nullable(),
          status: z.string(),
        }),
      ),
    }),
  }),
  z.strictObject({
    type: z.literal("subagents"),
    data: z.strictObject({
      list: z.array(
        z.strictObject({
          toolCallId: z.string(),
          role: z.string(),
          background: z.boolean(),
          turnCount: z.number(),
          status: z.enum(["running", "completed", "failed", "stopped"]),
          activeTools: z.array(
            z.strictObject({ toolId: z.string(), toolName: z.string() }),
          ),
        }),
      ),
    }),
  }),
  z.strictObject({
    type: z.literal("background_tasks"),
    data: z.strictObject({
      list: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          kind: z.string(),
          status: z.string(),
        }),
      ),
    }),
  }),
  z.strictObject({
    type: z.literal("teammates"),
    data: z.strictObject({
      list: z.array(
        z.strictObject({
          name: z.string(),
          teamName: z.string(),
          status: z.string(),
          spinnerVerb: z.string(),
          lastMessage: z.string().nullable(),
          turnCount: z.number(),
          toolUseCount: z.number(),
          tokenCount: z.number(),
          activeTools: z.array(
            z.strictObject({ toolId: z.string(), toolName: z.string() }),
          ),
        }),
      ),
    }),
  }),
  z.strictObject({
    type: z.literal("model_list"),
    data: z.strictObject({
      status: z.enum(["loading", "ready", "empty", "error"]),
      models: z.array(
        z.strictObject({ id: z.string(), name: z.string().nullable() }),
      ),
      current: z.string(),
    }),
  }),
  z.strictObject({
    type: z.literal("provider_list"),
    data: z.strictObject({
      providers: z.array(
        z.strictObject({
          name: z.string(),
          protocol: z.string(),
          base_url: z.string(),
          model: z.string(),
        }),
      ),
      current: z.number(),
    }),
  }),
  z.strictObject({
    type: z.literal("rewind_list"),
    data: z.strictObject({
      snapshots: z.array(
        z.strictObject({
          index: z.number(),
          id: z.string(),
          userText: z.string(),
          timestamp: z.string(),
          fileCount: z.number(),
        }),
      ),
    }),
  }),
  z.strictObject({
    type: z.literal("thinking_form"),
    data: z.strictObject({
      current: z.string(),
      levels: z.array(z.string()),
    }),
  }),
  z.strictObject({
    type: z.literal("file_complete_response"),
    data: z.strictObject({
      requestId: z.string(),
      matches: z.array(z.string()),
    }),
  }),
  z.strictObject({
    type: z.literal("image_saved"),
    data: z.strictObject({ clientId: z.string(), path: z.string() }),
  }),
  z.strictObject({
    type: z.literal("image_error"),
    data: z.strictObject({ clientId: z.string(), message: z.string() }),
  }),
  z.strictObject({
    type: z.literal("followups"),
    data: z.strictObject({ list: z.array(z.string()) }),
  }),
  z.strictObject({
    type: z.literal("tool_output"),
    data: z.strictObject({ toolId: z.string(), output: z.string() }),
  }),
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Validates a complete WebSocket frame before it reaches the reducer. */
export function isServerMessage(value: unknown): value is ServerMessage {
  return ServerMessageSchema.safeParse(value).success;
}

/* ───────────────────────── Client → Server messages ───────────────────────── */

export type PermissionResponse = "allow" | "deny" | "allowAlways";

export type PlanChoice = "yolo" | "manual" | "feedback";

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

export interface PlanApprovalResponsePayload {
  id: string;
  choice: PlanChoice;
  feedback?: string;
}

export type PermissionModeChoice =
  "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface SetPermissionModePayload {
  mode: PermissionModeChoice;
}

export interface ModelSelectPayload {
  model: string;
}

export interface ProviderSelectPayload {
  index: number;
}

export interface ProviderSavePayload {
  name: string;
  protocol: "anthropic" | "openai" | "openai-compat";
  base_url: string;
  api_key?: string;
  model: string;
}

export type RewindChoice =
  "code_and_conversation" | "conversation_only" | "code_only";

export interface RewindActionPayload {
  snapshotId: string;
  action: RewindChoice;
}

export interface FileCompleteRequestPayload {
  requestId: string;
  query: string;
}

export interface ImageUploadPayload {
  clientId: string;
  name: string;
  dataBase64: string;
}

export type ClientMessage =
  | { type: "mcp_app_request"; data: McpAppRequest }
  | { type: "user_message"; data: UserMessagePayload }
  | { type: "permission_response"; data: PermissionResponsePayload }
  | { type: "ask_user_response"; data: AskUserResponsePayload }
  | { type: "plan_approval_response"; data: PlanApprovalResponsePayload }
  | { type: "set_permission_mode"; data: SetPermissionModePayload }
  | { type: "model_list_request"; data: Record<string, never> }
  | { type: "model_select"; data: ModelSelectPayload }
  | { type: "provider_list_request"; data: Record<string, never> }
  | { type: "provider_select"; data: ProviderSelectPayload }
  | { type: "provider_save"; data: ProviderSavePayload }
  | { type: "rewind_list_request"; data: Record<string, never> }
  | { type: "rewind_action"; data: RewindActionPayload }
  | { type: "file_complete_request"; data: FileCompleteRequestPayload }
  | { type: "image_upload"; data: ImageUploadPayload }
  | { type: "background_shells"; data: Record<string, never> }
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
  markdown?: boolean;
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
  mcpApp?: McpApp;
}

export interface PermissionItem {
  kind: "permission";
  id: string;
  toolName: string;
  description: string;
  rememberPatterns?: string[];
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
