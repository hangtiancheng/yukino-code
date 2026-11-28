import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { version } from "@/bootstrap/version.js";
import {
  CODE_MODE_RECORD,
  CODE_MODE_RECOVERY_RECORD,
} from "@/code-mode/constants.js";
import type { CostSummary, UsageSnapshot } from "@/cost/types.js";
import type { AgentRuntime } from "@/runtime/types.js";
import {
  ABSOLUTE_PATH_RE,
  ARTIFACT_URI_PREFIX,
  EXPORT_REDACTION_NOTICE,
  MAX_ARTIFACT_BYTES,
  PERSISTED_OUTPUT_PATH_RE,
  REDACTED_TEXT,
  SENSITIVE_KEY_RE,
  SENSITIVE_TEXT_RE,
  SESSION_EXPORT_CSP,
  COMPACT_BOUNDARY,
  BRANCH_SUMMARY,
  INVALID_TOOL_ARTIFACT,
  UNOWNED_ARTIFACT,
  UNSAFE_ARTIFACT_LINK,
  ARTIFACT_URI_RE,
  MAX_ARTIFACT_TOTAL_BYTES,
  MAX_ARTIFACTS,
  SESSION_RUNTIME_STATE,
  SESSION_RUNTIME_STATE_LABEL,
  MAX_SESSION_STRING_BYTES,
  INVALID_SESSION_RECORD,
  SESSION_TRANSPORT_TEXT_CHARS,
  SESSION_VIEWER_FENCE_RE,
  SESSION_VIEWER_MAX_INDENT,
  LOCAL_DIAGNOSTICS_MAX_BYTES,
  LOCAL_DIAGNOSTICS_MAX_TEXT,
  LOCAL_DIAGNOSTICS_MAX_ITEMS,
  LOCAL_DIAGNOSTICS_MAX_NODES,
  LOCAL_DIAGNOSTICS_MAX_DEPTH,
  LOCAL_DIAGNOSTICS_OMITTED,
  LOCAL_DIAGNOSTICS_CONFIGURATION_KEYS,
  LOCAL_DIAGNOSTICS_TEXT_BUDGET,
  LOCAL_DIAGNOSTICS_USAGE_KEYS,
} from "@/session/constants.js";
import {
  branchSummaryPayload,
  BranchSummaryPayloadSchema,
} from "@/session/records.js";
import {
  assertBoundedJson,
  createSessionHeader,
  decodeArtifact,
  getEntryPath,
  getSessionArtifactsDir,
  makeArtifact,
  parseSessionJsonl,
  collectSessionString,
  sessionTextParts,
  sessionJsonParts,
  sessionUtf8Chunks,
  validateDocument,
  visitJson,
  requireReference,
  CompactBoundaryPayloadSchema,
  SessionMessageSchema,
  SessionMetadataSchema,
  decodeInlineBase64,
  readStructuredPayload,
  ToolArtifactSchema,
  readToolArtifactPayload,
  type SessionToolArtifact,
  type SessionArtifact,
  type SessionDocument,
  type SessionEntry,
  type SessionMessage,
  type SessionRecord,
} from "@/session/records.js";
import { getYukinoDir } from "@/storage/index.js";
import {
  SPILL_DIR_NAME,
  SPILL_FILE_EXTENSION,
} from "@/tool-result/constants.js";

export interface SessionExportOptions {
  scope: "active" | "tree";
  format: "jsonl" | "html";
  redact?: boolean;
  signal?: AbortSignal;
}
export interface SessionTransferContext {
  cwd: string;
  artifactDirectory?: string;
}

