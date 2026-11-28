import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  readSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import {
  CODE_MODE_RECORD,
  CODE_MODE_RECOVERY_RECORD,
} from "@/code-mode/constants.js";
import { buildCompactionSummaryMessage } from "@/compact/prompts.js";
import { THINKING_LEVELS } from "@/config/constants.js";
import type {
  Message,
  ThinkingBlock,
  ToolResultBlock,
  UserBashResult,
} from "@/conversation/index.js";
import { UserInputSchema, type UserInput } from "@/history/index.js";
import {
  ARTIFACT_ID_RE,
  ARTIFACT_URI_PREFIX,
  ARTIFACT_URI_RE,
  BASE64_RE,
  BRANCH_SUMMARY,
  BRANCH_SUMMARY_MAX_DESCRIPTION_CHARS,
  BRANCH_SUMMARY_MAX_OUTPUT_CHARS,
  COMPACT_BOUNDARY,
  INVALID_SESSION_RECORD,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES,
  MAX_ARTIFACTS,
  MAX_JSON_DEPTH,
  MAX_JSON_REFERENCES,
  MAX_METADATA_TEXT,
  MAX_SESSION_BYTES,
  MAX_SESSION_RECORD_BYTES,
  MAX_SESSION_STREAM_BYTES,
  MAX_SESSION_STRING_BYTES,
  SESSION_TRANSPORT_CHUNK_BYTES,
  SESSION_TRANSPORT_TEXT_CHARS,
  MAX_SESSION_DEPTH,
  MAX_SESSION_RECORDS,
  MAX_SESSION_TAGS,
  MAX_SESSION_TIMESTAMP,
  MAX_SESSION_RUNTIME_IDENTIFIER_CHARS,
  MAX_SESSION_RUNTIME_TOOLS,
  SESSION_RUNTIME_STATE,
  SESSION_RUNTIME_IDENTIFIER_RE,
  SESSION_RUNTIME_CREDENTIAL_RE,
  MIME_TYPE_RE,
  SESSION_CONFLICT,
  SESSION_FILE_EXTENSION,
  SESSION_APPEND_ROLLBACK_ERROR,
  INVALID_TOOL_ARTIFACT,
  SESSION_FORMAT,
  SESSION_VERSION,
  SHA256_RE,
  UNSAFE_SESSION_KEYS,
  UNSUPPORTED_SESSION_FORMAT,
} from "@/session/constants.js";
import {
  FileOperationsSchema,
  type FileOperations,
} from "@/session/file-operations.js";
import { buildBranchSummaryReminder } from "@/session/prompts.js";
import {
  INVALID_SESSION_ID_ERROR,
  SESSION_ID_RE,
} from "@/storage/constants.js";
import { writeAllSync } from "@/storage/file-io.js";
import { getSessionsDir, sessionPath } from "@/storage/index.js";
import { mkdirPrivateSync, openPrivateFileSync } from "@/storage/private.js";
import { withFileSyncLock } from "@/teams/file-lock.js";
import {
  normalizeToolResultContentBlock,
  type ToolResultContentBlock,
} from "@/tools/types.js";

export const ToolUseRecordSchema = z.strictObject({
  tool_use_id: z.string().min(1),
  tool_name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  provider_item_id: z.string().optional(),
});
export type ToolUseRecord = z.infer<typeof ToolUseRecordSchema>;
const ContentSchema = z.union([
  z.string(),
  z.array(z.record(z.string(), z.unknown())),
]);
export const ToolArtifactSchema = z.strictObject({
  id: z.string().min(1).max(MAX_METADATA_TEXT),
  path: z.string().min(1).optional(),
  mimeType: z.string().regex(MIME_TYPE_RE).optional(),
  size: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES).optional(),
  hash: z.string().regex(SHA256_RE).optional(),
});
export type SessionToolArtifact = z.infer<typeof ToolArtifactSchema>;
export const ToolArtifactPayloadSchema = z.strictObject({
  output: z.string(),
  contentBlocks: z.array(z.unknown()).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  rawContent: z.array(z.unknown()).optional(),
});
export function readToolArtifactPayload(
  artifact: SessionArtifact,
): z.infer<typeof ToolArtifactPayloadSchema> {
  const bytes = decodeArtifact(artifact);
  if (artifact.mimeType !== "application/json") {
    return { output: bytes.toString("utf8") };
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  assertBoundedJson(value);
  return ToolArtifactPayloadSchema.parse(value);
}
export const ToolResultRecordSchema = z.strictObject({
  tool_use_id: z.string().min(1),
  content: z.string(),
  content_blocks: z.array(z.unknown()).optional(),
  structured_content: z.record(z.string(), z.unknown()).optional(),
  raw_content: z.array(z.unknown()).optional(),
  artifact: ToolArtifactSchema.optional(),
  is_error: z.boolean().optional(),
});
export type ToolResultRecord = z.infer<typeof ToolResultRecordSchema>;
const ThinkingBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string(),
  }),
  z.strictObject({ type: z.literal("redacted_thinking"), data: z.string() }),
]);
const UserBashResultSchema = z.strictObject({
  command: z.string(),
  output: z.string(),
  isError: z.boolean(),
  elapsed: z.number().nonnegative().max(MAX_SESSION_TIMESTAMP),
  status: z.enum(["completed", "failed", "stopped"]),
  excludeFromContext: z.boolean(),
});
export const KeptMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant", "system"]),
  content: ContentSchema,
  tool_uses: z.array(ToolUseRecordSchema).optional(),
  tool_results: z.array(ToolResultRecordSchema).optional(),
  thinking_blocks: z.array(ThinkingBlockSchema).optional(),
  user_bash: UserBashResultSchema.optional(),
  user_input: UserInputSchema.optional(),
  file_operations: FileOperationsSchema.optional(),
});
export type KeptMessage = z.infer<typeof KeptMessageSchema>;
const RuntimeIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_RUNTIME_IDENTIFIER_CHARS)
  .regex(SESSION_RUNTIME_IDENTIFIER_RE)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !UNSAFE_SESSION_KEYS.has(value) &&
      !SESSION_RUNTIME_CREDENTIAL_RE.test(value),
  );
export const SessionToolDeclarationSchema = z.strictObject({
  name: RuntimeIdentifierSchema,
  schemaFingerprint: z.string().regex(SHA256_RE),
  sourceFingerprint: z.string().regex(SHA256_RE),
});
export type SessionToolDeclaration = z.infer<
  typeof SessionToolDeclarationSchema
