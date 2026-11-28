import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { z } from "zod";

import {
  CODE_MODE_MAX_CALLS,
  CODE_MODE_MAX_OUTPUT_CHARS,
  CODE_MODE_RECORD,
  CODE_MODE_RECOVERY_RECORD,
} from "@/code-mode/constants.js";
import {
  assertBoundedVmJson,
  VmJsonSchema,
  VmJsonObjectSchema,
} from "@/code-mode/schema.js";
import type { CodeModeSavedRun, CodeModeStart } from "@/code-mode/types.js";
import { FileOperationsSchema } from "@/session/file-operations.js";
import {
  appendTranscriptMessage,
  getEntryPath,
  hydrateMessage,
  readSessionDocument,
  type SessionMessage,
} from "@/session/records.js";
import { tryAcquireFileSyncLock, withFileSyncLock } from "@/teams/file-lock.js";
import {
  normalizeToolResultContentBlock,
  type ToolResultContentBlock,
  type ToolSchema,
} from "@/tools/types.js";
import { isRecord } from "@/utils/record.js";

const JsonObjectSchema = VmJsonObjectSchema;
const ContentBlockSchema = z.custom<ToolResultContentBlock>(
  (value) => normalizeToolResultContentBlock(value) !== null,
);
const JsonValueSchema = VmJsonSchema;
const ResultSchema = z.object({
  output: z.string().max(CODE_MODE_MAX_OUTPUT_CHARS),
  isError: z.boolean(),
  contentBlocks: z.array(ContentBlockSchema).optional(),
  structuredContent: JsonObjectSchema.optional(),
  rawContent: z.array(JsonValueSchema).optional(),
  artifact: z
    .object({
      id: z.string(),
      path: z.string().optional(),
      mimeType: z.string().optional(),
      size: z.number().nonnegative().optional(),
      hash: z.string().optional(),
    })
    .optional(),
});
const CallSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  args: JsonObjectSchema,
});
const StartSchema = z.object({
  code: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      namespace: z.string().optional(),
      source: z
        .object({
          kind: z.string(),
          id: z.string().optional(),
          scope: z.string().optional(),
        })
        .optional(),
      schema: z.custom<ToolSchema>(
        (value) =>
          isRecord(value) &&
          typeof value.name === "string" &&
          isRecord(value.input_schema),
      ),
    }),
  ),
  store: JsonObjectSchema,
  seed: z.number().int().nonnegative(),
  startedAt: z.number(),
  deadline: z.number(),
  maxOutputTokens: z.number().int().positive(),
});
const OutcomeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({
      output: z.string(),
      contentBlocks: z.array(ContentBlockSchema).optional(),
      structuredContent: JsonValueSchema.optional(),
      rawContent: z.array(JsonValueSchema).optional(),
      artifact: z
        .object({
          id: z.string(),
          path: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().nonnegative().optional(),
          hash: z.string().optional(),
        })
        .optional(),
      isError: z.boolean().optional(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    fileOperations: FileOperationsSchema.optional(),
  }),
]);
export const CodeModeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"),
    id: z.string(),
    start: StartSchema,
    fingerprint: z.string(),
  }),
  z.object({
    kind: z.literal("calls"),
    id: z.string(),
    calls: z.array(CallSchema).max(CODE_MODE_MAX_CALLS),
  }),
  z.object({
    kind: z.literal("started"),
    id: z.string(),
    callId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("result"),
    id: z.string(),
    callId: z.number().int().positive(),
    now: z.number(),
    outcome: OutcomeSchema,
  }),
  z.object({
    kind: z.literal("idle"),
    id: z.string(),
    seq: z.number().int().nonnegative(),
    issued: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("finished"),
    id: z.string(),
    result: ResultSchema,
    store: JsonObjectSchema.optional(),
  }),
]);
export type CodeModeEvent = z.infer<typeof CodeModeEventSchema>;

export function appendCodeModeRecord(path: string, event: CodeModeEvent): void {
  assertBoundedVmJson(event);
  const parsed = CodeModeEventSchema.parse(event);
  appendRecord(path, {
    role: "system",
    type: CODE_MODE_RECORD,
    timestamp: Date.now() / 1000,
    content: JSON.stringify(parsed),
  });
}

