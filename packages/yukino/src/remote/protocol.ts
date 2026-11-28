import { z } from "zod";

import { THINKING_LEVELS } from "@/config/constants.js";
import { ProviderIdentityInputSchema } from "@/config/provider-input.js";
import { McpAppSchema, McpAppRequestSchema } from "@/mcp/apps.js";
import { RuntimeStatusSchema } from "@/runtime/status.js";
export type { RuntimeStatus } from "@/runtime/status.js";

export const UserMessageSchema = z.strictObject({
  content: z.string(),
});

export const PermissionResponseSchema = z.strictObject({
  id: z.string(),
  response: z.enum(["allow", "deny", "allowAlways"]),
});

export const AskUserResponseSchema = z.strictObject({
  id: z.string(),
  answers: z.record(z.string(), z.string()),
});

export const PlanApprovalResponseSchema = z.strictObject({
  id: z.string(),
  choice: z.enum(["yolo", "manual", "feedback"]),
  feedback: z.string().optional(),
});

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

export const SetPermissionModeSchema = z.strictObject({
  mode: PermissionModeSchema,
});

export const ModelSelectSchema = z.strictObject({
  model: z.string(),
});

export const ProviderSelectSchema = z.strictObject({
  index: z.number().int().nonnegative(),
});

export const ProviderSaveSchema = ProviderIdentityInputSchema.extend({
  protocol: z.enum(["anthropic", "openai", "openai-compat"]),
  thinking: z.enum(THINKING_LEVELS).optional(),
});

export const RewindActionSchema = z.strictObject({
  // Snapshot UUIDs remain unique across session changes and head trimming.
  snapshotId: z.string(),
  action: z.enum(["code_and_conversation", "conversation_only", "code_only"]),
});

export const FileCompleteRequestSchema = z.strictObject({
  requestId: z.string(),
  query: z.string(),
});

export const ImageUploadSchema = z.strictObject({
  clientId: z.string(),
  name: z.string(),
  dataBase64: z.string(),
});

const slashCommandSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
});
const questionSchema = z.strictObject({
  question: z.string(),
  options: z.array(
    z.strictObject({ label: z.string(), description: z.string().optional() }),
  ),
  multiSelect: z.boolean(),
});
const sessionSummarySchema = z.strictObject({
  id: z.string(),
  cwd: z.string(),
  projectKey: z.string(),
  name: z.string().nullable(),
  tags: z.array(z.string()),
  archived: z.boolean(),
  firstMessage: z.string(),
  messageCount: z.number(),
  lastUserMessageTime: z.string().nullable(),
});
const toolArgsSchema = z.record(z.string(), z.unknown()).nullable();