>;
export const SessionToolDeclarationsSchema = z
  .array(SessionToolDeclarationSchema)
  .max(MAX_SESSION_RUNTIME_TOOLS)
  .refine(
    (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
  );
export const SessionRuntimeStateSchema = z.preprocess(
  (value) => {
    assertBoundedJson(value);
    return value;
  },
  z
    .strictObject({
      provider: z.strictObject({
        name: RuntimeIdentifierSchema,
        protocol: z.enum(["anthropic", "openai", "openai-compat"]),
        model: RuntimeIdentifierSchema,
        endpointFingerprint: z.string().regex(SHA256_RE),
      }),
      thinking: z.enum(THINKING_LEVELS),
      tools: SessionToolDeclarationsSchema,
      discovered: z
        .array(RuntimeIdentifierSchema)
        .max(MAX_SESSION_RUNTIME_TOOLS),
    })
    .refine((state) => {
      const names = new Set(state.tools.map((tool) => tool.name));
      return (
        new Set(state.discovered).size === state.discovered.length &&
        state.discovered.every((name) => names.has(name))
      );
    }),
);
export type SessionRuntimeState = z.infer<typeof SessionRuntimeStateSchema>;
export const SessionMessageSchema = KeptMessageSchema.extend({
  timestamp: z.number().nonnegative().max(MAX_SESSION_TIMESTAMP),
  type: z.string().min(1).optional(),
  state: SessionRuntimeStateSchema.optional(),
  cost: z.record(z.string(), z.unknown()).optional(),
  historical: z.boolean().optional(),
}).superRefine((message, context) => {
  if (message.type === SESSION_RUNTIME_STATE) {
    if (
      message.role !== "system" ||
      message.content !== "" ||
      message.state === undefined ||
      Object.keys(message).some(
        (key) =>
          ![
            "role",
            "content",
            "timestamp",
            "type",
            "state",
            "historical",
          ].includes(key),
      )
    ) {
      context.addIssue({ code: "custom", message: INVALID_SESSION_RECORD });
    }
  } else if (message.state !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: INVALID_SESSION_RECORD,
    });
  }
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export const CompactBoundaryPayloadSchema = z.strictObject({
  summary: z.string().refine((text) => text.trim().length > 0),
  keep: z.array(KeptMessageSchema),
  details: FileOperationsSchema.optional(),
});
export type CompactBoundaryPayload = z.infer<
  typeof CompactBoundaryPayloadSchema
>;
export const SessionMetadataSchema = z.strictObject({
  name: z.string().max(MAX_METADATA_TEXT).optional(),
  tags: z
    .array(z.string().min(1).max(MAX_METADATA_TEXT))
    .max(MAX_SESSION_TAGS)
    .optional(),
  archived: z.boolean().optional(),
});
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;
const IdentitySchema = z.string().regex(ARTIFACT_ID_RE);
const EntryProvenanceSchema = z.strictObject({
  sessionId: IdentitySchema,
  entryId: IdentitySchema,
});
export const BranchSummaryPayloadSchema = z.strictObject({
  details: FileOperationsSchema.optional(),
  summary: z
    .string()
    .max(BRANCH_SUMMARY_MAX_OUTPUT_CHARS)
    .refine((text) => text.trim().length > 0),
  sourceSessionId: IdentitySchema,
  fromEntryId: IdentitySchema.nullable(),
  commonAncestorId: IdentitySchema.nullable(),
  targetEntryId: IdentitySchema.nullable(),
  targetLeafId: IdentitySchema.nullable(),
  sourcePathEntryIds: z.array(IdentitySchema).max(MAX_SESSION_DEPTH),
  targetPathEntryIds: z.array(IdentitySchema).max(MAX_SESSION_DEPTH),
  description: z.string().max(BRANCH_SUMMARY_MAX_DESCRIPTION_CHARS).optional(),
});
export type BranchSummaryPayload = z.infer<typeof BranchSummaryPayloadSchema>;
export function branchSummaryPayload(
  message: Pick<SessionMessage, "role" | "content">,
): BranchSummaryPayload {
  if (message.role !== "system" || typeof message.content !== "string") {
    throw new Error(INVALID_SESSION_RECORD);
  }
  const raw: unknown = JSON.parse(message.content);
  assertBoundedJson(raw);
  return BranchSummaryPayloadSchema.parse(raw);
}
const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const SessionHeaderSchema = z.strictObject({
  type: z.literal("session_header"),
  format: z.literal(SESSION_FORMAT),
  version: z.literal(SESSION_VERSION),
  sessionId: IdentitySchema,
  createdAt: z.number().nonnegative().max(MAX_SESSION_TIMESTAMP),
  revision: z.literal(0),
  provenance: z
    .strictObject({
      operation: z.enum(["fork", "clone", "import"]),
      sessionId: IdentitySchema,
      leafId: IdentitySchema.nullable(),
    })
    .optional(),
});
export type SessionHeader = z.infer<typeof SessionHeaderSchema>;
export const SessionEntrySchema = z.strictObject({
  type: z.literal("message"),
  entryId: IdentitySchema,
  parentId: IdentitySchema.nullable(),
  timestamp: z.number().nonnegative().max(MAX_SESSION_TIMESTAMP),
  revision: RevisionSchema,
  message: SessionMessageSchema,
  provenance: EntryProvenanceSchema.optional(),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;
export const ArtifactRecordSchema = z.strictObject({
  type: z.literal("artifact"),
  revision: RevisionSchema,
  artifactId: IdentitySchema,
  mimeType: z.string().regex(MIME_TYPE_RE),
  length: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  sha256: z.string().regex(SHA256_RE),
  data: z.string().max(Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4),
  provenance: z
    .strictObject({ sessionId: IdentitySchema, artifactId: IdentitySchema })
    .optional(),
});
export type SessionArtifact = z.infer<typeof ArtifactRecordSchema>;
export const SessionRecordSchema = z.discriminatedUnion("type", [
  SessionEntrySchema,
  z.strictObject({
    type: z.literal("active_leaf"),
    revision: RevisionSchema,
    leafId: IdentitySchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("metadata"),
    revision: RevisionSchema,
    metadata: SessionMetadataSchema,
  }),
  z.strictObject({
    type: z.literal("label"),
    revision: RevisionSchema,
    entryId: IdentitySchema,
    label: z.string().min(1).max(MAX_METADATA_TEXT).nullable(),
  }),
  ArtifactRecordSchema,
]);
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export interface SessionDocument {
  header: SessionHeader;
  records: SessionRecord[];
  entries: SessionEntry[];
  leafId: string | null;
  revision: number;
  metadata: SessionMetadata;
  labels: Map<string, string>;
  artifacts: Map<string, SessionArtifact>;
}
export interface SessionTreeNode {
  entry: SessionEntry;
  label?: string;
  children: SessionTreeNode[];
}
export interface RestoredMessage {
  role: "user" | "assistant";
  content: string | Record<string, unknown>[];
  toolUses?: {
    toolUseId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    providerItemId?: string;
  }[];
  toolResults?: ToolResultBlock[];
  thinkingBlocks?: ThinkingBlock[];
  userBash?: UserBashResult;
  userInput?: UserInput;
  fileOperations?: FileOperations;
}
export class SessionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(SESSION_CONFLICT);
    this.name = "SessionConflictError";
  }
}

export function getSessionArtifactsDir(sessionId: string): string {
  return sessionPath(sessionId);
}
export function getSessionFilePath(cwd: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(INVALID_SESSION_ID_ERROR);
  }
  return join(getSessionsDir(cwd), sessionId + SESSION_FILE_EXTENSION);
}
export function newSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}
export function createSessionHeader(sessionId = newSessionId()): SessionHeader {
  return SessionHeaderSchema.parse({
    type: "session_header",
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    sessionId,
    createdAt: Date.now(),
    revision: 0,
  });
}

