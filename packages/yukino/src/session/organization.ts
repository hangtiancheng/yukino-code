import {
  MAX_METADATA_TEXT,
  MAX_SESSION_SEARCH_CHARS,
  MAX_SESSION_SEARCH_TERMS,
  MAX_SESSION_TAGS,
  SESSION_FILTER_EMPTY_VALUE,
  SESSION_FILTER_PREFIXES,
  SESSION_INVALID_TAGS,
  SESSION_NAME_ELLIPSIS,
  SESSION_NAME_MAX_GRAPHEMES,
  SESSION_NAME_MAX_INPUT_CHARS,
  SESSION_NAME_SURROGATE_RE,
  SESSION_NAME_WHITESPACE_RE,
  SESSION_PICKER_ARCHIVED_LABEL,
  SESSION_SEARCH_TOO_LONG,
  SESSION_SEARCH_TOO_MANY_TERMS,
  SESSION_SEARCH_WHITESPACE_RE,
  SESSION_TAG_INVALID_RE,
} from "@/session/constants.js";
import type { ProjectSessionInfo } from "@/session/index.js";
import type { SessionManager } from "@/session/manager.js";
import {
  SessionConflictError,
  type SessionMetadata,
} from "@/session/records.js";
import { plainTerminalText } from "@/utils/index.js";
import { canonicalPath } from "@/utils/paths.js";

export interface SessionFilterOptions {
  cwd: string;
  query?: string;
  tags?: readonly string[];
  projectKey?: string;
  allProjects?: boolean;
  includeArchived?: boolean;
}

export interface SessionPickerRow {
  id: string;
  sessionId: string;
  cwd: string;
  projectKey: string;
  label: string;
  detail: string;
  tags: string[];
  archived: boolean;
}

export interface SessionNameSuggestionPreview {
  readonly name: string;
  readonly token: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly revision: number;
    readonly currentName: string | null;
  };
}

