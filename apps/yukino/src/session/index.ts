import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  statSync,
  existsSync,
  unlinkSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

import z, { parse, safeParse } from "zod";

import { buildCompactionSummaryMessage } from "@/compact/prompts.js";
import type {
  Message,
  ThinkingBlock,
  ToolResultBlock,
  UserBashResult,
} from "@/conversation/index.js";
import { createChildLogger } from "@/logger/index.js";
import { getSessionsDir, sessionPath } from "@/storage/paths.js";
import { withFileSyncLock } from "@/teams/file-lock.js";
import {
  normalizeToolResultContentBlock,
  type ToolResultContentBlock,
} from "@/tools/types.js";
import { contentToText } from "@/utils/index.js";

// Persistent session lines. Ordinary messages carry no `type`, while compaction boundary records
// have the type COMPACT_BOUNDARY. Their `content` is the JSON-serialized CompactBoundaryPayload
// (containing a summary and the retained recent tail messages).
// Inlining the retained tail directly into the boundary record avoids "physical location" issues:
// during restoration, reading the boundary is sufficient to reconstruct
// [summary] + retained messages + messages appended after the boundary, without needing to search
// for the retained messages in the area preceding the boundary.
export const COMPACT_BOUNDARY = "compact_boundary";

const SESSION_EXPIRY_DAYS = 30;

// Tool block fields on disk always use snake_case; the in-memory conversation layer still uses camelCase.
// The conversion between the two is consolidated in conversion functions in this file (toolUsesToRecords / toRestored, etc.).

/** Persisted form of a tool invocation. Stores a provider-agnostic internal representation rather than
 *  any vendor-specific wire format, so sessions can be restored even after switching providers. */

const ToolUseRecordSchema = z.object({
  tool_use_id: z.string(),
  tool_name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  provider_item_id: z.string().optional(),
});
export type ToolUseRecord = z.infer<typeof ToolUseRecordSchema>;

/** Message/tool-result content on disk: plain text, or content blocks persisted
 *  verbatim (inline base64 image blocks included). */
const ContentSchema = z.union([
  z.string(),
  z.array(z.record(z.string(), z.unknown())),
]);

/** Persisted form of a tool result, paired with a ToolUseRecord via tool_use_id. */
const ToolResultRecordSchema = z.object({
  tool_use_id: z.string(),
  content: ContentSchema,
  content_blocks: z.array(z.unknown()).optional(),
  is_error: z.boolean().optional(),
});

export type ToolResultRecord = z.infer<typeof ToolResultRecordSchema>;

const ThinkingBlockSchema = z.object({
  thinking: z.string(),
  signature: z.string(),
});

const UserBashResultSchema = z.object({
  command: z.string(),
  output: z.string(),
  isError: z.boolean(),
  elapsed: z.number(),
  status: z.enum(["completed", "failed", "stopped"]),
  excludeFromContext: z.boolean(),
});

const SessionMessageSchema = z.object({
  role: z.string(),
  content: ContentSchema.default(""),
  timestamp: z.number(),
  type: z.string().optional(),
  tool_uses: z.array(ToolUseRecordSchema).optional(),
  tool_results: z.array(ToolResultRecordSchema).optional(),
  thinking_blocks: z.array(ThinkingBlockSchema).optional(),
  user_bash: UserBashResultSchema.optional(),
});

export type SessionMessage = z.infer<typeof SessionMessageSchema>;

// A recent message preserved verbatim when compaction occurs. Like SessionMessage, it carries tool blocks
// so that the tool call chain remains intact when the session is restored after compaction.
const KeptMessageSchema = z.object({
  role: z.string(),
  content: ContentSchema,
  tool_uses: z.array(ToolUseRecordSchema).optional(),
  tool_results: z.array(ToolResultRecordSchema).optional(),
  thinking_blocks: z.array(ThinkingBlockSchema).optional(),
  user_bash: UserBashResultSchema.optional(),
});

export type KeptMessage = z.infer<typeof KeptMessageSchema>;