/** Bound unknown JSON before recursive schema validation or transformations. */
export function assertBoundedJson(
  value: unknown,
  prototypeDataKeys = false,
): void {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [
    { value, depth: 0 },
  ];
  let references = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) {
      break;
    }
    if (item.exit) {
      if (item.value !== null && typeof item.value === "object") {
        ancestors.delete(item.value);
      }
      continue;
    }
    if (++references > MAX_JSON_REFERENCES || item.depth > MAX_JSON_DEPTH) {
      throw new Error(`${INVALID_SESSION_RECORD}: JSON limits exceeded.`);
    }
    if (typeof item.value === "string") {
      bytes += Buffer.byteLength(item.value);
      if (bytes > MAX_SESSION_BYTES) {
        throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
      }
      continue;
    }
    if (item.value === null || typeof item.value === "boolean") {
      continue;
    }
    if (typeof item.value === "number" && Number.isFinite(item.value)) {
      continue;
    }
    if (typeof item.value !== "object" || ancestors.has(item.value)) {
      throw new Error(`${INVALID_SESSION_RECORD}: non-JSON or cyclic value.`);
    }
    if (
      !Array.isArray(item.value) &&
      Object.getPrototypeOf(item.value) !== Object.prototype &&
      Object.getPrototypeOf(item.value) !== null
    ) {
      throw new Error(`${INVALID_SESSION_RECORD}: non-JSON object.`);
    }
    if (
      Array.isArray(item.value) &&
      (item.value.length > MAX_JSON_REFERENCES ||
        Object.keys(item.value).length !== item.value.length)
    ) {
      throw new Error(
        `${INVALID_SESSION_RECORD}: invalid array or JSON limits exceeded.`,
      );
    }
    ancestors.add(item.value);
    stack.push({ value: item.value, depth: item.depth, exit: true });
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(item.value),
    )) {
      if (!prototypeDataKeys && UNSAFE_SESSION_KEYS.has(key)) {
        throw new Error(`${INVALID_SESSION_RECORD}: unsafe JSON key.`);
      }
      if (!("value" in descriptor)) {
        throw new Error(
          `${INVALID_SESSION_RECORD}: JSON accessors are not allowed.`,
        );
      }
      if (key === "toJSON" && typeof descriptor.value === "function") {
        throw new Error(
          `${INVALID_SESSION_RECORD}: JSON serializers are not allowed.`,
        );
      }
      if (!descriptor.enumerable) {
        continue;
      }
      bytes += Buffer.byteLength(key);
      if (bytes > MAX_SESSION_BYTES) {
        throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
      }
      const child: unknown = descriptor.value;
      if (child === undefined && Array.isArray(item.value)) {
        throw new Error(`${INVALID_SESSION_RECORD}: non-JSON array item.`);
      }
      if (child !== undefined) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}
export function readStructuredPayload(
  message: Pick<SessionMessage, "role" | "type" | "content">,
): { value: unknown } | undefined {
  if (
    message.role !== "system" ||
    !message.type ||
    typeof message.content !== "string"
  ) {
    return undefined;
  }
  // Summary provenance is opaque source-session data, never an internal ID to remap or hydrate.
  if (message.type === BRANCH_SUMMARY) {
    return undefined;
  }
  let payload: { value: unknown };
  try {
    payload = { value: JSON.parse(message.content) };
  } catch {
    return undefined;
  }
  assertBoundedJson(
    payload.value,
    message.type === CODE_MODE_RECORD ||
      message.type === CODE_MODE_RECOVERY_RECORD,
  );
  return payload;
}
export function requireReference<T>(
  map: ReadonlyMap<string, T>,
  id: string,
): T {
  const value = map.get(id);
  if (value === undefined) {
    throw new Error(`${INVALID_SESSION_RECORD}: unknown reference ${id}.`);
  }
  return value;
}
export function decodeInlineBase64(data: string): Buffer {
  if (
    data.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4 ||
    !BASE64_RE.test(data)
  ) {
    throw new Error(`${INVALID_SESSION_RECORD}: invalid artifact base64/size.`);
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_ARTIFACT_BYTES || bytes.toString("base64") !== data) {
    throw new Error(
      `${INVALID_SESSION_RECORD}: invalid artifact base64/length.`,
    );
  }
  return bytes;
}
export function decodeArtifact(
  artifact: Pick<SessionArtifact, "data" | "length" | "sha256">,
): Buffer {
  const bytes = decodeInlineBase64(artifact.data);
  if (
    bytes.length !== artifact.length ||
    bytes.toString("base64") !== artifact.data ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
  ) {
    throw new Error(
      `${INVALID_SESSION_RECORD}: artifact length/hash mismatch.`,
    );
  }
  return bytes;
}
export function makeArtifact(
  bytes: Uint8Array,
  mimeType: string,
  revision: number,
): SessionArtifact {
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`${INVALID_SESSION_RECORD}: artifact size limit exceeded.`);
  }
  return ArtifactRecordSchema.parse({
    type: "artifact",
    artifactId: randomUUID(),
    revision,
    mimeType,
    length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data: Buffer.from(bytes).toString("base64"),
  });
}

interface ToolPathState {
  pending: Set<string>;
  seen: Set<string>;
  depth: number;
}
function advanceTools(
  message: KeptMessage & { type?: string },
  previous: ToolPathState,
): ToolPathState {
  const uses = message.tool_uses ?? [];
  const results = message.tool_results ?? [];
  const state = {
    pending:
      uses.length ||
      results.length ||
      message.type === CODE_MODE_RECOVERY_RECORD
        ? new Set(previous.pending)
        : previous.pending,
    seen: uses.length ? new Set(previous.seen) : previous.seen,
    depth: previous.depth + 1,
  };
  if (state.depth > MAX_SESSION_DEPTH) {
    throw new Error(`${INVALID_SESSION_RECORD}: tree depth exceeded.`);
  }
  if (
    (uses.length > 0 && message.role !== "assistant") ||
    (results.length > 0 && message.role !== "user") ||
    (message.thinking_blocks?.length && message.role !== "assistant") ||
    (message.user_input && message.role !== "user")
  ) {
    throw new Error(`${INVALID_SESSION_RECORD}: invalid tool/message role.`);
  }
  if (
    message.user_bash &&
    (message.role !== "user" ||
      uses.length ||
      results.length ||
      message.user_input)
  ) {
    throw new Error(
      `${INVALID_SESSION_RECORD}: shell transcript cannot carry tool or input blocks.`,
    );
  }
  if (message.user_bash?.excludeFromContext) {
    return state;
  }
  if (message.type === COMPACT_BOUNDARY) {
    if (state.pending.size) {
      throw new Error(
        `${INVALID_SESSION_RECORD}: compaction splits a tool batch.`,
      );
    }
    const payload = compactPayload(message);
    let kept: ToolPathState = { pending: new Set(), seen: new Set(), depth: 0 };
    for (const record of payload.keep) {
      kept = advanceTools(record, kept);
    }
    if (kept.pending.size) {
      throw new Error(
        `${INVALID_SESSION_RECORD}: incomplete compacted tool batch.`,
      );
    }
    return state;
  }
  if (message.type === CODE_MODE_RECOVERY_RECORD) {
    const { id } = recoveryPayload(message);
    if (!state.pending.delete(id)) {
      throw new Error(`${INVALID_SESSION_RECORD}: orphaned tool recovery.`);
    }
    return state;
  }
  if (message.role === "system") {
    if (uses.length || results.length) {
      throw new Error(`${INVALID_SESSION_RECORD}: system tool block.`);
    }
    return state;
  }
  if (uses.length > 0) {
    if (state.pending.size) {
      throw new Error(`${INVALID_SESSION_RECORD}: overlapping tool batches.`);
    }
    for (const use of uses) {
      if (state.seen.has(use.tool_use_id)) {
        throw new Error(`${INVALID_SESSION_RECORD}: duplicate tool call.`);
      }
      state.seen.add(use.tool_use_id);
      state.pending.add(use.tool_use_id);
    }
  } else if (results.length > 0) {
    for (const result of results) {
      if (!state.pending.delete(result.tool_use_id)) {
        throw new Error(
          `${INVALID_SESSION_RECORD}: orphaned or duplicate tool result.`,
        );
      }
    }
  } else if (
    state.pending.size &&
    (message.content.length ||
      message.user_bash ||
      message.user_input ||
      message.thinking_blocks?.length)
  ) {
    throw new Error(`${INVALID_SESSION_RECORD}: message splits a tool batch.`);
  }
  return state;
}
function compactPayload(message: KeptMessage): CompactBoundaryPayload {
  if (typeof message.content !== "string" || message.role !== "system") {
    throw new Error(`${INVALID_SESSION_RECORD}: invalid compaction.`);
  }
  const value: unknown = JSON.parse(message.content);
  assertBoundedJson(value);
  return CompactBoundaryPayloadSchema.parse(value);
}
export const RecoveryPayloadSchema = z.strictObject({
  id: z.string().min(1),
  result: z.strictObject({
    output: z.string(),
    isError: z.boolean(),
    contentBlocks: z.array(z.unknown()).optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    rawContent: z.array(z.unknown()).optional(),
    artifact: ToolArtifactSchema.optional(),
  }),
});
function recoveryPayload(message: KeptMessage) {
  if (typeof message.content !== "string" || message.role !== "system") {
    throw new Error(`${INVALID_SESSION_RECORD}: invalid recovery.`);
  }
  const raw: unknown = JSON.parse(message.content);
  assertBoundedJson(raw);
  return RecoveryPayloadSchema.parse(raw);
}

