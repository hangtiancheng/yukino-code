import type { AgentControl } from "@shared/agent-types";
import {
  MCPExposureSchema,
  MCPServerConfigSchema,
  PreferencesPatchSchema,
  SessionMetadataSchema,
  workflowInputSchema,
} from "@yukino.js/yukino";
import { z } from "zod";

const identifier = z.string().min(1).max(4096);
export const AgentControlSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum([
      "reload",
      "clone",
      "abort_retry",
      "stop_code",
      "revoke_trust",
    ]),
  }),
  z.strictObject({
    type: z.literal("settings"),
    patch: PreferencesPatchSchema,
    persist: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("metadata"),
    metadata: SessionMetadataSchema,
  }),
  z.strictObject({
    type: z.literal("label"),
    entryId: identifier,
    label: z.string().max(4096).nullable(),
  }),
  z.strictObject({
    type: z.literal("navigate"),
    entryId: identifier.nullable(),
    summary: z.union([z.boolean(), z.string().max(32768)]).optional(),
  }),
  z.strictObject({ type: z.literal("fork"), entryId: identifier }),
  z.strictObject({
    type: z.literal("compact"),
    instructions: z.string().max(32768).optional(),
  }),
  z.strictObject({
    type: z.literal("clear_queue"),
    kind: z.enum(["steer", "followUp"]).optional(),
  }),
  z.strictObject({
    type: z.literal("queue_mode"),
    kind: z.enum(["steer", "followUp"]),
    mode: z.enum(["all", "one-at-a-time"]),
  }),
  z.strictObject({
    type: z.enum(["auto_retry", "auto_compaction", "warming"]),
    enabled: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("abort"),
    scope: z.enum(["foreground", "background", "queue", "all"]),
  }),
  z.strictObject({
    type: z.enum(["cycle_model", "cycle_thinking"]),
    direction: z.union([z.literal(1), z.literal(-1)]),
  }),
  z.strictObject({
    type: z.literal("mcp_register"),
    config: MCPServerConfigSchema,
  }),
  z.strictObject({
    type: z.enum([
      "mcp_connect",
      "mcp_disconnect",
      "mcp_remove",
      "mcp_logout",
      "mcp_login",
    ]),
    server: identifier,
  }),
  z.strictObject({
    type: z.literal("mcp_reload"),
    server: identifier,
    config: MCPServerConfigSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("mcp_exposure"),
    server: identifier,
    exposure: MCPExposureSchema,
    rules: MCPServerConfigSchema.shape.tool_exposure,
  }),
  z.strictObject({
    type: z.literal("mcp_resources"),
    server: identifier,
    templates: z.boolean().optional(),
    cursor: z.string().max(32768).optional(),
  }),
  z.strictObject({
    type: z.literal("mcp_read"),
    server: identifier,
    uri: z.string().min(1).max(32768),
  }),
  z.strictObject({ type: z.literal("workflow_stop"), id: identifier }),
  z.strictObject({
    type: z.literal("workflow_run"),
    input: workflowInputSchema,
  }),
  z.strictObject({
    type: z.literal("workflow_stop_agent"),
    id: identifier,
    agentId: z.int().positive(),
  }),
]) satisfies z.ZodType<AgentControl>;
