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

import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import z, { parse, safeParse } from "zod";

import { buildCompactionSummaryMessage } from "@/compact/prompts.js";
import type { ToolResultBlock } from "@/conversation/index.js";
import { createChildLogger } from "@/logger/index.js";
import {
  normalizeToolResultContentBlock,
  type ToolResultContentBlock,
} from "@/tools/types.js";
import { contentToText } from "@/utils/index.js";

// Persistent session lines. Ordinary messages have an empty `type`, while compaction boundary records
// have the type COMPACT_BOUNDARY. Their `content` is the JSON-serialized CompactBoundaryPayload
// (containing a summary and the retained recent tail messages).
// Inlining the retained tail directly into the boundary record avoids "physical location" issues:
// during restoration, reading the boundary is sufficient to reconstruct
// [summary] + retained messages + messages appended after the boundary, without needing to search
// for the retained messages in the area preceding the boundary.
export const COMPACT_BOUNDARY = "compact_boundary";

/** Session expiry days. Session files older than this will be automatically cleaned up. */
const SESSION_EXPIRY_DAYS = 30;

// Tool block fields on disk always use snake_case; the in-memory conversation layer still uses camelCase.
// The conversion between the two is consolidated in boundary functions in this file (toolUsesToRecords / toRestored, etc.).

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

const SessionMessageSchema = z.object({
  role: z.string(),
  content: ContentSchema.default(""),
  timestamp: z.number(),
  type: z.string().optional(),
  tool_uses: z.array(ToolUseRecordSchema).optional(),
  tool_results: z.array(ToolResultRecordSchema).optional(),
});

export type SessionMessage = z.infer<typeof SessionMessageSchema>;

// A recent message preserved verbatim when compaction occurs. Like SessionMessage, it carries tool blocks
// so that the tool call chain remains intact when the session is restored after compaction.
const KeptMessageSchema = z.object({
  role: z.string(),
  content: ContentSchema,
  tool_uses: z.array(ToolUseRecordSchema).optional(),
  tool_results: z.array(ToolResultRecordSchema).optional(),
});

export type KeptMessage = z.infer<typeof KeptMessageSchema>;

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

function sessionsDir(workDir: string): string {
  return join(workDir, ".yukino", "sessions");
}

export function getSessionFilePath(workDir: string, sessionId: string): string {
  return join(sessionsDir(workDir), sessionId + ".jsonl");
}

export function newSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export function saveMessage(
  workDir: string,
  sessionId: string,
  msg: SessionMessage,
): void {
  const dir = sessionsDir(workDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  const line = JSON.stringify(msg) + "\n";
  writeFileSync(filePath, line, { flag: /* append */ "a", encoding: "utf-8" });
}

// Append a compaction boundary to the session. The summary and the verbatim
// kept tail are inlined into one COMPACT_BOUNDARY record. This is append-only:
// the pre-boundary original messages stay in the file (they just won't be
// replayed on resume — see rebuildFromSession).
export function saveCompactBoundary(
  workDir: string,
  sessionId: string,
  payload: CompactBoundaryPayload,
): void {
  saveMessage(workDir, sessionId, {
    role: "system",
    content: JSON.stringify(payload),
    timestamp: Math.floor(Date.now() / 1000),
    type: COMPACT_BOUNDARY,
  });
}

export function loadSession(
  workDir: string,
  sessionId: string,
): SessionMessage[] {
  const filePath = join(sessionsDir(workDir), `${sessionId}.jsonl`);
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
      const { success, data, error } = safeParse(SessionMessageSchema, message);
      // Boundary records carry their text payload in `content`, so keep them
      // (they pass the non-empty content check). Skip malformed or
      // empty-content ordinary messages rather than crashing the load.
      if (success) {
        const isEmpty =
          data.content.length === 0 && // empty text or content blocks
          !(data.tool_uses?.length ?? 0) && // empty tool uses
          !(data.tool_results?.length ?? 0); // empty tool results
        if (!isEmpty) {
          out.push(data);
        }
      } else {
        log.error({ err: error }, "session operation failed");
      }
    } catch (err) {
      log.error({ err }, "session operation failed");
      // skip malformed line
    }
  }
  return out;
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
//   - If the session contains at least one compact_boundary, take the LAST one
//     and rebuild: [summary as a user message] + its inlined keep tail +
//     every ordinary message appended AFTER that boundary. The original
//     messages before the boundary stay in the file but are NOT replayed —
//     that's the whole point of compaction surviving a resume.
//   - If there is no boundary (old sessions, or never compacted), replay every
//     ordinary message verbatim. Fully backward-compatible.
export function rebuildFromSession(saved: SessionMessage[]): RestoredMessage[] {
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
        if (
          (k.role !== "user" && k.role !== "assistant") ||
          (k.content.length === 0 && // empty text or content blocks
            !(k.tool_uses?.length ?? 0) && // empty tool uses
            !(k.tool_results?.length ?? 0)) // empty tool results
        ) {
          continue;
        }

        out.push({
          role: k.role,
          content: k.content,
          toolUses: recordsToCamelUses(k.tool_uses),
          toolResults: recordsToCamelResults(k.tool_results),
        });
      }
    }
    // Replay ordinary messages appended after the boundary (continuation turns).
    for (let i = lastBoundary + 1; i < saved.length; i++) {
      const m = saved[i];
      if (m.type === COMPACT_BOUNDARY) {
        continue;
      } // defensive; the backward scan above already located the last boundary
      const restored = toRestored(m);
      if (restored) {
        out.push(restored);
      }
    }
    return out;
  }

  // No boundary → full replay (backward compatible).
  for (const m of saved) {
    if (m.type === COMPACT_BOUNDARY) {
      continue;
    }
    const restored = toRestored(m);
    if (restored) {
      out.push(restored);
    }
  }
  return out;
}