export function messageToKeptRecord(message: Message): KeptMessage {
  return {
    role: message.role,
    content: message.content,
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

/** Conversation-layer tool blocks (camelCase) → persisted records (snake_case); empty values are omitted. */
export function toolUsesToRecords(
  toolUses?: {
    toolUseId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    providerItemId?: string;
  }[],
): ToolUseRecord[] {
  return (toolUses ?? []).map((tu) => ({
    tool_use_id: tu.toolUseId,
    tool_name: tu.toolName,
    ...(tu.arguments && Object.keys(tu.arguments).length
      ? { arguments: tu.arguments }
      : {}),
    ...(tu.providerItemId ? { provider_item_id: tu.providerItemId } : {}),
  }));
}

export function toolResultsToRecords(
  toolResults?: ToolResultBlock[],
): ToolResultRecord[] {
  return (toolResults ?? []).map((tr) => ({
    tool_use_id: tr.toolUseId,
    content: tr.content,
    ...(tr.contentBlocks?.length ? { content_blocks: tr.contentBlocks } : {}),
    ...(tr.isError ? { is_error: true } : {}),
  }));
}

const CompactBoundaryPayloadSchema = z.object({
  summary: z.string(),
  keep: z.array(KeptMessageSchema),
});

// Structured payload serialized into a compact_boundary record's `content`.
export type CompactBoundaryPayload = z.infer<
  typeof CompactBoundaryPayloadSchema
>;

export interface SessionInfo {
  id: string;
  firstMessage: string;
  messageCount: number;
  size: number;
  modTime: Date;
}

const log = createChildLogger({ module: "session" });

export function getSessionArtifactsDir(sessionId: string): string {
  return sessionPath(sessionId);
}

export function getSessionFilePath(cwd: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) {
    throw new Error("Invalid session ID");
  }
  return join(getSessionsDir(cwd), sessionId + ".jsonl");
}

export function newSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export function saveMessage(
  cwd: string,
  sessionId: string,
  msg: SessionMessage,
): void {
  saveTranscriptMessage(getSessionFilePath(cwd, sessionId), msg);
}

export function saveTranscriptMessage(
  filePath: string,
  msg: SessionMessage,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const line = JSON.stringify(msg) + "\n";
  withFileSyncLock(filePath, () => {
    writeFileSync(filePath, line, {
      flag: /* append */ "a",
      encoding: "utf-8",
    });
  });
}

// Append a compaction boundary to the session. The summary and the verbatim
// kept tail are inlined into one COMPACT_BOUNDARY record. This is append-only:
// the pre-boundary original messages stay in the file (they just won't be
// replayed on resume — see rebuildFromSession).
export function saveCompactBoundary(
  cwd: string,
  sessionId: string,
  payload: CompactBoundaryPayload,
): void {
  saveTranscriptCompactBoundary(getSessionFilePath(cwd, sessionId), payload);
}

export function saveTranscriptCompactBoundary(
  filePath: string,
  payload: CompactBoundaryPayload,
): void {
  saveTranscriptMessage(filePath, {
    role: "system",
    content: JSON.stringify(payload),
    timestamp: Math.floor(Date.now() / 1000),
    type: COMPACT_BOUNDARY,
  });
}

/** Count the non-empty lines of a session log; undefined when it doesn't exist. */
export function sessionLineCount(filePath: string): number | undefined {
  if (!filePath || !existsSync(dirname(filePath))) {
    return undefined;
  }
  return withFileSyncLock(filePath, () => {
    if (!existsSync(filePath)) {
      return undefined;
    }
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  });
}

/**
 * Truncate a session log to its first `keepLines` non-empty lines.
 *
 * /rewind persists a conversation rewind by cutting the log at the line count
 * captured in the snapshot. Line coordinates survive resume and compaction
 * (unlike in-memory message indexes), so replaying the truncated log — via
 * rebuildFromSession — reconstructs exactly the rewound conversation.
 */
export function truncateSessionLines(
  filePath: string,
  keepLines: number,
): void {
  if (!filePath || !existsSync(dirname(filePath))) {
    return;
  }
  withFileSyncLock(filePath, () => {
    if (!existsSync(filePath)) {
      return;
    }
    const kept: string[] = [];
    for (const line of readFileSync(filePath, "utf-8").split("\n")) {
      if (kept.length >= keepLines) {
        break;
      }
      if (line.trim().length > 0) {
        kept.push(line);
      }
    }
    const tmp = `${filePath}.${String(process.pid)}.rewind-tmp`;
    try {
      writeFileSync(
        tmp,
        kept.length > 0 ? kept.join("\n") + "\n" : "",
        "utf-8",
      );
      renameSync(tmp, filePath);
    } finally {
      rmSync(tmp, { force: true });
    }
  });
}

export function loadSession(cwd: string, sessionId: string): SessionMessage[] {
  return loadTranscript(getSessionFilePath(cwd, sessionId));
}

export function loadTranscript(filePath: string): SessionMessage[] {
  if (!existsSync(dirname(filePath))) {
    return [];
  }

  return withFileSyncLock(filePath, () => {
    if (!existsSync(filePath)) {
      return [];
    }

    const out: SessionMessage[] = [];
    for (const line of readFileSync(filePath, "utf-8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const message: unknown = JSON.parse(line);
        const { success, data, error } = safeParse(
          SessionMessageSchema,
          message,
        );
        // Boundary records carry their text payload in `content`, so keep them
        // (they pass the non-empty content check). Skip malformed or
        // empty-content ordinary messages rather than crashing the load.
        if (success) {
          const isEmpty =
            data.content.length === 0 &&
            !(data.tool_uses?.length ?? 0) &&
            !(data.tool_results?.length ?? 0) &&
            !(data.thinking_blocks?.length ?? 0);
          if (!isEmpty) {
            out.push(data);
          }
        } else {
          log.error({ err: error }, "session operation failed");
        }
      } catch (err) {
        log.error({ err }, "session operation failed");
      }
    }
    try {
      const now = new Date();
      utimesSync(filePath, now, now);
    } catch {
      // The session may be removed externally after a successful read.
    }
    return out;
  });
}

/**
 * Marks a session as recently active by refreshing its mtime. Session writes,
 * loads, rewinds, touches, and expiry cleanup share the same cross-process lock,
 * so cleanup cannot unlink a session that another process is resuming.
 */
export function touchSession(cwd: string, sessionId: string): void {
  const filePath = getSessionFilePath(cwd, sessionId);
  if (!existsSync(dirname(filePath))) {
    return;
  }
  try {
    withFileSyncLock(filePath, () => {
      if (existsSync(filePath)) {
        const now = new Date();
        utimesSync(filePath, now, now);
      }
    });
  } catch {
    // best-effort — the session may not exist (yet)
  }
}

// A message ready to replay on resume. Boundary records expand into the summary
// (as a synthetic user message) followed by their inlined kept tail; ordinary
// records map 1:1. This is the compacted-state reconstruction.
export interface RestoredMessage {
  role: "user" | "assistant";
  content: string | Record<string, unknown>[];
  // In-memory form uses camelCase, consistent with the conversation layer; converted from snake_case disk records
  toolUses?: {
    toolUseId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    providerItemId?: string;
  }[];
  toolResults?: ToolResultBlock[];
  thinkingBlocks?: ThinkingBlock[];
  userBash?: UserBashResult;
}

/** Persisted records (snake_case) → in-memory tool blocks (camelCase), used to restore the call chain on session resume. */
function recordsToCamelUses(recs?: ToolUseRecord[]) {
  return recs?.map((tu) => ({
    toolUseId: tu.tool_use_id,
    toolName: tu.tool_name,
    arguments: tu.arguments ?? {},
    providerItemId: tu.provider_item_id,
  }));
}

function validContentBlocks(
  value?: unknown[],
): ToolResultContentBlock[] | undefined {
  if (!value) {
    return undefined;
  }
  const blocks: ToolResultContentBlock[] = [];
  for (const raw of value) {
    const block = normalizeToolResultContentBlock(raw);
    if (block) {
      blocks.push(block);
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

function recordsToCamelResults(
  recs?: ToolResultRecord[],
): ToolResultBlock[] | undefined {
  return recs?.map((tr) => {
    const legacyBlocks = Array.isArray(tr.content)
      ? validContentBlocks(tr.content)
      : undefined;
    const contentBlocks = validContentBlocks(tr.content_blocks) ?? legacyBlocks;
    return {
      toolUseId: tr.tool_use_id,
      content:
        typeof tr.content === "string" ? tr.content : contentToText(tr.content),
      ...(contentBlocks ? { contentBlocks } : {}),
      isError: tr.is_error ?? false,
    };
  });
}

// Rebuild the conversation to replay on resume, honoring compaction boundaries.
//
//   - If the session contains at least one compact_boundary, take the last
//     VALID one and rebuild: [summary as a user message] + its inlined keep
//     tail + every ordinary message appended AFTER that boundary. The original
//     messages before the boundary stay in the file but are NOT replayed —
//     that's the whole point of compaction surviving a resume.
//   - If there is no boundary, replay every ordinary message verbatim.
export function rebuildFromSession(
  saved: SessionMessage[],
  options: { includeExcludedUserBash?: boolean } = {},
): RestoredMessage[] {
  // A damaged boundary must not discard the only recoverable history. Walk
  // back to the last valid boundary, or replay ordinary messages if none exist.
  let lastBoundary = -1;
  let payload: CompactBoundaryPayload | null = null;
  for (let i = saved.length - 1; i >= 0; i--) {
    if (saved[i].type === COMPACT_BOUNDARY) {
      try {
        const raw = saved[i].content;
        const parsed: unknown =
          typeof raw === "string" ? JSON.parse(raw) : null;
        const boundary = CompactBoundaryPayloadSchema.safeParse(parsed);
        if (boundary.success && boundary.data.summary.trim()) {
          payload = boundary.data;
          lastBoundary = i;
          break;
        }
      } catch {
        /* Ignore this damaged boundary and try the previous one. */
      }
    }
  }

  const out: RestoredMessage[] = [];

  if (lastBoundary >= 0) {
    // Compacted state: summary + inlined keep, then post-boundary appends.
    if (payload) {
      out.push({
        role: "user",
        content: buildCompactionSummaryMessage(
          payload.summary,
          payload.keep.length > 0,
        ),
      });
      for (const k of payload.keep) {
        const restored = toRestored(k, options.includeExcludedUserBash);
        if (restored) {
          out.push(restored);
        }
      }
    }
    // Replay ordinary messages appended after the boundary (continuation turns).
    for (let i = lastBoundary + 1; i < saved.length; i++) {
      const m = saved[i];
      if (m.type === COMPACT_BOUNDARY) {
        continue;
      } // required: boundary records trailing the last VALID one are damaged/empty-summary records the backward scan passed over
      const restored = toRestored(m, options.includeExcludedUserBash);
      if (restored) {
        out.push(restored);
      }
    }
    return out;
  }

  // No boundary → full replay.
  for (const m of saved) {
    if (m.type === COMPACT_BOUNDARY) {
      continue;
    }
    const restored = toRestored(m, options.includeExcludedUserBash);
    if (restored) {
      out.push(restored);
    }
  }
  return out;
}

// Restore a single persisted record into a replayable message, including its tool blocks.
// Messages containing only tool results have no text but must still be restored, otherwise the call chain breaks.
function toRestored(
  m: KeptMessage,
  includeExcludedUserBash = false,
): RestoredMessage | null {
  if (m.user_bash?.excludeFromContext && !includeExcludedUserBash) {
    return null;
  }
  if (m.role !== "user" && m.role !== "assistant") {
    return null;
  }
  if (
    m.content.length === 0 &&
    !(m.tool_uses?.length ?? 0) &&
    !(m.tool_results?.length ?? 0) &&
    !(m.thinking_blocks?.length ?? 0)
  ) {
    return null;
  }
  return {
    role: m.role,
    content: m.content,
    ...(m.user_bash ? { userBash: m.user_bash } : {}),
    toolUses: recordsToCamelUses(m.tool_uses),
    toolResults: recordsToCamelResults(m.tool_results),
    ...(m.role === "assistant" && m.thinking_blocks?.length
      ? { thinkingBlocks: m.thinking_blocks }
      : {}),
  };
}

// Session directories already swept in this process. Expired-session cleanup
// piggybacks on the first listSessions call per directory, so every entry
// mode (UI resume picker, ACP, remote server, memory consolidation) gets a
// sweep without separate startup wiring. The sweep only touches files whose
// mtime is older than SESSION_EXPIRY_DAYS; a session actively used by a
// concurrent process keeps its mtime fresh via appends and is left alone.
const sweptSessionDirs = new Set<string>();

export function listSessions(cwd: string): SessionInfo[] {
  const dir = getSessionsDir(cwd);
  if (!sweptSessionDirs.has(dir)) {
    sweptSessionDirs.add(dir);
    cleanExpiredSessions(cwd);
  }
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const info = withFileSyncLock(filePath, (): SessionInfo | null => {
        if (!existsSync(filePath)) {
          return null;
        }
        const stat = statSync(filePath);
        const id = file.replace(".jsonl", "");
        let firstMessage = "";
        let messageCount = 0;

        for (const line of readFileSync(filePath, "utf-8").split("\n")) {
          if (!line.trim()) {
            continue;
          }
          let message: SessionMessage;
          try {
            const raw: unknown = JSON.parse(line);
            message = parse(SessionMessageSchema, raw);
          } catch (err) {
            log.error({ err }, "session operation failed");
            continue;
          }
          if (message.type === "goal_state") {
            continue;
          }
          messageCount++;
          if (!firstMessage && message.role === "user" && message.content) {
            firstMessage = contentToText(message.content).slice(0, 100);
          }
        }

        return {
          id,
          firstMessage,
          messageCount,
          size: stat.size,
          modTime: stat.mtime,
        };
      });
      if (info) {
        sessions.push(info);
      }
    } catch (err) {
      log.error({ err }, "session operation failed");
    }
  }

  sessions.sort((a, b) => b.modTime.getTime() - a.modTime.getTime());
  return sessions;
}

/**
 * Cleans up expired sessions: deletes .jsonl files whose last modified time
 * exceeds SESSION_EXPIRY_DAYS, together with their artifacts (tool results,
 * shell output, file snapshots, clipboard images, and private tasks), to prevent
 * on-disk session state from growing indefinitely.
 * Invoked lazily by listSessions (once per process per sessions directory).
 * Failures are logged and skipped (best-effort).
 */
export function cleanExpiredSessions(cwd: string): number {
  const dir = getSessionsDir(cwd);
  if (!existsSync(dir)) {
    return 0;
  }

  const now = Date.now();
  const expiryMs = SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  let files: string[];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.endsWith(".rewind-tmp")) {
        rmSync(join(dir, entry), { force: true });
      }
    }
    files = entries.filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    log.error({ err }, "session operation failed");
    return 0;
  }

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      withFileSyncLock(filePath, () => {
        if (!existsSync(filePath)) {
          return;
        }
        const stat = statSync(filePath);
        if (now - stat.mtimeMs <= expiryMs) {
          return;
        }
        unlinkSync(filePath);
        const id = file.replace(".jsonl", "");
        try {
          rmSync(getSessionArtifactsDir(id), {
            recursive: true,
            force: true,
          });
        } catch {
          /** noop */
        }
        removed++;
      });
    } catch (err) {
      log.error({ err }, "session operation failed");
    }
  }
  return removed;
}