function toolUseId(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("tool_use_id" in value) ||
    typeof value.tool_use_id !== "string"
  ) {
    throw new Error(INVALID_TOOL_ARTIFACT);
  }
  return value.tool_use_id;
}
export function redactText(text: string): string {
  return text
    .replace(
      SENSITIVE_TEXT_RE,
      (_match, prefix: string | undefined) => `${prefix ?? ""}${REDACTED_TEXT}`,
    )
    .replace(ABSOLUTE_PATH_RE, "[local-path]");
}
export function redactValue(value: unknown): unknown {
  assertBoundedJson(value);
  return visitJson(value, (item) => {
    if (typeof item === "string") {
      return redactText(item);
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (
        ("source" in item && item.source && typeof item.source === "object") ||
        ("mimeType" in item && ("data" in item || "blob" in item))
      ) {
        return { type: "text", text: "[REDACTED attachment]" };
      }
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          (SENSITIVE_KEY_RE.test(key) && typeof child !== "number") ||
          key === "signature" ||
          (key === "data" &&
            "type" in item &&
            item.type === "redacted_thinking")
            ? REDACTED_TEXT
            : child,
        ]),
      );
    }
    return item;
  });
}
function redactSessionMessage(message: SessionMessage): SessionMessage {
  if (message.type === SESSION_RUNTIME_STATE) {
    return SessionMessageSchema.parse(message);
  }
  if (
    message.role === "system" &&
    message.type &&
    typeof message.content === "string"
  ) {
    let payload: unknown;
    try {
      payload = JSON.parse(message.content);
    } catch {
      return SessionMessageSchema.parse(redactValue(message));
    }
    const redacted = SessionMessageSchema.parse(
      redactValue({ ...message, content: "" }),
    );
    redacted.content = JSON.stringify(redactValue(payload));
    return redacted;
  }
  return SessionMessageSchema.parse(redactValue(message));
}
function ownedSpill(path: string, directory: string): Buffer {
  const absolute = resolve(path);
  const root = resolve(directory);
  const rel = relative(root, absolute);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    resolve(root, rel) !== absolute
  ) {
    throw new Error("Export refuses an artifact outside its session owner.");
  }
  let current = absolute;
  while (current !== root) {
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Export refuses symlink artifacts.");
    }
    current = dirname(current);
  }
  const storage = resolve(getYukinoDir());
  current = root;
  while (current !== storage) {
    if (
      current === dirname(current) ||
      !relative(storage, current) ||
      relative(storage, current).startsWith("..") ||
      lstatSync(current).isSymbolicLink()
    ) {
      throw new Error(UNSAFE_ARTIFACT_LINK);
    }
    current = dirname(current);
  }
  if (
    lstatSync(storage).isSymbolicLink() ||
    realpathSync(absolute) !== join(realpathSync(root), rel)
  ) {
    throw new Error(UNSAFE_ARTIFACT_LINK);
  }
  const fd = openSync(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (stat.nlink !== 1) {
      throw new Error(UNSAFE_ARTIFACT_LINK);
    }
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(
        "Artifact exceeds export limits or is not a regular file.",
      );
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) {
        throw new Error(
          `${INVALID_TOOL_ARTIFACT}: source changed during export.`,
        );
      }
      offset += count;
    }
    const after = fstatSync(fd);
    const named = lstatSync(absolute);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      named.ino !== stat.ino ||
      named.dev !== stat.dev ||
      after.nlink !== 1
    ) {
      throw new Error(
        `${INVALID_TOOL_ARTIFACT}: source changed during export.`,
      );
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** The same header/entry/control/artifact grammar is used on disk and in portable JSONL. */
export function prepareSessionExport(
  document: SessionDocument,
  options: SessionExportOptions,
  context: SessionTransferContext,
): SessionDocument {
  options.signal?.throwIfAborted();
  if (
    !["active", "tree"].includes(options.scope) ||
    !["jsonl", "html"].includes(options.format)
  ) {
    throw new Error("Invalid session export options.");
  }
  const selected =
    options.scope === "active" ? getEntryPath(document) : document.entries;
  const selectedIds = new Set(selected.map((entry) => entry.entryId));
  const artifacts = new Map<string, SessionArtifact>();
  const existingArtifacts = document.artifacts;
  const spillIds = new Map<string, string>();
  const spillSources = new Map<string, SessionArtifact>();
  const artifactDirectory = context.artifactDirectory;
  const owner = getSessionArtifactsDir(document.header.sessionId);
  if (
    artifactDirectory !== undefined &&
    resolve(artifactDirectory) !== resolve(owner)
  ) {
    throw new Error(UNOWNED_ARTIFACT);
  }
  let artifactBytes = 0;
  const includeArtifact = (artifact: SessionArtifact): void => {
    if (artifacts.has(artifact.artifactId)) {
      return;
    }
    artifactBytes += artifact.length;
    if (
      artifactBytes > MAX_ARTIFACT_TOTAL_BYTES ||
      artifacts.size >= MAX_ARTIFACTS
    ) {
      throw new Error(`${INVALID_TOOL_ARTIFACT}: artifact budget exceeded.`);
    }
    artifacts.set(artifact.artifactId, artifact);
  };
  const addArtifact = (bytes: Uint8Array, mimeType: string): string => {
    const artifact = makeArtifact(bytes, mimeType, 1);
    includeArtifact(artifact);
    return artifact.artifactId;
  };
  const verifiedCalls = new Set<string>();
  for (const entry of document.entries) {
    const payload = readStructuredPayload(entry.message);
    visitJson(
      payload ? [entry.message, payload.value] : entry.message,
      (value) => {
        if (
          value &&
          typeof value === "object" &&
          "tool_uses" in value &&
          Array.isArray(value.tool_uses)
        ) {
          for (const use of value.tool_uses) {
            verifiedCalls.add(toolUseId(use));
          }
        }
        return value;
      },
    );
  }
  const spillPath = (id: string): string =>
    join(
      owner,
      SPILL_DIR_NAME,
      `${encodeURIComponent(id).replaceAll("*", "%2A")}${SPILL_FILE_EXTENSION}`,
    );
  const portableText = (text: string): string =>
    context.cwd
      ? text
          .replaceAll(`${context.cwd}${sep}`, "[workspace]/")
          .replaceAll(context.cwd, "[workspace]")
      : text;
  const transformMessage = (message: SessionMessage): SessionMessage => {
    if (message.type === BRANCH_SUMMARY) {
      const payload = visitJson(branchSummaryPayload(message), (item) =>
        typeof item === "string" ? portableText(item) : item,
      );
      return {
        ...message,
        content: JSON.stringify(
          options.redact
            ? BranchSummaryPayloadSchema.parse(redactValue(payload))
            : payload,
        ),
      };
    }
    if (message.type === SESSION_RUNTIME_STATE) {
      return SessionMessageSchema.parse(message);
    }
    const allowedIds = new Set(
      (message.tool_results ?? []).map((result) => result.tool_use_id),
    );
    const structured = readStructuredPayload(message);
    if (
      [CODE_MODE_RECORD, CODE_MODE_RECOVERY_RECORD].includes(
        message.type ?? "",
      ) &&
      structured?.value &&
      typeof structured.value === "object" &&
      "id" in structured.value &&
      typeof structured.value.id === "string" &&
      verifiedCalls.has(structured.value.id)
    ) {
      allowedIds.add(structured.value.id);
      if (
        "kind" in structured.value &&
        structured.value.kind === "result" &&
        "callId" in structured.value &&
        typeof structured.value.callId === "number" &&
        Number.isSafeInteger(structured.value.callId) &&
        structured.value.callId > 0
      ) {
        allowedIds.add(
          `${structured.value.id}/c${String(structured.value.callId)}`,
        );
      }
    }
    const allowedSpills = new Set([...allowedIds].map(spillPath));
    const toolReferences = new Map<string, SessionToolArtifact>();
    const scanArtifacts = (value: unknown): void => {
      visitJson(value, (item) => {
        if (
          item &&
          typeof item === "object" &&
          "artifact" in item &&
          item.artifact !== undefined
        ) {
          const reference = ToolArtifactSchema.parse(item.artifact);
          let artifact: SessionArtifact;
          if (reference.path !== undefined) {
            if (
              !artifactDirectory ||
              !allowedIds.has(reference.id) ||
              reference.path !== spillPath(reference.id)
            ) {
              throw new Error(UNOWNED_ARTIFACT);
            }
            const known = spillIds.get(reference.path);
            artifact = known
              ? requireReference(artifacts, known)
              : makeArtifact(
                  ownedSpill(reference.path, artifactDirectory),
                  reference.mimeType ?? "text/plain",
                  1,
                );
            const original = spillSources.get(reference.path) ?? artifact;
            if (
              (reference.size !== undefined &&
                reference.size !== original.length) ||
              (reference.hash !== undefined &&
                reference.hash !== original.sha256) ||
              (reference.mimeType !== undefined &&
                reference.mimeType !== original.mimeType)
            ) {
              throw new Error(
                `${INVALID_TOOL_ARTIFACT}: source metadata mismatch.`,
              );
            }
            if (!known) {
              spillSources.set(reference.path, original);
              if (artifact.mimeType === "application/json") {
                const payload = readToolArtifactPayload(artifact);
                // Embedded full results are JSON data, never a second filesystem authority.
                visitJson(payload, (nested) => {
                  if (
                    nested &&
                    typeof nested === "object" &&
                    "artifact" in nested &&
                    nested.artifact &&
                    typeof nested.artifact === "object" &&
                    "path" in nested.artifact
                  ) {
                    throw new Error(
                      `${INVALID_TOOL_ARTIFACT}: nested host path.`,
                    );
                  }
                  return nested;
                });
                if (options.redact) {
                  artifact = {
                    ...makeArtifact(
                      Buffer.from(JSON.stringify(redactValue(payload))),
                      artifact.mimeType,
                      1,
                    ),
                    artifactId: artifact.artifactId,
                  };
                }
              } else if (options.redact) {
                artifact = {
                  ...makeArtifact(
                    Buffer.from(
                      redactText(decodeArtifact(artifact).toString("utf8")),
                    ),
                    "text/plain",
                    1,
                  ),
                  artifactId: artifact.artifactId,
                };
              }
              includeArtifact(artifact);
              spillIds.set(reference.path, artifact.artifactId);
            }
          } else {
            artifact = requireReference(existingArtifacts, reference.id);
            if (
              (reference.mimeType !== undefined &&
                reference.mimeType !== artifact.mimeType) ||
              (reference.size !== undefined &&
                reference.size !== artifact.length) ||
              (reference.hash !== undefined &&
                reference.hash !== artifact.sha256)
            ) {
              throw new Error(`${INVALID_TOOL_ARTIFACT}: metadata mismatch.`);
            }
            if (options.redact && !artifacts.has(artifact.artifactId)) {
              const payload = readToolArtifactPayload(artifact);
              const bytes =
                artifact.mimeType === "application/json"
                  ? Buffer.from(JSON.stringify(redactValue(payload)))
                  : Buffer.from(redactText(payload.output));
              artifact = {
                ...makeArtifact(bytes, artifact.mimeType, 1),
                artifactId: artifact.artifactId,
              };
            } else {
              artifact = artifacts.get(artifact.artifactId) ?? artifact;
            }
            includeArtifact(artifact);
          }
          toolReferences.set(reference.id, {
            id: artifact.artifactId,
            mimeType: artifact.mimeType,
            size: artifact.length,
            hash: artifact.sha256,
          });
        }
        return item;
      });
    };
    scanArtifacts(structured ? [message, structured.value] : message);
    const transform = (item: unknown): unknown => {
      if (
        item &&
        typeof item === "object" &&
        "artifact" in item &&
        item.artifact &&
        typeof item.artifact === "object" &&
        "id" in item.artifact &&
        typeof item.artifact.id === "string"
      ) {
        return {
          ...item,
          artifact: requireReference(toolReferences, item.artifact.id),
        };
      }
      if (
        item &&
        typeof item === "object" &&
        "mimeType" in item &&
        typeof item.mimeType === "string"
      ) {
        if (options.redact && ("data" in item || "blob" in item)) {
          return { type: "text", text: "[REDACTED attachment]" };
        }
        if ("data" in item && typeof item.data === "string") {
          return {
            ...item,
            data: {
              type: "artifact",
              artifactId: addArtifact(
                decodeInlineBase64(item.data),
                item.mimeType,
              ),
            },
          };
        }
        if ("blob" in item && typeof item.blob === "string") {
          return {
            ...item,
            blob: {
              type: "artifact",
              artifactId: addArtifact(
                decodeInlineBase64(item.blob),
                item.mimeType,
              ),
            },
          };
        }
        for (const field of ["data", "blob"]) {
          const source = Object.entries(item).find(
            ([key]) => key === field,
          )?.[1];
          if (
            source &&
            typeof source === "object" &&
            "type" in source &&
            source.type === "artifact" &&
            "artifactId" in source &&
            typeof source.artifactId === "string"
          ) {
            artifacts.set(
              source.artifactId,
              requireReference(existingArtifacts, source.artifactId),
            );
          }
        }
      }
      if (
        item &&
        typeof item === "object" &&
        "source" in item &&
        item.source &&
        typeof item.source === "object"
      ) {
        const source = item.source;
        if (
          "type" in source &&
          (source.type === "base64" || source.type === "artifact")
        ) {
          if (options.redact) {
            return { type: "text", text: "[REDACTED attachment]" };
          }
          if (
            source.type === "base64" &&
            "data" in source &&
            typeof source.data === "string" &&
            "media_type" in source &&
            typeof source.media_type === "string"
          ) {
            const id = addArtifact(
              decodeInlineBase64(source.data),
              source.media_type,
            );
            return { ...item, source: { type: "artifact", artifactId: id } };
          }
          if (
            source.type === "artifact" &&
            "artifactId" in source &&
            typeof source.artifactId === "string"
          ) {
            const artifact = existingArtifacts.get(source.artifactId);
            if (!artifact) {
              throw new Error("Unknown export artifact.");
            }
            artifacts.set(artifact.artifactId, artifact);
          }
        }
      }
      if (typeof item === "string") {
        let text = item;
        for (const [path, id] of spillIds) {
          text = text.replaceAll(path, `${ARTIFACT_URI_PREFIX}${id}`);
        }
        text = text.replace(
          PERSISTED_OUTPUT_PATH_RE,
          (_match, before: string, path: string, after: string) => {
            if (path.startsWith(ARTIFACT_URI_PREFIX)) {
              return `${before}${path}${after}`;
            }
            if (!artifactDirectory || !allowedSpills.has(path)) {
              throw new Error(UNOWNED_ARTIFACT);
            }
            let id = spillIds.get(path);
            if (!id) {
              const bytes = ownedSpill(path, artifactDirectory);
              id = addArtifact(
                options.redact
                  ? Buffer.from(redactText(bytes.toString("utf8")))
                  : bytes,
                "text/plain",
              );
              spillIds.set(path, id);
            }
            return `${before}${ARTIFACT_URI_PREFIX}${id}${after}`;
          },
        );
        for (const match of text.matchAll(ARTIFACT_URI_RE)) {
          const artifact = existingArtifacts.get(match[1]);
          if (artifact && !artifacts.has(artifact.artifactId)) {
            if (options.redact) {
              artifacts.set(artifact.artifactId, {
                ...artifact,
                ...makeArtifact(
                  Buffer.from(
                    artifact.mimeType.startsWith("text/")
                      ? redactText(decodeArtifact(artifact).toString("utf8"))
                      : REDACTED_TEXT,
                  ),
                  "text/plain",
                  1,
                ),
                artifactId: artifact.artifactId,
              });
            } else {
              artifacts.set(artifact.artifactId, artifact);
            }
          }
        }
        text = portableText(text);
        return options.redact ? redactText(text) : text;
      }
      return item;
    };
    let transformed = SessionMessageSchema.parse(
      visitJson(structured ? { ...message, content: "" } : message, transform),
    );
    if (
      message.type === COMPACT_BOUNDARY &&
      typeof message.content === "string"
    ) {
      const raw: unknown = JSON.parse(message.content);
      const payload = CompactBoundaryPayloadSchema.parse(raw);
      transformed.content = JSON.stringify({
        summary: visitJson(payload.summary, transform),
        ...(payload.details
          ? { details: visitJson(payload.details, transform) }
          : {}),
        keep: payload.keep.map((kept) => {
          const { timestamp: _timestamp, ...rest } = transformMessage({
            ...kept,
            timestamp: 0,
          });
          return rest;
        }),
      });
    } else if (structured) {
      transformed.content = JSON.stringify(
        visitJson(structured.value, transform),
      );
    }
    if (options.redact) {
      transformed = redactSessionMessage(transformed);
    }
    return transformed;
  };
  const entries = selected.map((entry) => ({
    ...entry,
    message: transformMessage(entry.message),
  }));
  const records: SessionRecord[] = [];
  const push = (record: SessionRecord): void => {
    records.push({ ...record, revision: records.length + 1 });
  };
  for (const artifact of artifacts.values()) {
    push(artifact);
  }
  for (const entry of entries) {
    push(entry);
  }
  push({ type: "active_leaf", leafId: document.leafId, revision: 1 });
  push({
    type: "metadata",
    metadata: options.redact
      ? SessionMetadataSchema.parse(redactValue(document.metadata))
      : document.metadata,
    revision: 1,
  });
  for (const [entryId, label] of document.labels) {
    if (selectedIds.has(entryId)) {
      push({
        type: "label",
        entryId,
        label: options.redact ? redactText(label) : label,
        revision: 1,
      });
    }
  }
  options.signal?.throwIfAborted();
  return validateDocument(document.header, records, {
    completeTools: true,
  });
}

export function copySessionDocument(
  document: SessionDocument,
  operation: "fork" | "clone" | "import",
  sessionId?: string,
): SessionDocument {
  const header = {
    ...createSessionHeader(sessionId),
    provenance: {
      operation,
      sessionId: document.header.sessionId,
      leafId: document.leafId,
    },
  };
  const entryIds = new Map(
    document.entries.map((entry) => [entry.entryId, randomUUID()]),
  );
  const artifactIds = new Map(
    [...document.artifacts.keys()].map((id) => [id, randomUUID()]),
  );
  const callIds = new Map<string, string>();
  const inputIds = new Map<string, string>();
  for (const entry of document.entries) {
    visitJson(entry.message, (value) => {
      if (value && typeof value === "object") {
        if ("tool_use_id" in value && typeof value.tool_use_id === "string") {
          callIds.set(
            value.tool_use_id,
            callIds.get(value.tool_use_id) ?? randomUUID(),
          );
        }
        if (
          "user_input" in value &&
          value.user_input &&
          typeof value.user_input === "object" &&
          "id" in value.user_input &&
          typeof value.user_input.id === "string"
        ) {
          inputIds.set(
            value.user_input.id,
            inputIds.get(value.user_input.id) ?? randomUUID(),
          );
        }
      }
      return value;
    });
    if (
      entry.message.type === COMPACT_BOUNDARY &&
      typeof entry.message.content === "string"
    ) {
      const payload: unknown = JSON.parse(entry.message.content);
      visitJson(payload, (value) => {
        if (value && typeof value === "object") {
          if ("tool_use_id" in value && typeof value.tool_use_id === "string") {
            callIds.set(
              value.tool_use_id,
              callIds.get(value.tool_use_id) ?? randomUUID(),
            );
          }
          if (
            "user_input" in value &&
            value.user_input &&
            typeof value.user_input === "object" &&
            "id" in value.user_input &&
            typeof value.user_input.id === "string"
          ) {
            inputIds.set(
              value.user_input.id,
              inputIds.get(value.user_input.id) ?? randomUUID(),
            );
          }
        }
        return value;
      });
    }
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") {
      const identity =
        entryIds.get(value) ?? callIds.get(value) ?? inputIds.get(value);
      if (identity) {
        return identity;
      }
      return value.replace(
        /artifact:\/\/([A-Za-z\d_-]{1,128})/gu,
        (_match, id: string) =>
          `${ARTIFACT_URI_PREFIX}${artifactIds.get(id) ?? id}`,
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (
        "type" in value &&
        value.type === "artifact" &&
        "artifactId" in value &&
        typeof value.artifactId === "string"
      ) {
        return {
          ...value,
          artifactId: requireReference(artifactIds, value.artifactId),
        };
      }
      if (
        "artifact" in value &&
        value.artifact &&
        typeof value.artifact === "object" &&
        "id" in value.artifact &&
        typeof value.artifact.id === "string"
      ) {
        return {
          ...value,
          artifact: {
            ...value.artifact,
            id: requireReference(artifactIds, value.artifact.id),
          },
        };
      }
    }
    return value;
  };
  const records = document.records.map((record): SessionRecord => {
    if (record.type === "artifact") {
      return {
        ...record,
        artifactId: requireReference(artifactIds, record.artifactId),
        provenance: {
          sessionId: document.header.sessionId,
          artifactId: record.artifactId,
        },
      };
    }
    if (record.type === "message") {
      const message = SessionMessageSchema.parse(
        record.message.type === SESSION_RUNTIME_STATE
          ? record.message
          : visitJson(record.message, remap),
      );
      const payload = readStructuredPayload(record.message);
      if (payload) {
        message.content = JSON.stringify(visitJson(payload.value, remap));
      }
      message.historical = true;
      return {
        ...record,
        entryId: requireReference(entryIds, record.entryId),
        parentId:
          record.parentId === null
            ? null
            : requireReference(entryIds, record.parentId),
        message,
        provenance: {
          sessionId: document.header.sessionId,
          entryId: record.entryId,
        },
      };
    }
    if (record.type === "active_leaf") {
      return {
        ...record,
        leafId:
          record.leafId === null
            ? null
            : requireReference(entryIds, record.leafId),
      };
    }
    if (record.type === "label") {
      return { ...record, entryId: requireReference(entryIds, record.entryId) };
    }
    return structuredClone(record);
  });
  return validateDocument(header, records, { completeTools: true });
}
export function parseSessionImport(serialized: string): SessionDocument {
  if (Buffer.byteLength(serialized) > MAX_SESSION_STRING_BYTES) {
    throw new Error(
      `${INVALID_SESSION_RECORD}: string byte limit exceeded; use stream/file transport.`,
    );
  }
  return prepareSessionImport(
    parseSessionJsonl(serialized, { completeTools: true }),
  );
}
export function prepareSessionImport(
  document: SessionDocument,
): SessionDocument {
  // Imported paths are inert transcript text, never a source of files or destinations.
  const inspect = (value: unknown): void => {
    visitJson(value, (item) => {
      if (
        item &&
        typeof item === "object" &&
        "artifact" in item &&
        item.artifact !== undefined
      ) {
        const reference = ToolArtifactSchema.parse(item.artifact);
        if (reference.path !== undefined) {
          throw new Error(
            `${INVALID_TOOL_ARTIFACT}: imported host paths are forbidden.`,
          );
        }
        inspect(
          readToolArtifactPayload(
            requireReference(document.artifacts, reference.id),
          ),
        );
      }
      if (typeof item === "string") {
        for (const match of item.matchAll(PERSISTED_OUTPUT_PATH_RE)) {
          if (!match[2].startsWith(ARTIFACT_URI_PREFIX)) {
            throw new Error(
              "Imported persisted outputs must use portable artifact IDs.",
            );
          }
        }
      }
      return item;
    });
  };
  for (const entry of document.entries) {
    const payload = readStructuredPayload(entry.message);
    inspect(payload ? [entry.message, payload.value] : entry.message);
  }
  return copySessionDocument(document, "import");
}
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function* pre(value: unknown): Generator<string> {
  yield "<pre>";
  const parts =
    typeof value === "string"
      ? sessionTextParts(value)
      : sessionJsonParts(value, true);
  for (const part of parts) {
    yield escapeHtml(part);
  }
  yield "</pre>";
}
// This fixed payload is the only executable content in an export; its exact bytes are CSP-hashed.
export const SESSION_VIEWER_SCRIPT = String.raw`"use strict";
(() => {
  const rows = Array.from(document.querySelectorAll("[data-tree-entry]"));
  const nodes = new Map(rows.map(row => [row.dataset.treeEntry, {
    row, parent: row.dataset.parent,
    article: document.getElementById("entry-" + row.dataset.treeEntry), folded: false
  }]));
  const branch = document.getElementById("viewer-branch");
  const origin = document.getElementById("viewer-origin");
  const kind = document.getElementById("viewer-kind");
  const search = document.getElementById("viewer-search");
  const status = document.getElementById("viewer-status");
  const update = () => {
    const path = new Set();
    let id = branch.value;
    while (id && nodes.has(id) && !path.has(id)) {
      path.add(id); id = nodes.get(id).parent;
    }
    const query = search.value.slice(0, 512).trim().toLowerCase();
    const needed = new Set();
    let count = 0;
    for (const [entryId, node] of nodes) {
      const article = node.article;
      const matches = (!branch.value || path.has(entryId)) &&
        (origin.value === "all" || article.dataset.origin === origin.value) &&
        (kind.value === "all" || article.dataset.kind === kind.value) &&
        (!query || article.textContent.toLowerCase().includes(query));
      article.hidden = !matches;
      if (matches) { needed.add(entryId); count++; }
    }
    for (let index = rows.length - 1; index >= 0; index--) {
      const node = nodes.get(rows[index].dataset.treeEntry);
      if (needed.has(rows[index].dataset.treeEntry) && node.parent) needed.add(node.parent);
    }
    const folded = new Set();
    for (const [entryId, node] of nodes) {
      const hiddenByFold = folded.has(node.parent);
      node.row.hidden = !needed.has(entryId) || (!query && hiddenByFold);
      if (hiddenByFold || node.folded) folded.add(entryId);
      const button = node.row.querySelector("button");
      if (button) {
        button.textContent = node.folded ? "Expand" : "Collapse";
        button.setAttribute("aria-expanded", String(!node.folded));
      }
    }
    status.textContent = count + " / " + rows.length + " entries shown. Search reveals matching tree paths; folding affects the tree only.";
  };
  for (const node of nodes.values()) {
    const button = node.row.querySelector("button");
    if (button) button.addEventListener("click", () => { node.folded = !node.folded; update(); });
  }
  for (const control of [branch, origin, kind]) control.addEventListener("change", update);
  search.addEventListener("input", update);
  for (const action of ["collapse", "expand"]) {
    document.getElementById("viewer-" + action).addEventListener("click", () => {
      for (const node of nodes.values()) node.folded = action === "collapse";
      update();
    });
  }
  update();
})();`;

const SESSION_VIEWER_STYLE = `body{max-width:1100px;margin:2rem auto;padding:0 1rem;font:16px system-ui;background:#111827;color:#e5e7eb}a{color:#93c5fd}article,details{padding:1rem;margin:1rem 0;border:1px solid #374151;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;font:14px ui-monospace,monospace}summary,button{cursor:pointer}img{max-width:100%}small,.tree-row{overflow-wrap:anywhere}.controls{display:flex;flex-wrap:wrap;gap:1rem}.controls label{display:flex;flex-direction:column;gap:.4rem}input,select,button{font:inherit;color:inherit;background:#1f2937;border:1px solid #6b7280;border-radius:4px;padding:.3rem}.tree{list-style:none;padding:0}.tree-row{padding:.4rem 0;margin-left:calc(var(--depth)*1rem);border-left:2px solid #374151}.tree-row[data-current="true"]{border-color:#60a5fa}.badge{font-size:.8rem;color:#cbd5e1}.code-section{border:1px solid #4b5563;border-radius:4px;margin:1rem 0}.code-label{padding:.4rem;background:#1f2937}.code-section pre{padding:.6rem;margin:0;white-space:pre;overflow-x:auto;overflow-wrap:normal}.diff-add{color:#86efac;background:#14532d55}.diff-remove{color:#fca5a5;background:#7f1d1d55}.diff-meta{color:#93c5fd}[hidden]{display:none!important}`;

function* escapedRange(
  text: string,
  start: number,
  limit: number,
): Generator<string> {
  while (start < limit) {
    let end = Math.min(start + SESSION_TRANSPORT_TEXT_CHARS, limit);
    const last = text.charCodeAt(end - 1);
    if (end < limit && last >= 0xd800 && last <= 0xdbff) {
      end--;
    }
    yield escapeHtml(text.slice(start, end));
    start = end;
  }
}
function* readableText(text: string): Generator<string> {
  let fence: string | undefined;
  let diff =
    text.startsWith("diff --git ") ||
    text.startsWith("--- ") ||
    text.startsWith("@@ ");
  yield diff
    ? '<div class="code-section"><div class="code-label">Diff</div><pre><code>'
    : "<pre>";
  const bareDiff = diff;
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(start, Math.min(end, start + 128));
    const match =
      end - start <= 128 ? SESSION_VIEWER_FENCE_RE.exec(line.trimEnd()) : null;
    if (
      !bareDiff &&
      match &&
      (!fence ||
        (match[1].startsWith(fence[0]) &&
          match[1].length >= fence.length &&
          !match[2]))
    ) {
      if (fence) {
        yield "</code></pre></div><pre>";
        fence = undefined;
        diff = false;
      } else {
        fence = match[1];
        diff = match[2] === "diff" || match[2] === "patch";
        yield `</pre><div class="code-section"><div class="code-label">${escapeHtml(match[2] || "Code")}</div><pre><code>`;
      }
    } else {
      const style = diff
        ? line.startsWith("+")
          ? "diff-add"
          : line.startsWith("-")
            ? "diff-remove"
            : /^(?:@@|diff |index |\*\*\*)/u.test(line)
              ? "diff-meta"
              : ""
        : "";
      if (style) {
        yield `<span class="${style}">`;
      }
      yield* escapedRange(text, start, end);
      if (style) {
        yield "</span>";
      }
    }
    start = end;
  }
  yield fence || bareDiff ? "</code></pre></div>" : "</pre>";
}
function* readableContent(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield* readableText(value);
  } else if (Array.isArray(value)) {
    for (const raw of value) {
      const block: unknown = raw;
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        yield* readableText(block.text);
      } else {
        yield* pre(block);
      }
    }
  } else {
    yield* pre(value);
  }
}
function* section(
  title: string,
  value: unknown,
  open = false,
): Generator<string> {
  yield `<details${open ? " open" : ""}><summary>${escapeHtml(title)}</summary>`;
  yield* readableContent(value);
  yield "</details>";
}
function viewerKind(message: SessionMessage): string {
  if (message.type === SESSION_RUNTIME_STATE) {
    return "schema";
  }
  if (message.user_bash) {
    return "shell";
  }
  if (
    message.tool_uses?.length ||
    message.tool_results?.length ||
    [CODE_MODE_RECORD, CODE_MODE_RECOVERY_RECORD].includes(message.type ?? "")
  ) {
    return "tools";
  }
  return "message";
}
function* renderEntry(
  entry: SessionEntry,
  document: SessionDocument,
  current: boolean,
): Generator<string> {
  const message = entry.message;
  const label = document.labels.get(entry.entryId);
  yield `<article id="entry-${escapeHtml(entry.entryId)}" data-origin="${message.historical ? "historical" : "current"}" data-kind="${viewerKind(message)}"><h2>${escapeHtml(message.role)}${label ? ` · ${escapeHtml(label)}` : ""}</h2>`;
  yield `<small>${escapeHtml(entry.entryId)} · parent: ${entry.parentId ? `<a href="#entry-${escapeHtml(entry.parentId)}">${escapeHtml(entry.parentId)}</a>` : "root"} · ${message.historical ? "Historical / imported record" : "Current-session record"}${current ? " · active branch" : " · other branch"}${document.leafId === entry.entryId ? " · selected leaf" : ""}</small>`;
  if (message.type === SESSION_RUNTIME_STATE) {
    yield* section(
      `${SESSION_RUNTIME_STATE_LABEL} / schema snapshot (inert)`,
      message.state,
      true,
    );
  } else {
    yield* section(
      message.type ?? "Message / code / diff",
      message.content,
      true,
    );
  }
  if (message.thinking_blocks?.length) {
    yield "<details><summary>Thinking</summary>";
    for (const block of message.thinking_blocks) {
      yield* readableText(
        block.type === "thinking"
          ? block.thinking
          : "[Opaque redacted thinking — not displayed]",
      );
    }
    yield "</details>";
  }
  if (message.tool_uses?.length) {
    yield* section("Tool calls (inert data)", message.tool_uses);
  }
  for (const result of message.tool_results ?? []) {
    yield* section(`Tool result · ${result.tool_use_id}`, result.content, true);
    yield* section("Tool result metadata / schema / attachments (inert)", {
      ...result,
      content: undefined,
    });
  }
  if (message.user_bash) {
    yield* section("Shell command (not executed)", message.user_bash.command);
    yield* section("Shell output / diff", message.user_bash.output, true);
  }
  if (message.cost) {
    yield* section("Cost (historical usage, not a new charge)", message.cost);
  }
  yield "</article>";
}
export function* sessionHtmlParts(
  document: SessionDocument,
): Generator<string> {
  const name = document.metadata.name || "Yukino session";
  const currentPath = new Set(
    getEntryPath(document).map((entry) => entry.entryId),
  );
  const children = new Map<string | null, SessionEntry[]>();
  for (const entry of document.entries) {
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  }
  yield `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(SESSION_EXPORT_CSP)}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title><style>${SESSION_VIEWER_STYLE}</style></head><body><h1>${escapeHtml(name)}</h1><p>${escapeHtml(EXPORT_REDACTION_NOTICE)}</p><p>Offline viewer. Transcript, schema, shell commands and attachments are inert data. Recorded costs are not new spending.</p><div class="controls"><label>Branch<select id="viewer-branch"><option value="">All branches</option>`;
  for (const entry of document.entries) {
    if (!children.has(entry.entryId) || entry.entryId === document.leafId) {
      yield `<option value="${escapeHtml(entry.entryId)}">${entry.entryId === document.leafId ? "Active branch" : "Branch"} · ${escapeHtml(document.labels.get(entry.entryId) ?? entry.entryId)}</option>`;
    }
  }
  yield '</select></label><label>Record origin<select id="viewer-origin"><option value="all">All records</option><option value="current">Current session</option><option value="historical">Historical / imported</option></select></label><label>Sections<select id="viewer-kind"><option value="all">All sections</option><option value="message">Messages / code / diff</option><option value="schema">Runtime / schema</option><option value="tools">Tool records</option><option value="shell">Shell records</option></select></label><label>Search<input id="viewer-search" type="search" maxlength="512" placeholder="Search inert transcript text"></label></div><p id="viewer-status" role="status"></p><noscript>Filtering requires the fixed offline viewer script. All entries remain readable without it.</noscript><details open><summary>Session tree · ';
  yield String(document.entries.length);
  yield ' entries</summary><button id="viewer-collapse" type="button">Collapse all</button> <button id="viewer-expand" type="button">Expand all</button><ul class="tree">';
  const stack = (children.get(null) ?? [])
    .map((entry) => ({ entry, depth: 0 }))
    .reverse();
  while (stack.length) {
    const item = stack.pop();
    if (!item) {
      break;
    }
    const { entry, depth } = item;
    const descendants = children.get(entry.entryId) ?? [];
    yield `<li class="tree-row" data-tree-entry="${escapeHtml(entry.entryId)}" data-parent="${escapeHtml(entry.parentId ?? "")}" data-depth="${String(depth)}" data-current="${String(currentPath.has(entry.entryId))}" style="--depth:${String(Math.min(depth, SESSION_VIEWER_MAX_INDENT))}">${descendants.length ? '<button type="button" aria-expanded="true">Collapse</button> ' : ""}<a href="#entry-${escapeHtml(entry.entryId)}">${escapeHtml(document.labels.get(entry.entryId) ?? `${entry.message.role}: ${entry.entryId}`)}</a> <span class="badge">${escapeHtml(viewerKind(entry.message))} · ${entry.message.historical ? "historical" : "current"}${document.leafId === entry.entryId ? " · selected leaf" : ""}</span></li>`;
    for (let index = descendants.length - 1; index >= 0; index--) {
      stack.push({ entry: descendants[index], depth: depth + 1 });
    }
  }
  yield "</ul></details>";
  for (const entry of document.entries) {
    yield* renderEntry(entry, document, currentPath.has(entry.entryId));
  }
  yield "<h2>Attachments (inert, not searched)</h2>";
  for (const artifact of document.artifacts.values()) {
    yield `<details><summary>Artifact ${escapeHtml(artifact.artifactId)} · ${escapeHtml(artifact.mimeType)} · ${String(artifact.length)} bytes</summary>`;
    yield* pre(artifact.sha256);
    if (
      artifact.mimeType.startsWith("text/") ||
      artifact.mimeType === "application/json"
    ) {
      yield* pre(decodeArtifact(artifact).toString("utf8"));
    } else if (
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        artifact.mimeType,
      )
    ) {
      yield `<img alt="Session attachment" src="data:${escapeHtml(artifact.mimeType)};base64,`;
      yield* sessionTextParts(artifact.data);
      yield '" loading="lazy">';
    } else {
      yield "<p>Binary attachment (not executed).</p>";
    }
    yield "</details>";
  }
  yield "<script>";
  yield SESSION_VIEWER_SCRIPT;
  yield "</script></body></html>";
}
export function renderSessionHtml(document: SessionDocument): string {
  return collectSessionString(sessionUtf8Chunks(sessionHtmlParts(document)));
}
export interface LocalDiagnosticsOptions {
  version?: string;
  configuration?: unknown;
  errors?: unknown;
  statistics?: unknown;
  context?: {
    contextWindow: number;
    permissionMode: string;
    memoryEnabled: boolean;
    coordinatorEnabled: boolean;
    schemaGeneration: number;
    toolCount: number;
    purpose?: string;
  };
  includeTranscript?: boolean;
}
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function diagnosticsConfiguration(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    LOCAL_DIAGNOSTICS_CONFIGURATION_KEYS.map((key) => [
      key,
      ownData(value, key),
    ]),
  );
}
function diagnosticUsage(usage: UsageSnapshot): UsageSnapshot {
  return Object.fromEntries(
    LOCAL_DIAGNOSTICS_USAGE_KEYS.map((key) => [key, usage[key]]),
  );
}
function diagnosticCost(cost: CostSummary) {
  const amounts = (values: CostSummary["estimated"]) =>
    Object.fromEntries(
      Object.entries(values)
        .filter(([currency]) => /^[A-Z]{3}$/u.test(currency))
        .slice(0, LOCAL_DIAGNOSTICS_MAX_ITEMS)
        .map(([currency, value]) => [
          currency,
          {
            amount: value.amount,
            knownAmount: value.knownAmount,
            unknownAttempts: value.unknownAttempts,
          },
        ]),
    );
  return {
    attempts: cost.attempts,
    requests: cost.requests,
    incompleteAttempts: cost.incompleteAttempts,
    usage: diagnosticUsage(cost.usage),
    estimated: amounts(cost.estimated),
    providerReported: amounts(cost.providerReported),
    unknownCurrencyEstimates: cost.unknownCurrencyEstimates,
    unknownProviderAmounts: cost.unknownProviderAmounts,
  };
}
export function projectRuntimeDiagnostics(
  runtime: AgentRuntime,
): LocalDiagnosticsOptions {
  const status = runtime.getStatus();
  const servers = runtime.mcpManager?.states() ?? [];
  const warming = status.cache.warming;
  const policy = status.cache.policy;
  return {
    version,
    configuration: {
      source: "runtime (effective provider; originating file not retained)",
      name: runtime.provider.name,
      model: runtime.provider.model,
      protocol: runtime.provider.protocol,
      thinking: runtime.provider.thinking,
      contextWindow: runtime.contextWindow,
      maxOutputTokens: runtime.provider.max_output_tokens,
    },
    context: {
      contextWindow: runtime.contextWindow,
      permissionMode: runtime.permissionMode,
      memoryEnabled: runtime.memoryEnabled,
      coordinatorEnabled: runtime.enableCoordinatorMode,
      schemaGeneration: runtime.registry.generation,
      toolCount: runtime.registry.listTools().length,
      purpose: runtime.executionContext?.purpose,
    },
    errors: {
      mcp: {
        serverCount: servers.length,
        omitted: Math.max(0, servers.length - LOCAL_DIAGNOSTICS_MAX_ITEMS),
        servers: servers
          .slice(0, LOCAL_DIAGNOSTICS_MAX_ITEMS)
          .map((server) => ({
            name: server.name,
            source: server.source.scope,
            state: server.state,
            exposure: server.exposure,
            tools: server.tools,
            unreachableCodeMode: server.unreachableCodeMode,
            diagnostic: server.diagnostic
              ? {
                  transport: server.diagnostic.transport,
                  phase: server.diagnostic.phase,
                  code: server.diagnostic.code,
                  httpStatus: server.diagnostic.httpStatus,
                  message: server.diagnostic.message,
                }
              : undefined,
          })),
      },
    },
    statistics: {
      observedAt: status.observedAt,
      request: status.request
        ? {
            usage: status.request.usage
              ? diagnosticUsage(status.request.usage)
              : null,
            usageComplete: status.request.usageComplete,
            inputTotalTokens: status.request.inputTotalTokens,
            cachePrefixTokens: status.request.cachePrefixTokens,
            contextTokens: status.request.contextTokens,
          }
        : null,
      run: status.run
        ? { active: status.run.active, cost: diagnosticCost(status.run.cost) }
        : null,
      session: status.session ? diagnosticCost(status.session.cost) : null,
      historical: {
        sourceCount: status.history.length,
        notNewSpending: true,
        omitted: Math.max(
          0,
          status.history.length - LOCAL_DIAGNOSTICS_MAX_ITEMS,
        ),
        costs: status.history
          .slice(0, LOCAL_DIAGNOSTICS_MAX_ITEMS)
          .map((item) => diagnosticCost(item.cost)),
      },
      cache: {
        policy: {
          mode: policy.mode,
          reason: policy.reason,
          ttlSeconds: policy.ttlSeconds,
          minTokens: policy.minTokens,
          mapping: policy.mapping,
          bestEffort: true,
        },
        warmingMode: status.cache.warmingMode,
        warming: {
          state: warming.state,
          skipReason: warming.skipReason,
          decision: warming.decision
            ? {
                allowed: warming.decision.allowed,
                reason: warming.decision.reason,
                currency: warming.decision.currency,
                netBenefit: warming.decision.netBenefit,
                warmCost: warming.decision.warmCost,
              }
            : undefined,
          lastCost: warming.lastCost
            ? diagnosticCost(warming.lastCost)
            : undefined,
        },
      },
    },
  };
}
function boundedDiagnostics(value: unknown): unknown {
  let nodes = LOCAL_DIAGNOSTICS_MAX_NODES;
  let characters = LOCAL_DIAGNOSTICS_TEXT_BUDGET;
  const visited = new WeakSet<object>();
  const text = (item: string, max = LOCAL_DIAGNOSTICS_MAX_TEXT): string => {
    const length = Math.max(0, Math.min(item.length, max, characters));
    characters -= length;
    return (
      redactText(item.slice(0, length)) +
      (item.length > length ? " [truncated]" : "")
    );
  };
  const walk = (item: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > LOCAL_DIAGNOSTICS_MAX_DEPTH) {
      return LOCAL_DIAGNOSTICS_OMITTED;
    }
    if (typeof item === "string") {
      return text(item);
    }
    if (item === null || typeof item === "boolean") {
      return item;
    }
    if (typeof item === "number") {
      return Number.isFinite(item) ? item : null;
    }
    if (item === undefined) {
      return undefined;
    }
    if (typeof item !== "object" || visited.has(item)) {
      return LOCAL_DIAGNOSTICS_OMITTED;
    }
    visited.add(item);
    if (
      (ownData(item, "source") &&
        typeof ownData(item, "source") === "object") ||
      (ownData(item, "mimeType") &&
        (ownData(item, "data") !== undefined ||
          ownData(item, "blob") !== undefined))
    ) {
      return "[REDACTED attachment]";
    }
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (
        let index = 0;
        index < Math.min(item.length, LOCAL_DIAGNOSTICS_MAX_ITEMS) && nodes > 0;
        index++
      ) {
        result.push(walk(ownData(item, String(index)), depth + 1));
      }
      if (result.length < item.length) {
        result.push(LOCAL_DIAGNOSTICS_OMITTED);
      }
      return result;
    }
    const result = new Map<string, unknown>();
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) {
        continue;
      }
      if (
        count++ >= LOCAL_DIAGNOSTICS_MAX_ITEMS ||
        nodes <= 0 ||
        characters <= 0
      ) {
        result.set("omitted", LOCAL_DIAGNOSTICS_OMITTED);
        break;
      }
      const child = ownData(item, key);
      const usageCount =
        LOCAL_DIAGNOSTICS_USAGE_KEYS.some((name) => name === key) &&
        typeof child === "number";
      result.set(
        text(key, 64),
        (SENSITIVE_KEY_RE.test(key) && !usageCount) ||
          key === "signature" ||
          (key === "data" && ownData(item, "type") === "redacted_thinking")
          ? REDACTED_TEXT
          : walk(child, depth + 1),
      );
    }
    return Object.fromEntries(result);
  };
  return walk(value, 0);
}
export function buildLocalDiagnostics(
  document: SessionDocument,
  options: LocalDiagnosticsOptions = {},
): string {
  const active =
    options.includeTranscript === true ? getEntryPath(document) : [];
  const context = options.context;
  const tty = (value: unknown): boolean => value === true;
  const report = {
    notice: EXPORT_REDACTION_NOTICE,
    limits: {
      maxBytes: LOCAL_DIAGNOSTICS_MAX_BYTES,
      maxItems: LOCAL_DIAGNOSTICS_MAX_ITEMS,
      maxTextCharacters: LOCAL_DIAGNOSTICS_MAX_TEXT,
      boundedPreview: true,
    },
    version: options.version ?? "unknown",
    platform: process.platform,
    architecture: process.arch,
    node: { version: process.versions.node },
    terminal: {
      stdinTTY: tty(process.stdin.isTTY),
      stdoutTTY: tty(process.stdout.isTTY),
      stderrTTY: tty(process.stderr.isTTY),
      columns: process.stdout.columns,
      rows: process.stdout.rows,
    },
    session: {
      id: document.header.sessionId,
      revision: document.revision,
      entryCount: document.entries.length,
    },
    configuration: diagnosticsConfiguration(options.configuration),
    context: context
      ? {
          contextWindow: context.contextWindow,
          permissionMode: context.permissionMode,
          memoryEnabled: context.memoryEnabled,
          coordinatorEnabled: context.coordinatorEnabled,
          schemaGeneration: context.schemaGeneration,
          toolCount: context.toolCount,
          purpose: context.purpose,
        }
      : undefined,
    errors: options.errors,
    statistics: options.statistics,
    ...(options.includeTranscript === true
      ? {
          transcript: active
            .slice(-LOCAL_DIAGNOSTICS_MAX_ITEMS)
            .map((entry) => entry.message),
          transcriptOmittedEntries: Math.max(
            0,
            active.length - LOCAL_DIAGNOSTICS_MAX_ITEMS,
          ),
        }
      : {}),
  };
  return collectSessionString(
    sessionUtf8Chunks(
      sessionJsonParts(boundedDiagnostics(report), true),
      LOCAL_DIAGNOSTICS_MAX_BYTES,
    ),
  );
}
export function sessionTransferContext(
  cwd: string,
  document: SessionDocument,
  persistent: boolean,
): SessionTransferContext {
  const directory = getSessionArtifactsDir(document.header.sessionId);
  return {
    cwd,
    ...(persistent && existsSync(directory)
      ? { artifactDirectory: directory }
      : {}),
  };
}