export function normalizeSessionSearchText(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

export function sessionSearchTerms(query: string): string[] {
  if (query.length > MAX_SESSION_SEARCH_CHARS) {
    throw new Error(SESSION_SEARCH_TOO_LONG);
  }
  const terms = normalizeSessionSearchText(query)
    .trim()
    .split(SESSION_SEARCH_WHITESPACE_RE)
    .filter(Boolean);
  if (terms.length > MAX_SESSION_SEARCH_TERMS) {
    throw new Error(SESSION_SEARCH_TOO_MANY_TERMS);
  }
  return terms;
}

function normalizeTags(tags: readonly string[]): string[] {
  if (tags.length > MAX_SESSION_TAGS) {
    throw new Error(SESSION_INVALID_TAGS);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const text = tag.trim().normalize("NFC");
    if (
      !text ||
      text.length > MAX_METADATA_TEXT ||
      SESSION_TAG_INVALID_RE.test(text)
    ) {
      throw new Error(SESSION_INVALID_TAGS);
    }
    const key = normalizeSessionSearchText(text);
    if (!seen.has(key)) {
      normalized.push(text);
      seen.add(key);
    }
  }
  return normalized;
}

export function setSessionTags(
  manager: SessionManager,
  tags: readonly string[],
): SessionMetadata {
  const normalized = normalizeTags(tags);
  manager.refresh();
  const metadata = manager.getMetadata();
  if (
    metadata.tags?.length === normalized.length &&
    metadata.tags.every((tag, index) => tag === normalized[index])
  ) {
    return metadata;
  }
  const next = { ...metadata, tags: normalized };
  manager.setMetadata(next);
  return next;
}

export function filterSessions<T extends ProjectSessionInfo>(
  sessions: readonly T[],
  options: SessionFilterOptions,
): T[] {
  const terms = sessionSearchTerms(options.query ?? "");
  for (const prefix of Object.values(SESSION_FILTER_PREFIXES)) {
    if (terms.includes(prefix)) {
      throw new Error(SESSION_FILTER_EMPTY_VALUE);
    }
  }
  const tags = normalizeTags(options.tags ?? []).map(
    normalizeSessionSearchText,
  );
  const cwd = canonicalPath(options.cwd);
  return sessions.filter((session) => {
    if (
      session.messageCount === 0 &&
      !session.firstMessage &&
      !session.error &&
      !session.metadata.name &&
      !session.metadata.tags?.length &&
      session.metadata.archived !== true
    ) {
      return false;
    }
    if (session.metadata.archived && !options.includeArchived) {
      return false;
    }
    if (options.projectKey) {
      if (session.projectKey !== options.projectKey) {
        return false;
      }
    } else if (!options.allProjects && canonicalPath(session.cwd) !== cwd) {
      return false;
    }
    const name = normalizeSessionSearchText(session.metadata.name ?? "");
    const sessionTags = (session.metadata.tags ?? []).map(
      normalizeSessionSearchText,
    );
    if (!tags.every((tag) => sessionTags.includes(tag))) {
      return false;
    }
    const project = normalizeSessionSearchText(
      `${session.cwd} ${session.projectKey}`,
    );
    const searchable = normalizeSessionSearchText(
      `${session.id} ${session.firstMessage} ${name} ${sessionTags.join(" ")} ${project}`,
    );
    return terms.every((term) => {
      if (term.startsWith(SESSION_FILTER_PREFIXES.name)) {
        return name.includes(term.slice(SESSION_FILTER_PREFIXES.name.length));
      }
      if (term.startsWith(SESSION_FILTER_PREFIXES.tag)) {
        return sessionTags.includes(
          term.slice(SESSION_FILTER_PREFIXES.tag.length),
        );
      }
      if (term.startsWith(SESSION_FILTER_PREFIXES.project)) {
        return project.includes(
          term.slice(SESSION_FILTER_PREFIXES.project.length),
        );
      }
      return searchable.includes(term);
    });
  });
}

export function sessionPickerRows(
  sessions: readonly ProjectSessionInfo[],
  options: SessionFilterOptions,
): SessionPickerRow[] {
  return filterSessions(sessions, options).map((session) => {
    const tags = [...(session.metadata.tags ?? [])];
    const archived = session.metadata.archived === true;
    return {
      id: `${session.projectKey}:${session.id}`,
      sessionId: session.id,
      cwd: session.cwd,
      projectKey: session.projectKey,
      label:
        session.metadata.name?.trim() || session.firstMessage || session.id,
      detail: [
        session.cwd,
        `${session.messageCount} messages`,
        ...tags.map((tag) => `#${tag}`),
        ...(archived ? [SESSION_PICKER_ARCHIVED_LABEL] : []),
      ].join(" · "),
      tags,
      archived,
    };
  });
}

function suggestedName(manager: SessionManager): string | null {
  const entry = manager
    .getEntries()
    .find(
      ({ message }) =>
        message.role === "user" &&
        message.user_input &&
        !message.type &&
        !message.tool_results?.length &&
        !message.user_bash,
    );
  if (!entry) {
    return null;
  }
  const content = entry.message.content;
  let input = "";
  if (typeof content === "string") {
    input = content.slice(0, SESSION_NAME_MAX_INPUT_CHARS);
  } else {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        const remaining = SESSION_NAME_MAX_INPUT_CHARS - input.length;
        if (remaining <= 0) {
          break;
        }
        const separator = input ? "\n" : "";
        input += separator + block.text.slice(0, remaining - separator.length);
      }
    }
  }
  const text = plainTerminalText(input)
    .replace(SESSION_NAME_SURROGATE_RE, "")
    .normalize("NFC")
    .replace(SESSION_NAME_WHITESPACE_RE, " ")
    .trim();
  if (!text) {
    return null;
  }
  const segments: string[] = [];
  let length = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text)) {
    if (
      segments.length === SESSION_NAME_MAX_GRAPHEMES ||
      length + segment.length > MAX_METADATA_TEXT
    ) {
      while (
        segments.length &&
        (segments.length >= SESSION_NAME_MAX_GRAPHEMES ||
          length + SESSION_NAME_ELLIPSIS.length > MAX_METADATA_TEXT)
      ) {
        length -= segments.pop()?.length ?? 0;
      }
      return segments.length
        ? `${segments.join("").trimEnd()}${SESSION_NAME_ELLIPSIS}`
        : null;
    }
    segments.push(segment);
    length += segment.length;
  }
  return segments.join("");
}

export function previewSessionNameSuggestion(
  manager: SessionManager,
): SessionNameSuggestionPreview | null {
  manager.refresh();
  const metadata = manager.getMetadata();
  if (metadata.name?.trim()) {
    return null;
  }
  const name = suggestedName(manager);
  return name
    ? {
        name,
        token: {
          sessionId: manager.id,
          cwd: manager.cwd,
          revision: manager.revision,
          currentName: metadata.name ?? null,
        },
      }
    : null;
}

export function applySessionNameSuggestion(
  manager: SessionManager,
  preview: SessionNameSuggestionPreview,
): boolean {
  manager.refresh();
  const metadata = manager.getMetadata();
  if (
    manager.id !== preview.token.sessionId ||
    manager.cwd !== preview.token.cwd ||
    manager.revision !== preview.token.revision ||
    (metadata.name ?? null) !== preview.token.currentName ||
    metadata.name?.trim() ||
    suggestedName(manager) !== preview.name
  ) {
    return false;
  }
  try {
    manager.setMetadata({ ...metadata, name: preview.name });
    return true;
  } catch (error) {
    if (error instanceof SessionConflictError) {
      manager.refresh();
      return false;
    }
    throw error;
  }
}