export function validateDocument(
  header: SessionHeader,
  records: SessionRecord[],
  options: { completeTools?: boolean } = {},
): SessionDocument {
  if (records.length + 1 > MAX_SESSION_RECORDS) {
    throw new Error(`${INVALID_SESSION_RECORD}: record limit exceeded.`);
  }
  assertBoundedJson(header);
  const document: SessionDocument = {
    header: SessionHeaderSchema.parse(header),
    records: [],
    entries: [],
    leafId: null,
    revision: 0,
    metadata: {},
    labels: new Map(),
    artifacts: new Map(),
  };
  const states = new Map<string, ToolPathState>();
  const children = new Set<string>();
  const empty: ToolPathState = {
    pending: new Set(),
    seen: new Set(),
    depth: 0,
  };
  let artifactBytes = 0;
  for (const raw of records) {
    assertBoundedJson(raw);
    const record = SessionRecordSchema.parse(raw);
    if (record.revision !== document.revision + 1) {
      throw new Error(`${INVALID_SESSION_RECORD}: non-contiguous revision.`);
    }
    document.revision = record.revision;
    document.records.push(record);
    switch (record.type) {
      case "message": {
        if (states.has(record.entryId)) {
          throw new Error(`${INVALID_SESSION_RECORD}: duplicate entry ID.`);
        }
        if (record.parentId !== null && !states.has(record.parentId)) {
          throw new Error(
            `${INVALID_SESSION_RECORD}: missing/forward/cyclic parent.`,
          );
        }
        const previous =
          record.parentId === null
            ? empty
            : requireReference(states, record.parentId);
        states.set(record.entryId, advanceTools(record.message, previous));
        if (record.parentId !== null) {
          children.add(record.parentId);
        }
        validateRichContent(record.message);
        if (record.message.type === BRANCH_SUMMARY) {
          const payload = branchSummaryPayload(record.message);
          if (payload.sourceSessionId === document.header.sessionId) {
            const target = getEntryPath(document, payload.targetLeafId);
            if (
              record.parentId !== payload.targetLeafId ||
              JSON.stringify(payload.targetPathEntryIds) !==
                JSON.stringify(target.map((entry) => entry.entryId)) ||
              (payload.commonAncestorId !== null &&
                !target.some(
                  (entry) => entry.entryId === payload.commonAncestorId,
                ))
            ) {
              throw new Error(
                `${INVALID_SESSION_RECORD}: invalid branch summary provenance.`,
              );
            }
            // Active-path exports intentionally omit the abandoned branch while retaining its provenance.
            if (
              payload.fromEntryId === null ||
              document.entries.some(
                (entry) => entry.entryId === payload.fromEntryId,
              )
            ) {
              const source = getEntryPath(document, payload.fromEntryId);
              let common = 0;
              while (
                common < source.length &&
                common < target.length &&
                source[common].entryId === target[common].entryId
              ) {
                common++;
              }
              if (
                payload.commonAncestorId !==
                  (source[common - 1]?.entryId ?? null) ||
                JSON.stringify(payload.sourcePathEntryIds) !==
                  JSON.stringify(
                    source.slice(common).map((entry) => entry.entryId),
                  )
              ) {
                throw new Error(
                  `${INVALID_SESSION_RECORD}: invalid branch summary provenance.`,
                );
              }
            }
          }
        }
        document.entries.push(record);
        break;
      }
      case "active_leaf": {
        if (record.leafId !== null && !states.has(record.leafId)) {
          throw new Error(`${INVALID_SESSION_RECORD}: unknown active leaf.`);
        }
        const previous = document.records.at(-2);
        if (
          record.leafId !== null &&
          requireReference(states, record.leafId).pending.size &&
          (previous?.type !== "message" || previous.entryId !== record.leafId)
        ) {
          throw new Error(
            `${INVALID_SESSION_RECORD}: active leaf splits a tool batch.`,
          );
        }
        document.leafId = record.leafId;
        break;
      }
      case "metadata":
        document.metadata = { ...document.metadata, ...record.metadata };
        break;
      case "label":
        if (!states.has(record.entryId)) {
          throw new Error(`${INVALID_SESSION_RECORD}: unknown label entry.`);
        }
        if (record.label === null) {
          document.labels.delete(record.entryId);
        } else {
          document.labels.set(record.entryId, record.label);
        }
        break;
      case "artifact":
        if (document.artifacts.has(record.artifactId)) {
          throw new Error(`${INVALID_SESSION_RECORD}: duplicate artifact ID.`);
        }
        decodeArtifact(record);
        artifactBytes += record.length;
        if (
          artifactBytes > MAX_ARTIFACT_TOTAL_BYTES ||
          document.artifacts.size >= MAX_ARTIFACTS
        ) {
          throw new Error(
            `${INVALID_SESSION_RECORD}: artifact budget exceeded.`,
          );
        }
        document.artifacts.set(record.artifactId, record);
        break;
    }
  }
  if (
    document.entries.length > 0 &&
    !document.records.some((record) => record.type === "active_leaf")
  ) {
    throw new Error(`${INVALID_SESSION_RECORD}: missing active leaf control.`);
  }
  const referenceBudget = { bytes: 0, references: 0 };
  for (const entry of document.entries) {
    validateArtifactReferences(
      entry.message,
      document.artifacts,
      referenceBudget,
    );
    validateRichContent(hydrateMessage(entry.message, document.artifacts));
  }
  if (options.completeTools) {
    for (const [id, state] of states) {
      if ((!children.has(id) || id === document.leafId) && state.pending.size) {
        throw new Error(`${INVALID_SESSION_RECORD}: incomplete tool batch.`);
      }
    }
  }
  countSessionDocumentBytes(document);
  return document;
}
function validateRichContent(message: SessionMessage): void {
  const payload = readStructuredPayload(message);
  visitJson(payload ? [message, payload.value] : message, (value) => {
    if (
      value &&
      typeof value === "object" &&
      "mimeType" in value &&
      typeof value.mimeType === "string"
    ) {
      if (!MIME_TYPE_RE.test(value.mimeType)) {
        throw new Error(
          `${INVALID_SESSION_RECORD}: invalid artifact MIME type.`,
        );
      }
      if ("data" in value && typeof value.data === "string") {
        decodeInlineBase64(value.data);
      }
      if ("blob" in value && typeof value.blob === "string") {
        decodeInlineBase64(value.blob);
      }
    }
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      (value.type === "image" || value.type === "document") &&
      "source" in value &&
      value.source &&
      typeof value.source === "object"
    ) {
      const source = value.source;
      if ("type" in source && source.type === "base64") {
        if (!("data" in source) || typeof source.data !== "string") {
          throw new Error(
            `${INVALID_SESSION_RECORD}: invalid inline artifact base64.`,
          );
        }
        decodeInlineBase64(source.data);
        if (
          !("media_type" in source) ||
          typeof source.media_type !== "string" ||
          !MIME_TYPE_RE.test(source.media_type)
        ) {
          throw new Error(
            `${INVALID_SESSION_RECORD}: invalid inline artifact MIME type.`,
          );
        }
      }
      if (
        "type" in source &&
        !["artifact", "base64", "url", "text", "content"].includes(
          String(source.type),
        )
      ) {
        throw new Error(
          `${INVALID_SESSION_RECORD}: unsupported attachment source.`,
        );
      }
    }
    return value;
  });
  for (const result of message.tool_results ?? []) {
    for (const block of result.content_blocks ?? []) {
      if (
        !isArtifactSourceBlock(block) &&
        !normalizeToolResultContentBlock(block)
      ) {
        throw new Error(
          `${INVALID_SESSION_RECORD}: invalid rich tool content.`,
        );
      }
    }
  }
  if (message.type === COMPACT_BOUNDARY) {
    for (const kept of compactPayload(message).keep) {
      validateRichContent({ ...kept, timestamp: 0 });
    }
  }
  if (message.type === CODE_MODE_RECOVERY_RECORD) {
    const payload = recoveryPayload(message);
    validateRichContent({
      role: "user",
      content: "",
      timestamp: 0,
      tool_results: [
        {
          tool_use_id: payload.id,
          content: payload.result.output,
          content_blocks: payload.result.contentBlocks,
          structured_content: payload.result.structuredContent,
          raw_content: payload.result.rawContent,
        },
      ],
    });
  }
}
export function isArtifactSourceBlock(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("source" in value)) {
    return false;
  }
  const source = value.source;
  return (
    !!source &&
    typeof source === "object" &&
    "type" in source &&
    source.type === "artifact"
  );
}
export function visitJson(
  value: unknown,
  visitor: (value: unknown) => unknown,
): unknown {
  if (Array.isArray(value)) {
    return visitor(value.map((item) => visitJson(item, visitor)));
  }
  if (value && typeof value === "object") {
    return visitor(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          visitJson(item, visitor),
        ]),
      ),
    );
  }
  return visitor(value);
}
export function validateArtifactReferences(
  value: unknown,
  artifacts: Map<string, SessionArtifact>,
  budget = { bytes: 0, references: 0 },
  active = new Set<string>(),
): void {
  let payload: { value: unknown } | undefined;
  if (
    value &&
    typeof value === "object" &&
    "role" in value &&
    value.role === "system" &&
    "type" in value &&
    typeof value.type === "string" &&
    "content" in value &&
    typeof value.content === "string"
  ) {
    payload = readStructuredPayload({
      role: "system",
      type: value.type,
      content: value.content,
    });
  }
  const base =
    payload && value && typeof value === "object"
      ? { ...value, content: "" }
      : value;
  visitJson(base, (item) => {
    if (++budget.references > MAX_JSON_REFERENCES) {
      throw new Error(`${INVALID_SESSION_RECORD}: reference budget exceeded.`);
    }
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "artifact"
    ) {
      if (
        !("artifactId" in item) ||
        typeof item.artifactId !== "string" ||
        !artifacts.has(item.artifactId) ||
        Object.keys(item).some((key) => !["type", "artifactId"].includes(key))
      ) {
        throw new Error(
          `${INVALID_SESSION_RECORD}: invalid artifact reference.`,
        );
      }
      budget.bytes += requireReference(artifacts, item.artifactId).length;
    }
    if (
      item &&
      typeof item === "object" &&
      "artifact" in item &&
      item.artifact !== undefined
    ) {
      const reference = ToolArtifactSchema.parse(item.artifact);
      if (reference.path === undefined) {
        const artifact = requireReference(artifacts, reference.id);
        if (
          (reference.mimeType !== undefined &&
            reference.mimeType !== artifact.mimeType) ||
          (reference.size !== undefined &&
            reference.size !== artifact.length) ||
          (reference.hash !== undefined && reference.hash !== artifact.sha256)
        ) {
          throw new Error(`${INVALID_TOOL_ARTIFACT}: metadata mismatch.`);
        }
        budget.bytes += artifact.length;
        if (active.has(artifact.artifactId) || active.size >= MAX_JSON_DEPTH) {
          throw new Error(`${INVALID_TOOL_ARTIFACT}: cyclic/deep payload.`);
        }
        active.add(artifact.artifactId);
        validateArtifactReferences(
          readToolArtifactPayload(artifact),
          artifacts,
          budget,
          active,
        );
        active.delete(artifact.artifactId);
      }
    }
    if (typeof item === "string") {
      for (const match of item.matchAll(ARTIFACT_URI_RE)) {
        const artifact = artifacts.get(match[1]);
        if (!artifact) {
          throw new Error(`${INVALID_SESSION_RECORD}: unknown artifact URI.`);
        }
        budget.bytes += artifact.length;
      }
    }
    if (budget.bytes > MAX_ARTIFACT_TOTAL_BYTES) {
      throw new Error(
        `${INVALID_SESSION_RECORD}: artifact expansion budget exceeded.`,
      );
    }
    return item;
  });
  if (payload) {
    validateArtifactReferences(payload.value, artifacts, budget, active);
  }
}
export function hydrateMessage(
  message: SessionMessage,
  artifacts: Map<string, SessionArtifact>,
): SessionMessage {
  const hydrate = (item: unknown): unknown => {
    if (
      item &&
      typeof item === "object" &&
      "artifact" in item &&
      item.artifact !== undefined
    ) {
      const reference = ToolArtifactSchema.parse(item.artifact);
      if (reference.path === undefined) {
        const payload = visitJson(
          readToolArtifactPayload(requireReference(artifacts, reference.id)),
          hydrate,
        );
        const full = ToolArtifactPayloadSchema.parse(payload);
        if ("tool_use_id" in item) {
          return {
            ...item,
            content: full.output,
            ...(full.contentBlocks
              ? { content_blocks: full.contentBlocks }
              : {}),
            ...(full.structuredContent
              ? { structured_content: full.structuredContent }
              : {}),
            ...(full.rawContent ? { raw_content: full.rawContent } : {}),
          };
        }
        return { ...item, ...full };
      }
    }
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "artifact" &&
      "artifactId" in item &&
      typeof item.artifactId === "string"
    ) {
      const artifact = requireReference(artifacts, item.artifactId);
      return {
        type: "base64",
        media_type: artifact.mimeType,
        data: artifact.data,
      };
    }
    if (item && typeof item === "object" && "mimeType" in item) {
      for (const [field, source] of Object.entries(item)) {
        if (
          (field === "data" || field === "blob") &&
          source &&
          typeof source === "object" &&
          "type" in source &&
          source.type === "base64" &&
          "data" in source &&
          "media_type" in source
        ) {
          return { ...item, [field]: source.data, mimeType: source.media_type };
        }
      }
    }
    if (typeof item === "string") {
      return item.replace(ARTIFACT_URI_RE, (_match, id: string) => {
        const artifact = requireReference(artifacts, id);
        return artifact.mimeType.startsWith("text/")
          ? decodeArtifact(artifact).toString("utf8")
          : `${ARTIFACT_URI_PREFIX}${id}`;
      });
    }
    return item;
  };
  const payload = readStructuredPayload(message);
  const result = SessionMessageSchema.parse(
    visitJson(payload ? { ...message, content: "" } : message, hydrate),
  );
  if (payload) {
    result.content = JSON.stringify(visitJson(payload.value, hydrate));
  }
  return result;
}
export function* sessionTextParts(text: string): Generator<string> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + SESSION_TRANSPORT_TEXT_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end--;
    }
    yield text.slice(start, end);
    start = end;
  }
}

