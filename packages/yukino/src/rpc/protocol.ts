import { z } from "zod";

import { PreferencesPatchSchema } from "@/config/preferences.js";
import {
  RPC_COMMANDS,
  RPC_MAX_LINE_BYTES,
  RPC_VERSION,
  RPC_TRANSFER_CHUNK_BYTES,
  RPC_TRANSFER_MAX_BYTES,
  RPC_TRANSFER_HASH_RE,
  RPC_TRANSFER_BASE64_RE,
} from "@/rpc/constants.js";

const id = z.string().min(1).max(128);
const text = z.string().max(RPC_MAX_LINE_BYTES);
const empty = z.strictObject({});
const jsonObject = z.record(z.string(), z.json());
const copyConfirmation = z.strictObject({
  sourceSessionId: id,
  sourceCwd: text.min(1),
  sourceRevision: z.number().int().nonnegative(),
  sourceLeafId: id.nullable(),
  destination: text.min(1),
});
export const RpcSessionRestorationArgsSchema = z
  .strictObject({
    sessionId: id,
    cwd: text.min(1).optional(),
    destination: text.min(1).optional(),
    copy: z.union([z.boolean(), copyConfirmation]).optional(),
  })
  .refine(
    (args) =>
      (args.cwd === undefined && !args.copy) || args.destination !== undefined,
    "An explicit source project or copy requires an explicit destination",
  );
const server = z.strictObject({ server: id });
const page = z.strictObject({
  server: id,
  cursor: text.optional(),
  limit: z.number().int().positive().max(4096).optional(),
});
const transferBinding = {
  transferId: z.uuid(),
  sessionId: id,
  revision: z.number().int().nonnegative(),
};
const exportArgs = {
  scope: z.enum(["active", "tree"]).default("active"),
  format: z.enum(["jsonl", "html"]).default("jsonl"),
  redact: z.boolean().default(true),
};
export const RpcExportBeginSchema = z.strictObject(exportArgs);
export const RpcImportBeginSchema = z.strictObject({
  size: z.number().int().positive().max(RPC_TRANSFER_MAX_BYTES),
  sha256: z.string().regex(RPC_TRANSFER_HASH_RE),
  cwd: text.min(1).optional(),
});
export const RpcTransferBindingSchema = z.strictObject(transferBinding);
export const RpcTransferReadSchema = z.strictObject({
  ...transferBinding,
  offset: z.number().int().nonnegative().max(RPC_TRANSFER_MAX_BYTES),
  length: z.number().int().positive().max(RPC_TRANSFER_CHUNK_BYTES),
});
export const RpcTransferWriteSchema = z
  .strictObject({
    ...transferBinding,
    offset: z.number().int().nonnegative().max(RPC_TRANSFER_MAX_BYTES),
    length: z.number().int().positive().max(RPC_TRANSFER_CHUNK_BYTES),
    data: z
      .string()
      .min(4)
      .max(4 * Math.ceil(RPC_TRANSFER_CHUNK_BYTES / 3))
      .regex(RPC_TRANSFER_BASE64_RE),
    sha256: z.string().regex(RPC_TRANSFER_HASH_RE),
  })
  .refine(
    (args) => args.data.length === 4 * Math.ceil(args.length / 3),
    "Base64 length mismatch",
  );
