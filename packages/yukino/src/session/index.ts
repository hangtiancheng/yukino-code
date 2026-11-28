import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  listProjects,
  registerProject,
  type InputEntry,
} from "@/history/index.js";
import { createChildLogger } from "@/logger/index.js";
import {
  COMPACT_BOUNDARY,
  FIRST_MESSAGE_PREVIEW_CHARS,
  INPUT_SESSION_MISMATCH,
  SESSION_FILE_EXTENSION,
} from "@/session/constants.js";
import {
  appendTranscriptMessage,
  getEntryPath,
  getSessionFilePath,
  hydrateMessage,
  readSessionDocument,
  type CompactBoundaryPayload,
  type SessionEntry,
  type SessionMessage,
  type SessionMetadata,
} from "@/session/records.js";
import { getSessionsDir } from "@/storage/index.js";
import { withFileSyncLock } from "@/teams/file-lock.js";
import { contentToText } from "@/utils/index.js";
import { canonicalPath } from "@/utils/paths.js";

export * from "@/session/actions.js";
export * from "@/session/branch-summary.js";
export * from "@/session/constants.js";
export * from "@/session/file-operations.js";
export * from "@/session/lease.js";
export * from "@/session/maintenance.js";
export * from "@/session/manager.js";
export * from "@/session/organization.js";
export * from "@/session/prompts.js";
export * from "@/session/records.js";
export * from "@/session/restoration.js";
export * from "@/session/stream.js";
export * from "@/session/transfer.js";

export interface SavedUserMessage extends SessionMessage {
  entryId: string;
}
export interface SessionInfo {
  id: string;
  firstMessage: string;
  messageCount: number;
  size: number;
  modTime: Date;
  lastUserMessageTime: Date | null;
  metadata: SessionMetadata;
  error?: string;
}
export interface ProjectSessionInfo extends SessionInfo {
  cwd: string;
  projectKey: string;
}
const log = createChildLogger({ module: "session" });

export function saveMessage(
  cwd: string,
  sessionId: string,
  message: SessionMessage,
): string {
  const entryId = appendTranscriptMessage(
    getSessionFilePath(cwd, sessionId),
    message,
  );
  registerProject(cwd);
  return entryId;
}
export function saveUserMessage(
  cwd: string,
  sessionId: string,
  input: InputEntry,
  message: Omit<SessionMessage, "role" | "timestamp" | "user_input">,
): SavedUserMessage {
  if (input.cwd !== canonicalPath(cwd) || input.sessionId !== sessionId) {
    throw new Error(INPUT_SESSION_MISMATCH);
  }
  const record: SessionMessage = {
    ...message,
    role: "user",
    timestamp: input.timestamp / 1000,
    user_input: { id: input.id, timestamp: input.timestamp },
  };
  return { ...record, entryId: saveMessage(cwd, sessionId, record) };
}
export function saveTranscriptMessage(
  filePath: string,
  message: SessionMessage,
  expectedRevision?: number,
): string {
  return appendTranscriptMessage(filePath, message, expectedRevision);
}
export function saveCompactBoundary(
  cwd: string,
  sessionId: string,
  payload: CompactBoundaryPayload,
): string {
  const entryId = saveTranscriptCompactBoundary(
    getSessionFilePath(cwd, sessionId),
    payload,
  );
  registerProject(cwd);
  return entryId;
}
export function saveTranscriptCompactBoundary(
  filePath: string,
  payload: CompactBoundaryPayload,
): string {
  return appendTranscriptMessage(filePath, {
    role: "system",
    type: COMPACT_BOUNDARY,
    timestamp: Date.now() / 1000,
    content: JSON.stringify(payload),
  });
}
export function loadSession(cwd: string, sessionId: string): SessionMessage[] {
  return loadTranscript(getSessionFilePath(cwd, sessionId));
}
export function loadTranscript(filePath: string): SessionMessage[] {
  if (!existsSync(filePath)) {
    return [];
  }
  return withFileSyncLock(filePath, () => {
    const document = readSessionDocument(filePath);
    return document
      ? getEntryPath(document).map((entry) =>
          hydrateMessage(entry.message, document.artifacts),
        )
      : [];
  });
}
export function loadSessionForResume(
  cwd: string,
  sessionId: string,
): SessionMessage[] {
  return loadSession(cwd, sessionId);
}
/** Raw immutable entries, including inactive branches and pre-compaction history. */
export function loadSessionEntries(
  cwd: string,
  sessionId: string,
): SessionEntry[] {
  const path = getSessionFilePath(cwd, sessionId);
  if (!existsSync(path)) {
    return [];
  }
  return withFileSyncLock(path, () =>
    structuredClone(readSessionDocument(path)?.entries ?? []),
  );
}

export function listSessions(cwd: string): SessionInfo[] {
  const directory = getSessionsDir(cwd);
  if (!existsSync(directory)) {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(SESSION_FILE_EXTENSION),
  )) {
    const path = join(directory, file);
    const id = file.slice(0, -SESSION_FILE_EXTENSION.length);
    try {
      const info = withFileSyncLock(path, (): SessionInfo | null => {
        if (!existsSync(path)) {
          return null;
        }
        const stat = statSync(path);
        const base = { id, size: stat.size, modTime: stat.mtime };
        try {
          const document = readSessionDocument(path);
          if (!document) {
            return null;
          }
          if (document.header.sessionId !== id) {
            throw new Error(
              "Session header identity does not match its filename.",
            );
          }
          const messages = getEntryPath(document).map((entry) => entry.message);
          const ordinary = messages.filter((message) => !message.type);
          const first = ordinary.find(
            (message) =>
              message.role === "user" &&
              !message.tool_results?.length &&
              message.content.length,
          );
          const timestamps = ordinary
            .filter(
              (message) =>
                message.role === "user" &&
                !message.tool_results?.length &&
                message.user_input,
            )
            .flatMap((message) =>
              message.user_input ? [message.user_input.timestamp] : [],
            );
          return {
            ...base,
            firstMessage: first
              ? contentToText(first.content).slice(
                  0,
                  FIRST_MESSAGE_PREVIEW_CHARS,
                )
              : "",
            messageCount: ordinary.length,
            lastUserMessageTime: timestamps.length
              ? new Date(Math.max(...timestamps))
              : null,
            metadata: structuredClone(document.metadata),
          };
        } catch (error) {
          log.error(
            { err: error, filePath: path },
            "Session is unavailable; original file preserved",
          );
          return {
            ...base,
            firstMessage: "",
            messageCount: 0,
            lastUserMessageTime: null,
            metadata: {},
            error: error instanceof Error ? error.message : "Invalid session",
          };
        }
      });
      if (info) {
        sessions.push(info);
      }
    } catch (error) {
      log.error({ err: error, filePath: path }, "Session listing failed");
    }
  }
  return sessions.sort(compareSessions);
}
function compareSessions(a: SessionInfo, b: SessionInfo): number {
  return (
    (b.lastUserMessageTime?.getTime() ?? -1) -
      (a.lastUserMessageTime?.getTime() ?? -1) || a.id.localeCompare(b.id)
  );
}
export function listAllSessions(): ProjectSessionInfo[] {
  const sessions = listProjects().flatMap((project) =>
    listSessions(project.cwd).map((session) => ({
      ...session,
      cwd: project.cwd,
      projectKey: project.projectKey,
    })),
  );
  return sessions.sort(
    (a, b) => compareSessions(a, b) || a.projectKey.localeCompare(b.projectKey),
  );
}