export function* sessionUtf8Chunks(
  parts: Iterable<string>,
  limit = MAX_SESSION_STREAM_BYTES,
): Generator<Buffer> {
  let buffer = Buffer.allocUnsafe(SESSION_TRANSPORT_CHUNK_BYTES);
  let used = 0;
  let total = 0;
  for (const part of parts) {
    for (const text of sessionTextParts(part)) {
      const bytes = Buffer.from(text);
      total += bytes.length;
      if (total > limit) {
        throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
      }
      if (used + bytes.length > buffer.length) {
        yield buffer.subarray(0, used);
        buffer = Buffer.allocUnsafe(SESSION_TRANSPORT_CHUNK_BYTES);
        used = 0;
      }
      bytes.copy(buffer, used);
      used += bytes.length;
    }
  }
  if (used) {
    yield buffer.subarray(0, used);
  }
}

function* jsonStringParts(text: string): Generator<string> {
  yield '"';
  for (const part of sessionTextParts(text)) {
    yield JSON.stringify(part).slice(1, -1);
  }
  yield '"';
}
export function* sessionJsonParts(
  value: unknown,
  pretty = false,
  depth = 0,
): Generator<string> {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`${INVALID_SESSION_RECORD}: JSON limits exceeded.`);
  }
  if (typeof value === "string") {
    yield* jsonStringParts(value);
  } else if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    yield JSON.stringify(value);
  } else if (Array.isArray(value)) {
    yield "[";
    for (const [index, child] of value.entries()) {
      if (index) {
        yield ",";
      }
      if (pretty) {
        yield `\n${"  ".repeat(depth + 1)}`;
      }
      yield* sessionJsonParts(child, pretty, depth + 1);
    }
    if (pretty && value.length) {
      yield `\n${"  ".repeat(depth)}`;
    }
    yield "]";
  } else if (value && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        continue;
      }
      if (!first) {
        yield ",";
      }
      first = false;
      if (pretty) {
        yield `\n${"  ".repeat(depth + 1)}`;
      }
      yield* jsonStringParts(key);
      yield pretty ? ": " : ":";
      yield* sessionJsonParts(child, pretty, depth + 1);
    }
    if (pretty && !first) {
      yield `\n${"  ".repeat(depth)}`;
    }
    yield "}";
  } else {
    throw new Error(`${INVALID_SESSION_RECORD}: non-JSON value.`);
  }
}