/** Complete runtime schema for frames crossing the WebSocket boundary. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("runtime_status"),
    data: RuntimeStatusSchema,
  }),
  z.strictObject({
    type: z.literal("session_tree"),
    data: z.strictObject({
      rows: z.array(
        z.strictObject({
          id: z.string(),
          label: z.string(),
          detail: z.string(),
          current: z.boolean(),
          onCurrentPath: z.boolean(),
          depth: z.number().int().nonnegative(),
          folded: z.boolean(),
          hasChildren: z.boolean(),
        }),
      ),
      leafId: z.string().nullable(),
      summary: z.string().optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("input_prefill"),
    data: z.strictObject({ content: z.string() }),
  }),
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

export type SlashCommand = z.infer<typeof slashCommandSchema>;
export type Question = z.infer<typeof questionSchema>;
export type QuestionOption = Question["options"][number];
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type ToolArgs = z.infer<typeof toolArgsSchema>;
export type UsagePayload = Extract<ServerMessage, { type: "usage" }>["data"];
export type SessionTreeRow = Extract<
  ServerMessage,
  { type: "session_tree" }
>["data"]["rows"][number];
export type PlanApprovalPayload = Extract<
  ServerMessage,
  { type: "plan_approval_request" }
>["data"];
export type TodoTask = Extract<
  ServerMessage,
  { type: "todo_update" }
>["data"]["tasks"][number];
export type TodoUpdatePayload = Extract<
  ServerMessage,
  { type: "todo_update" }
>["data"];
export type SubagentInfo = Extract<
  ServerMessage,
  { type: "subagents" }
>["data"]["list"][number];
export type BackgroundTaskInfo = Extract<
  ServerMessage,
  { type: "background_tasks" }
>["data"]["list"][number];
export type TeammateInfo = Extract<
  ServerMessage,
  { type: "teammates" }
>["data"]["list"][number];
export type ModelListPayload = Extract<
  ServerMessage,
  { type: "model_list" }
>["data"];
export type ModelInfo = Extract<
  ServerMessage,
  { type: "model_list" }
>["data"]["models"][number];
export type ProviderListPayload = Extract<
  ServerMessage,
  { type: "provider_list" }
>["data"];
export type ProviderInfo = Extract<
  ServerMessage,
  { type: "provider_list" }
>["data"]["providers"][number];
export type RewindSnapshot = Extract<
  ServerMessage,
  { type: "rewind_list" }
>["data"]["snapshots"][number];
export type ThinkingFormPayload = Extract<
  ServerMessage,
  { type: "thinking_form" }
>["data"];
export type FileCompleteResponsePayload = Extract<
  ServerMessage,
  { type: "file_complete_response" }
>["data"];

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("user_message"), data: UserMessageSchema }),
  z.strictObject({
    type: z.literal("permission_response"),
    data: PermissionResponseSchema,
  }),
  z.strictObject({
    type: z.literal("ask_user_response"),
    data: AskUserResponseSchema,
  }),
  z.strictObject({
    type: z.literal("plan_approval_response"),
    data: PlanApprovalResponseSchema,
  }),
  z.strictObject({
    type: z.literal("set_permission_mode"),
    data: SetPermissionModeSchema,
  }),
  z.strictObject({ type: z.literal("model_select"), data: ModelSelectSchema }),
  z.strictObject({
    type: z.literal("provider_select"),
    data: ProviderSelectSchema,
  }),
  z.strictObject({
    type: z.literal("provider_save"),
    data: ProviderSaveSchema,
  }),
  z.strictObject({
    type: z.literal("rewind_action"),
    data: RewindActionSchema,
  }),
  z.strictObject({
    type: z.literal("file_complete_request"),
    data: FileCompleteRequestSchema,
  }),
  z.strictObject({ type: z.literal("image_upload"), data: ImageUploadSchema }),
  z.strictObject({
    type: z.literal("mcp_app_request"),
    data: McpAppRequestSchema,
  }),
  z.strictObject({
    type: z.literal("model_list_request"),
    data: z.strictObject({}),
  }),
  z.strictObject({
    type: z.literal("provider_list_request"),
    data: z.strictObject({}),
  }),
  z.strictObject({
    type: z.literal("rewind_list_request"),
    data: z.strictObject({}),
  }),
  z.strictObject({
    type: z.literal("background_shells"),
    data: z.strictObject({}),
  }),
  z.strictObject({ type: z.literal("ping"), data: z.strictObject({}) }),
  z.strictObject({ type: z.literal("cancel"), data: z.null() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type UserMessagePayload = z.infer<typeof UserMessageSchema>;
export type PermissionResponsePayload = z.infer<
  typeof PermissionResponseSchema
>;
export type AskUserResponsePayload = z.infer<typeof AskUserResponseSchema>;
export type PlanApprovalResponsePayload = z.infer<
  typeof PlanApprovalResponseSchema
>;
export type SetPermissionModePayload = z.infer<typeof SetPermissionModeSchema>;
export type ModelSelectPayload = z.infer<typeof ModelSelectSchema>;
export type ProviderSelectPayload = z.infer<typeof ProviderSelectSchema>;
export type ProviderSavePayload = z.infer<typeof ProviderSaveSchema>;
export type RewindActionPayload = z.infer<typeof RewindActionSchema>;
export type FileCompleteRequestPayload = z.infer<
  typeof FileCompleteRequestSchema
>;
export type ImageUploadPayload = z.infer<typeof ImageUploadSchema>;
export type PermissionResponse = PermissionResponsePayload["response"];
export type PlanChoice = PlanApprovalResponsePayload["choice"];
export type PermissionModeChoice = z.infer<typeof PermissionModeSchema>;
export type RewindChoice = RewindActionPayload["action"];
