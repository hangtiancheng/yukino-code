import { z } from "zod";

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
  permissionMode: string;
  thinkingLevel: string;
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
  planPath: string;
  planContent: string;
}

export interface CodeReviewProgressPayload {
  phase: string;
  message: string;
  /** 0..1 overall completion estimate, when known. */
  progress?: number;
}

export interface SteeringPayload {
  text: string;
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
    type: z.literal("connected"),
    data: z.strictObject({ session: z.string(), cwd: z.string() }),
  }),
  z.strictObject({
    type: z.literal("commands"),
    data: z.array(slashCommandSchema),
  }),
  z.strictObject({
    type: z.literal("status"),
    data: z.strictObject({
      model: z.string(),
      permissionMode: z.string(),
      thinkingLevel: z.string(),
    }),
  }),
  z.strictObject({
    type: z.literal("system"),
    data: z.strictObject({ message: z.string() }),
  }),
  z.strictObject({ type: z.literal("clear"), data: z.null() }),
  z.strictObject({ type: z.literal("command_done"), data: z.null() }),
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
    }),
  }),
  z.strictObject({
    type: z.literal("permission_request"),
    data: z.strictObject({
      id: z.string(),
      toolName: z.string(),
      description: z.string(),
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
    type: z.literal("plan_approval_request"),
    data: z.strictObject({ planPath: z.string(), planContent: z.string() }),
  }),
  z.strictObject({
    type: z.literal("session_list"),
    data: z.strictObject({ sessions: z.array(sessionSummarySchema) }),
  }),
  z.strictObject({ type: z.literal("code_review_form"), data: z.null() }),
  z.strictObject({
    type: z.literal("code_review_progress"),
    data: z.strictObject({
      phase: z.string(),
      message: z.string(),
      progress: z.number().optional(),
    }),
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
    data: z.strictObject({ inputTokens: z.number(), outputTokens: z.number() }),
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
  choice: PlanChoice;
  feedback?: string;
}

/** Transformed code-review form values; shape matches the server's
 *  CodeReviewStartSchema (server.ts), where every field is optional. */
export interface CodeReviewStartPayload {
  background?: string;
  from?: string;
  to?: string;
  commit?: string;
  excludePatterns?: string[];
}

export type ClientMessage =
  | { type: "user_message"; data: UserMessagePayload }
  | { type: "permission_response"; data: PermissionResponsePayload }
  | { type: "ask_user_response"; data: AskUserResponsePayload }
  | { type: "plan_approval_response"; data: PlanApprovalResponsePayload }
  | { type: "code_review_start"; data: CodeReviewStartPayload }
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

export interface ReviewItem {
  kind: "review";
  id: string;
  phase: string;
  message: string;
  /** 0..1 overall completion estimate, when known. */
  progress: number | null;
  done: boolean;
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
  | ReviewItem
  | DoneItem;

/* ───────────────────────── Derived helper types ───────────────────────── */

/** A message key used to correlate tool_use with later tool_result events. */
export function toolKey(toolName: string, toolId: string): string {
  return `${toolName}_${toolId}`;
}