function* sessionJsonlRecordChunks(
  record: SessionHeader | SessionRecord,
): Generator<Buffer> {
  assertBoundedJson(record);
  function* line(): Generator<string> {
    yield* sessionJsonParts(record);
    yield "\n";
  }
  yield* sessionUtf8Chunks(line(), MAX_SESSION_RECORD_BYTES);
}

export function* sessionJsonlChunks(
  document: Pick<SessionDocument, "header" | "records">,
): Generator<Buffer> {
  if (document.records.length + 1 > MAX_SESSION_RECORDS) {
    throw new Error(`${INVALID_SESSION_RECORD}: record limit exceeded.`);
  }
  let total = 0;
  function* records(): Generator<SessionHeader | SessionRecord> {
    yield document.header;
    yield* document.records;
  }
  for (const record of records()) {
    for (const bytes of sessionJsonlRecordChunks(record)) {
      total += bytes.length;
      if (total > MAX_SESSION_STREAM_BYTES) {
        throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
      }
      yield bytes;
    }
  }
}

export function countSessionDocumentBytes(
  document: Pick<SessionDocument, "header" | "records">,
): number {
  let bytes = 0;
  for (const chunk of sessionJsonlChunks(document)) {
    bytes += chunk.length;
  }
  return bytes;
}

export function collectSessionString(chunks: Iterable<Uint8Array>): string {
  const parts: Buffer[] = [];
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
    if (total > MAX_SESSION_STRING_BYTES) {
      throw new Error(
        `${INVALID_SESSION_RECORD}: string byte limit exceeded; use stream/file transport.`,
      );
    }
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts, total).toString("utf8");
}

/** Holds only one encoded line; UTF-8 and schemas are decoded per bounded record. */
export class SessionJsonlParser {
  private buffer = Buffer.allocUnsafe(SESSION_TRANSPORT_CHUNK_BYTES);
  private used = 0;
  private total = 0;
  private lines = 0;
  private header?: SessionHeader;
  private records: SessionRecord[] = [];
  private artifactBytes = 0;
  private artifactCount = 0;
  private finished = false;