const promptInput = z
  .strictObject({
    text,
    attachments: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .refine(
    (input) => input.text.trim().length > 0 || !!input.attachments?.length,
    "Prompt input is empty",
  );
const commandArgs = {
  reload: empty,
  get_settings: empty,
  set_settings: z.strictObject({
    values: PreferencesPatchSchema,
    persist: z.boolean().default(false),
  }),
  get_available_models: empty,
  cycle_model: z.strictObject({
    direction: z.union([z.literal(1), z.literal(-1)]).default(1),
  }),
  cycle_thinking: z.strictObject({
    direction: z.union([z.literal(1), z.literal(-1)]).default(1),
  }),
  set_auto_compaction: z.strictObject({ enabled: z.boolean() }),
  set_auto_retry: z.strictObject({ enabled: z.boolean() }),
  abort_retry: empty,
  prompt: promptInput.safeExtend({
    delivery: z.enum(["steer", "follow_up"]).optional(),
  }),
  steer: promptInput,
  follow_up: promptInput,
  get_queue: empty,
  get_queue_modes: empty,
  set_queue_mode: z.strictObject({
    kind: z.enum(["steer", "follow_up"]),
    mode: z.enum(["all", "one-at-a-time"]),
  }),
  clear_queue: empty,
  abort: z
    .strictObject({
      scope: z.enum(["run", "session", "task"]).default("run"),
      taskId: id.optional(),
    })
    .refine(
      (a) => a.scope !== "task" || !!a.taskId,
      "task scope requires taskId",
    ),
  get_state: empty,
  get_commands: empty,
  get_messages: empty,
  get_entries: empty,
  get_tree: empty,
  new_session: z.strictObject({
    cwd: text.optional(),
    persist: z.boolean().optional(),
  }),
  switch_session: RpcSessionRestorationArgsSchema,
  resume_session: RpcSessionRestorationArgsSchema,
  name_session: z.strictObject({ name: text.min(1).max(512) }),
  set_metadata: z.strictObject({
    name: text.max(512).optional(),
    tags: z.array(z.string().max(128)).max(64).optional(),
    archived: z.boolean().optional(),
  }),
  navigate: z.strictObject({
    entryId: id.nullable(),
    summary: text.optional(),
  }),
  label: z.strictObject({ entryId: id, label: text.max(512).nullable() }),
  fork: z.strictObject({ entryId: id }),
  clone: empty,
  import_session: z.strictObject({ data: text, cwd: text.optional() }),
  export_session: RpcExportBeginSchema,
  export_session_begin: RpcExportBeginSchema,
  import_session_begin: RpcImportBeginSchema,
  read_transfer_chunk: RpcTransferReadSchema,
  write_transfer_chunk: RpcTransferWriteSchema,
  finish_transfer: RpcTransferBindingSchema,
  cancel_transfer: RpcTransferBindingSchema,
  get_model: empty,
  set_model: z.strictObject({ provider: id.optional(), model: id }),
  get_thinking: empty,
  set_thinking: z.strictObject({
    level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
  compact: z.strictObject({ instructions: text.optional() }),
  bash: z.strictObject({
    command: text.min(1),
    excludeFromContext: z.boolean().default(false),
  }),
  get_stats: empty,
  get_retry_state: empty,
  get_code_mode: empty,
  stop_code_mode: empty,
  get_warming_state: empty,
  stop_warming: empty,
  resume_warming: empty,
  get_tasks: empty,
  stop_task: z.strictObject({ taskId: id }),
  get_workflows: empty,
  stop_workflow: z.strictObject({ runId: id }),
  get_mcp: empty,
  mcp_resources: page,
  mcp_templates: page,
  mcp_read: z.strictObject({ server: id, uri: text.min(1) }),
  mcp_register: z.strictObject({ config: jsonObject }),
  mcp_unregister: server,
  mcp_connect: server,
  mcp_disconnect: server,
  mcp_login: z.strictObject({ server: id, callbackUrl: z.url().optional() }),
  mcp_logout: server,
  mcp_exposure: z.strictObject({
    server: id,
    tool: text.optional(),
    exposure: z.enum(["direct", "deferred", "codemode", "hidden"]).optional(),
  }),
  diagnostics: z.strictObject({
    includeTranscript: z.boolean().default(false),
  }),
  interaction_response: z.strictObject({
    interactionId: id,
    sessionId: id,
    response: z.json(),
  }),
} satisfies Record<(typeof RPC_COMMANDS)[number], z.ZodType>;

export const RpcRequestSchema = z.strictObject({
  version: z.literal(RPC_VERSION),
  type: z.literal("request"),
  commandId: id,
  command: z.enum(RPC_COMMANDS),
  args: jsonObject.default({}),
});

export type RpcCommand = (typeof RPC_COMMANDS)[number];
export interface RpcRequest {
  version: typeof RPC_VERSION;
  type: "request";
  commandId: string;
  command: RpcCommand;
  args: Record<string, unknown>;
}

export function parseRpcRequest(value: unknown): RpcRequest {
  const envelope = RpcRequestSchema.parse(value);
  const args = commandArgs[envelope.command].parse(envelope.args);
  return { ...envelope, args };
}

export const RpcMessageSchema = z.union([
  z.strictObject({
    version: z.literal(RPC_VERSION),
    type: z.literal("response"),
    commandId: id.nullable(),
    success: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    version: z.literal(RPC_VERSION),
    type: z.literal("response"),
    commandId: id.nullable(),
    success: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "invalid_request",
        "unsupported_command",
        "busy",
        "execution_failed",
        "stale_interaction",
        "result_too_large",
      ]),
      message: z.string(),
    }),
  }),
  z.strictObject({
    version: z.literal(RPC_VERSION),
    type: z.literal("event"),
    sequence: z.number().int().positive(),
    sessionId: id,
    event: z.unknown(),
    commandId: id.optional(),
  }),
  z.strictObject({
    version: z.literal(RPC_VERSION),
    type: z.literal("interaction"),
    interactionId: id,
    sessionId: id,
    kind: z.string(),
    expiresAt: z.number(),
    payload: z.unknown(),
  }),
]);

export interface RpcError {
  code:
    | "invalid_request"
    | "unsupported_command"
    | "busy"
    | "execution_failed"
    | "stale_interaction"
    | "result_too_large";
  message: string;
}

export type RpcMessage =
  | {
      version: typeof RPC_VERSION;
      type: "response";
      commandId: string | null;
      success: true;
      result: unknown;
    }
  | {
      version: typeof RPC_VERSION;
      type: "response";
      commandId: string | null;
      success: false;
      error: RpcError;
    }
  | {
      version: typeof RPC_VERSION;
      type: "event";
      sequence: number;
      sessionId: string;
      event: unknown;
      commandId?: string;
    }
  | {
      version: typeof RPC_VERSION;
      type: "interaction";
      interactionId: string;
      sessionId: string;
      kind: string;
      expiresAt: number;
      payload: unknown;
    };