// Restore a single persisted record into a replayable message, including its tool blocks.
// Messages containing only tool results have no text but must still be restored, otherwise the call chain breaks.
function toRestored(m: SessionMessage): RestoredMessage | null {
  if (m.role !== "user" && m.role !== "assistant") {
    return null;
  }
  if (
    m.content.length === 0 &&
    !(m.tool_uses?.length ?? 0) && // empty tool uses
    !(m.tool_results?.length ?? 0) // empty tool results
  ) {
    return null;
  }
  return {
    role: m.role,
    content: m.content,
    toolUses: recordsToCamelUses(m.tool_uses),
    toolResults: recordsToCamelResults(m.tool_results),
  };
}

// Session directories already swept in this process. Expired-session cleanup
// piggybacks on the first listSessions call per directory, so every entry
// mode (UI resume picker, ACP, remote server, memory consolidation) gets a
// sweep without separate startup wiring. The sweep only touches files whose
// mtime is older than SESSION_EXPIRY_DAYS, so concurrent processes sharing a
// workDir are safe.
const sweptSessionDirs = new Set<string>();

export function listSessions(workDir: string): SessionInfo[] {
  const dir = sessionsDir(workDir);
  if (!sweptSessionDirs.has(dir)) {
    sweptSessionDirs.add(dir);
    cleanExpiredSessions(workDir);
  }
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    const id = file.replace(".jsonl", "");

    let firstMessage = "";
    let messageCount = 0;
    try {
      for (const line of readFileSync(filePath, "utf-8").split("\n")) {
        if (!line.trim()) {
          continue;
        }
        let m: SessionMessage;
        try {
          const raw: unknown = JSON.parse(line);
          m = parse(SessionMessageSchema, raw);
        } catch (err) {
          log.error({ err }, "session operation failed");
          continue;
        }
        messageCount++;
        // Label the session by its first user message (untruncated role match).
        if (!firstMessage && m.role === "user" && m.content) {
          firstMessage = contentToText(m.content).slice(0, 100);
        }
      }
    } catch (err2) {
      log.error({ err: err2 }, "session operation failed");
      continue;
    }

    sessions.push({
      id,
      firstMessage,
      messageCount,
      size: stat.size,
      modTime: stat.mtime,
    });
  }

  sessions.sort((a, b) => b.modTime.getTime() - a.modTime.getTime());
  return sessions;
}

/**
 * Cleans up expired sessions: deletes .jsonl files whose last modified time
 * exceeds SESSION_EXPIRY_DAYS, together with each session's subdirectory
 * (which holds the tool-results spill files written by spillDir()), to
 * prevent the session directory from growing indefinitely.
 * Invoked lazily by listSessions (once per process per sessions directory).
 * Silently skips failures (best-effort).
 */
export function cleanExpiredSessions(workDir: string): number {
  const dir = sessionsDir(workDir);
  if (!existsSync(dir)) {
    return 0;
  }

  const now = Date.now();
  const expiryMs = SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    log.error({ err }, "session operation failed");
    return 0;
  }

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > expiryMs) {
        unlinkSync(filePath);
        // Remove the session's subdirectory in one recursive pass: it holds
        // the tool-results spill files written by spillDir() (note the
        // hyphenated directory name), so a single rm covers both.
        const id = file.replace(".jsonl", "");
        try {
          rmSync(join(dir, id), { recursive: true, force: true });
        } catch {
          /** noop */
        }
        removed++;
      }
    } catch (err) {
      log.error({ err }, "session operation failed");
      // Silently skip if deletion fails
    }
  }
  return removed;
}