  push(chunk: Uint8Array): void {
    if (this.finished || !(chunk instanceof Uint8Array)) {
      throw new Error(INVALID_SESSION_RECORD);
    }
    this.total += chunk.byteLength;
    if (this.total > MAX_SESSION_STREAM_BYTES) {
      throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
    }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let start = 0; start < bytes.length;) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      const length = end - start;
      if (this.used + length + 1 > MAX_SESSION_RECORD_BYTES) {
        throw new Error(
          `${INVALID_SESSION_RECORD}: record byte limit exceeded.`,
        );
      }
      if (this.used + length > this.buffer.length) {
        const next = Buffer.allocUnsafe(
          Math.min(
            MAX_SESSION_RECORD_BYTES,
            Math.max(this.used + length, this.buffer.length * 2),
          ),
        );
        this.buffer.copy(next, 0, 0, this.used);
        this.buffer = next;
      }
      bytes.copy(this.buffer, this.used, start, end);
      this.used += length;
      if (newline !== -1) {
        this.parseLine();
        this.used = 0;
      }
      start = end + 1;
    }
  }

  private parseLine(): void {
    if (++this.lines > MAX_SESSION_RECORDS) {
      throw new Error(`${INVALID_SESSION_RECORD}: record limit exceeded.`);
    }
    try {
      const line = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(this.buffer.subarray(0, this.used));
      const value: unknown = JSON.parse(line);
      assertBoundedJson(value);
      if (!this.header) {
        const header = SessionHeaderSchema.safeParse(value);
        if (!header.success) {
          throw new Error(UNSUPPORTED_SESSION_FORMAT, { cause: header.error });
        }
        this.header = header.data;
      } else {
        const record = SessionRecordSchema.parse(value);
        if (record.type === "artifact") {
          this.artifactBytes += record.length;
          if (
            ++this.artifactCount > MAX_ARTIFACTS ||
            this.artifactBytes > MAX_ARTIFACT_TOTAL_BYTES
          ) {
            throw new Error(
              `${INVALID_SESSION_RECORD}: artifact budget exceeded.`,
            );
          }
          decodeArtifact(record);
        }
        this.records.push(record);
      }
    } catch (error) {
      throw new Error(
        `${INVALID_SESSION_RECORD} at line ${String(this.lines)}: ${error instanceof Error ? error.message : "invalid JSON"}`,
        { cause: error },
      );
    }
  }

  finish(options: { completeTools?: boolean } = {}): SessionDocument {
    this.finished = true;
    if (this.used || !this.header) {
      throw new Error(`${INVALID_SESSION_RECORD}: incomplete JSONL record.`);
    }
    return validateDocument(this.header, this.records, options);
  }
}

export function parseSessionJsonl(
  serialized: string,
  options: { completeTools?: boolean } = {},
): SessionDocument {
  if (Buffer.byteLength(serialized) > MAX_SESSION_STREAM_BYTES) {
    throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
  }
  let lines = 0;
  for (
    let position = serialized.indexOf("\n");
    position !== -1;
    position = serialized.indexOf("\n", position + 1)
  ) {
    if (++lines > MAX_SESSION_RECORDS) {
      throw new Error(`${INVALID_SESSION_RECORD}: record limit exceeded.`);
    }
  }
  const parser = new SessionJsonlParser();
  for (const part of sessionTextParts(serialized)) {
    parser.push(Buffer.from(part));
  }
  return parser.finish(options);
}
export function serializeDocument(
  document: Pick<SessionDocument, "header" | "records">,
): string {
  return collectSessionString(sessionJsonlChunks(document));
}
export function readSessionDocument(filePath: string): SessionDocument | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const fd = openPrivateFileSync(filePath, "r");
  let document: SessionDocument;
  try {
    if (fstatSync(fd).size > MAX_SESSION_STREAM_BYTES) {
      throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
    }
    const parser = new SessionJsonlParser();
    const buffer = Buffer.allocUnsafe(SESSION_TRANSPORT_CHUNK_BYTES);
    let count: number;
    while ((count = readSync(fd, buffer)) > 0) {
      parser.push(buffer.subarray(0, count));
    }
    document = parser.finish();
  } finally {
    closeSync(fd);
  }
  if (
    document.header.sessionId !== basename(filePath, SESSION_FILE_EXTENSION)
  ) {
    throw new Error(
      `${INVALID_SESSION_RECORD}: header identity does not match its filename.`,
    );
  }
  return document;
}
function writeSessionRecords(
  filePath: string,
  records: readonly (SessionHeader | SessionRecord)[],
  append: boolean,
): void {
  const fd = openPrivateFileSync(filePath, append ? "a" : "wx");
  let committed = false;
  try {
    const initialSize = append ? fstatSync(fd).size : 0;
    try {
      for (const record of records) {
        for (const bytes of sessionJsonlRecordChunks(record)) {
          writeAllSync(fd, bytes);
        }
      }
      fsyncSync(fd);
      committed = true;
    } catch (error) {
      if (append) {
        try {
          ftruncateSync(fd, initialSize);
          fsyncSync(fd);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            SESSION_APPEND_ROLLBACK_ERROR,
          );
        }
      }
      throw error;
    }
  } finally {
    closeSync(fd);
    if (!append && !committed) {
      rmSync(filePath, { force: true });
    }
  }
}

export function ensureSessionHeaderUnderLock(filePath: string): void {
  if (!readSessionDocument(filePath)) {
    const header = createSessionHeader(
      basename(filePath, SESSION_FILE_EXTENSION),
    );
    writeSessionRecords(filePath, [header], false);
  }
}