export function appendCodeModeRecovery(
  path: string,
  id: string,
  result: z.infer<typeof ResultSchema>,
): void {
  assertBoundedVmJson(result);
  const parsed = ResultSchema.parse(result);
  appendRecord(path, {
    role: "system",
    type: CODE_MODE_RECOVERY_RECORD,
    timestamp: Date.now() / 1000,
    content: JSON.stringify({ id, result: parsed }),
  });
}

function appendRecord(path: string, record: SessionMessage): void {
  if (!path) {
    return;
  }
  appendTranscriptMessage(path, record);
}

export function acquireCodeModeRun(path: string, id: string): () => void {
  if (!path) {
    return () => undefined;
  }
  const key = createHash("sha256").update(id).digest("hex");
  const release = tryAcquireFileSyncLock(`${path}.code-mode-${key}`, 0);
  if (!release) {
    throw new Error("Code Mode is already executing in another process.");
  }
  return release;
}

export function readCodeModeRuns(path: string): Map<string, CodeModeSavedRun> {
  if (!path || !existsSync(path)) {
    return new Map();
  }
  return withFileSyncLock(path, () => {
    const document = readSessionDocument(path);
    return rebuildCodeModeRuns(
      document
        ? getEntryPath(document).map((entry) =>
            hydrateMessage(entry.message, document.artifacts),
          )
        : [],
    );
  });
}

export function rebuildCodeModeRuns(
  records: SessionMessage[],
): Map<string, CodeModeSavedRun> {
  const runs = new Map<string, CodeModeSavedRun>();
  for (const record of records) {
    if (record.historical || record.type !== CODE_MODE_RECORD) {
      continue;
    }
    if (typeof record.content !== "string") {
      throw new Error("Invalid Code Mode record.");
    }
    const raw: unknown = JSON.parse(record.content);
    assertBoundedVmJson(raw);
    const event = CodeModeEventSchema.parse(raw);
    if (event.kind === "start") {
      if (runs.has(event.id)) {
        throw new Error("Duplicate Code Mode start record.");
      }
      runs.set(event.id, {
        id: event.id,
        start: event.start,
        fingerprint: event.fingerprint,
        calls: [],
        started: [],
        journal: [],
      });
      continue;
    }
    const run = runs.get(event.id);
    if (!run || run.result) {
      throw new Error("Invalid Code Mode journal order.");
    }
    switch (event.kind) {
      case "calls":
        for (const call of event.calls) {
          if (call.id !== run.calls.length + 1) {
            throw new Error("Invalid Code Mode call sequence.");
          }
          run.calls.push(call);
        }
        break;
      case "started":
        if (
          !run.calls[event.callId - 1] ||
          run.started.includes(event.callId)
        ) {
          throw new Error("Invalid Code Mode started call.");
        }
        run.started.push(event.callId);
        break;
      case "result":
        if (
          !run.started.includes(event.callId) ||
          run.journal.some((entry) => entry.id === event.callId)
        ) {
          throw new Error("Invalid Code Mode result sequence.");
        }
        run.journal.push({
          id: event.callId,
          now: event.now,
          outcome: event.outcome,
          issued: -1,
        });
        break;
      case "idle":
        if (event.seq === 0) {
          if (
            run.firstIssued !== undefined &&
            run.firstIssued !== event.issued
          ) {
            throw new Error("Code Mode initial checkpoint changed.");
          }
          run.firstIssued = event.issued;
        } else {
          const entry = run.journal[event.seq - 1];
          if (!entry || (entry.issued >= 0 && entry.issued !== event.issued)) {
            throw new Error("Invalid Code Mode idle checkpoint.");
          }
          entry.issued = event.issued;
        }
        break;
      case "finished":
        run.result = event.result;
        run.store = event.store;
        break;
    }
  }
  return runs;
}

export function codeModeStore(
  runs: Map<string, CodeModeSavedRun>,
): CodeModeStart["store"] {
  let store: CodeModeStart["store"] = {};
  for (const run of runs.values()) {
    if (run.result && !run.result.isError && run.store) {
      store = run.store;
    }
  }
  return structuredClone(store);
}