export function getEntryPath(
  document: SessionDocument,
  leafId = document.leafId,
): SessionEntry[] {
  const byId = new Map(document.entries.map((entry) => [entry.entryId, entry]));
  const path: SessionEntry[] = [];
  let current = leafId;
  while (current !== null) {
    const entry = byId.get(current);
    if (!entry || path.length >= MAX_SESSION_DEPTH) {
      throw new Error(`${INVALID_SESSION_RECORD}: invalid path.`);
    }
    path.push(entry);
    current = entry.parentId;
  }
  return path.reverse();
}
export function pendingToolIds(
  document: SessionDocument,
  leafId: string | null,
): Set<string> {
  let state: ToolPathState = { pending: new Set(), seen: new Set(), depth: 0 };
  for (const entry of getEntryPath(document, leafId)) {
    state = advanceTools(entry.message, state);
  }
  return state.pending;
}
export function getDocumentTree(document: SessionDocument): SessionTreeNode[] {
  const nodes = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const entry of document.entries) {
    const label = document.labels.get(entry.entryId);
    const node: SessionTreeNode = {
      entry: structuredClone(entry),
      ...(label ? { label } : {}),
      children: [],
    };
    nodes.set(entry.entryId, node);
    if (entry.parentId === null) {
      roots.push(node);
    } else {
      requireReference(nodes, entry.parentId).children.push(node);
    }
  }
  return roots;
}
export function messageEntry(
  document: SessionDocument,
  message: SessionMessage,
): SessionEntry {
  assertBoundedJson(message);
  return SessionEntrySchema.parse({
    type: "message",
    entryId: randomUUID(),
    parentId: document.leafId,
    timestamp: Date.now(),
    revision: document.revision + 1,
    message,
  });
}
export function appendDocumentRecords(
  filePath: string,
  document: SessionDocument,
  records: SessionRecord[],
): SessionDocument {
  const next = validateDocument(document.header, [
    ...document.records,
    ...records,
  ]);
  const existing = existsSync(filePath);
  writeSessionRecords(
    filePath,
    existing ? records : [document.header, ...records],
    existing,
  );
  return next;
}
export function appendTranscriptMessage(
  filePath: string,
  message: SessionMessage,
  expectedRevision?: number,
): string {
  mkdirPrivateSync(dirname(filePath));
  return withFileSyncLock(filePath, () => {
    const document =
      readSessionDocument(filePath) ??
      validateDocument(
        createSessionHeader(basename(filePath, SESSION_FILE_EXTENSION)),
        [],
      );
    if (
      expectedRevision !== undefined &&
      document.revision !== expectedRevision
    ) {
      throw new SessionConflictError(expectedRevision, document.revision);
    }
    const entry = messageEntry(document, message);
    appendDocumentRecords(filePath, document, [
      entry,
      {
        type: "active_leaf",
        leafId: entry.entryId,
        revision: entry.revision + 1,
      },
    ]);
    return entry.entryId;
  });
}
export function toolUsesToRecords(
  toolUses?: {
    toolUseId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    providerItemId?: string;
  }[],
): ToolUseRecord[] {
  return (toolUses ?? []).map((use) => ({
    tool_use_id: use.toolUseId,
    tool_name: use.toolName,
    ...(use.arguments && Object.keys(use.arguments).length
      ? { arguments: use.arguments }
      : {}),
    ...(use.providerItemId ? { provider_item_id: use.providerItemId } : {}),
  }));
}
export function toolResultsToRecords(
  toolResults?: ToolResultBlock[],
): ToolResultRecord[] {
  return (toolResults ?? []).map((result) => ({
    tool_use_id: result.toolUseId,
    content: result.content,
    ...(result.contentBlocks?.length
      ? { content_blocks: result.contentBlocks }
      : {}),
    ...(result.structuredContent
      ? { structured_content: result.structuredContent }
      : {}),
    ...(result.rawContent?.length ? { raw_content: result.rawContent } : {}),
    ...(result.artifact ? { artifact: result.artifact } : {}),
    ...(result.isError ? { is_error: true } : {}),
  }));
}
export function messageToKeptRecord(message: Message): KeptMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.fileOperations
      ? { file_operations: message.fileOperations }
      : {}),
    ...(message.role === "user" && message.userInput
      ? { user_input: message.userInput }
      : {}),
    ...(message.userBash ? { user_bash: message.userBash } : {}),
    ...(message.toolUses?.length
      ? { tool_uses: toolUsesToRecords(message.toolUses) }
      : {}),
    ...(message.toolResults?.length
      ? { tool_results: toolResultsToRecords(message.toolResults) }
      : {}),
    ...(message.role === "assistant" && message.thinkingBlocks?.length
      ? { thinking_blocks: message.thinkingBlocks }
      : {}),
  };
}
function contentBlocks(
  value?: unknown[],
): ToolResultContentBlock[] | undefined {
  if (!value?.length) {
    return undefined;
  }
  return value.map((raw) => {
    const block = normalizeToolResultContentBlock(raw);
    if (!block) {
      throw new Error(`${INVALID_SESSION_RECORD}: invalid rich tool content.`);
    }
    return block;
  });
}
function toRestored(
  message: KeptMessage,
  includeExcludedUserBash = false,
): RestoredMessage | null {
  if (message.user_bash?.excludeFromContext && !includeExcludedUserBash) {
    return null;
  }
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  if (
    !message.content.length &&
    !message.tool_uses?.length &&
    !message.tool_results?.length &&
    !message.thinking_blocks?.length &&
    !message.user_bash
  ) {
    return null;
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.file_operations
      ? { fileOperations: message.file_operations }
      : {}),
    ...(message.role === "user" && message.user_input
      ? { userInput: message.user_input }
      : {}),
    ...(message.user_bash ? { userBash: message.user_bash } : {}),
    ...(message.tool_uses?.length
      ? {
          toolUses: message.tool_uses.map((use) => ({
            toolUseId: use.tool_use_id,
            toolName: use.tool_name,
            arguments: use.arguments ?? {},
            ...(use.provider_item_id
              ? { providerItemId: use.provider_item_id }
              : {}),
          })),
        }
      : {}),
    ...(message.tool_results?.length
      ? {
          toolResults: message.tool_results.map((result) => ({
            toolUseId: result.tool_use_id,
            content: result.content,
            ...(contentBlocks(result.content_blocks)
              ? { contentBlocks: contentBlocks(result.content_blocks) }
              : {}),
            ...(result.structured_content
              ? { structuredContent: result.structured_content }
              : {}),
            ...(result.raw_content?.length
              ? { rawContent: result.raw_content }
              : {}),
            ...(result.artifact ? { artifact: result.artifact } : {}),
            isError: result.is_error ?? false,
          })),
        }
      : {}),
    ...(message.thinking_blocks?.length
      ? { thinkingBlocks: message.thinking_blocks }
      : {}),
  };
}
export function rebuildFromSession(
  saved: SessionMessage[],
  options: { includeExcludedUserBash?: boolean } = {},
): RestoredMessage[] {
  const parsed = saved.map((message) => {
    assertBoundedJson(message);
    return SessionMessageSchema.parse(message);
  });
  let boundaryIndex = -1;
  let payload: CompactBoundaryPayload | undefined;
  for (const [index, message] of parsed.entries()) {
    if (message.type === COMPACT_BOUNDARY) {
      payload = compactPayload(message);
      boundaryIndex = index;
    }
  }
  const out: RestoredMessage[] = [];
  if (payload) {
    let tools: ToolPathState = {
      pending: new Set(),
      seen: new Set(),
      depth: 0,
    };
    for (const kept of payload.keep) {
      tools = advanceTools(kept, tools);
    }
    if (tools.pending.size) {
      throw new Error(
        `${INVALID_SESSION_RECORD}: incomplete compacted tool batch.`,
      );
    }
    out.push({
      role: "user",
      content: buildCompactionSummaryMessage(
        payload.summary,
        payload.keep.length > 0,
      ),
      ...(payload.details ? { fileOperations: payload.details } : {}),
    });
    for (const kept of payload.keep) {
      const message = toRestored(kept, options.includeExcludedUserBash);
      if (message) {
        out.push(message);
      }
    }
  }
  for (const message of parsed.slice(boundaryIndex + 1)) {
    if (message.type === BRANCH_SUMMARY) {
      out.push({
        role: "user",
        content: buildBranchSummaryReminder(branchSummaryPayload(message)),
        fileOperations: branchSummaryPayload(message).details,
      });
      continue;
    }
    if (
      message.type === SESSION_RUNTIME_STATE ||
      message.type === CODE_MODE_RECORD ||
      message.type === CODE_MODE_RECOVERY_RECORD ||
      message.type === COMPACT_BOUNDARY
    ) {
      continue;
    }
    const restored = toRestored(message, options.includeExcludedUserBash);
    if (restored) {
      out.push(restored);
    }
  }
  for (const message of parsed.slice(boundaryIndex + 1)) {
    if (message.type !== CODE_MODE_RECOVERY_RECORD) {
      continue;
    }
    const { id, result } = recoveryPayload(message);
    if (
      out.some((item) =>
        item.toolResults?.some((block) => block.toolUseId === id),
      )
    ) {
      continue;
    }
    const index = out.findIndex((item) =>
      item.toolUses?.some((call) => call.toolUseId === id),
    );
    if (index < 0) {
      throw new Error(`${INVALID_SESSION_RECORD}: orphaned recovery.`);
    }
    const blocks = contentBlocks(result.contentBlocks);
    const block: ToolResultBlock = {
      toolUseId: id,
      content: result.output,
      isError: result.isError,
      ...(blocks ? { contentBlocks: blocks } : {}),
      ...(result.structuredContent
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.rawContent?.length ? { rawContent: result.rawContent } : {}),
      ...(result.artifact ? { artifact: result.artifact } : {}),
    };
    const next = out[index + 1];
    if (next?.role === "user" && next.toolResults?.length) {
      next.toolResults.push(block);
    } else {
      out.splice(index + 1, 0, {
        role: "user",
        content: "",
        toolResults: [block],
      });
    }
  }
  return out;
}
