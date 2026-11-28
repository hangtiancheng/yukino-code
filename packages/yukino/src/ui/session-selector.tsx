import Fuse from "fuse.js";
import { useInput } from "ink";
import { useMemo, useState } from "react";

import {
  MAX_METADATA_TEXT,
  MAX_SESSION_SEARCH_CHARS,
} from "@/session/constants.js";
import type { ProjectSessionInfo } from "@/session/index.js";
import { filterSessions } from "@/session/organization.js";
import { SelectorList, SelectorListRow } from "@/ui/selector-list.js";
import { updateSelectorQuery } from "@/ui/selector-search.js";
import { asErrorString } from "@/utils/format.js";
import { canonicalPath } from "@/utils/paths.js";

interface SessionSelectorProps {
  currentSessionId?: string;
  cwd?: string;
  allProjects?: boolean;
  includeArchived?: boolean;
  initialQuery?: string;
  reservedRows?: number;
  sessions: ProjectSessionInfo[];
  onRename?: (session: ProjectSessionInfo, name: string) => Promise<void>;
  onDelete?: (session: ProjectSessionInfo) => Promise<void>;
  onCancel: () => void;
  onSelect: (sessionId: string, cwd: string) => void;
}

const sessionKey = (session: ProjectSessionInfo) =>
  `${session.projectKey}:${session.id}`;

export function SessionSelector({
  currentSessionId,
  cwd = process.cwd(),
  allProjects = false,
  includeArchived = false,
  initialQuery = "",
  reservedRows,
  sessions,
  onCancel,
  onSelect,
  onRename,
  onDelete,
}: SessionSelectorProps) {
  const projectCwd = useMemo(() => canonicalPath(cwd), [cwd]);
  const isCurrent = (session: ProjectSessionInfo) =>
    session.id === currentSessionId &&
    canonicalPath(session.cwd) === projectCwd;
  const current = sessions.find(isCurrent);
  const [query, setQuery] = useState(initialQuery);
  const [scopeAll, setScopeAll] = useState(allProjects);
  const [archived, setArchived] = useState(includeArchived);
  const [namedOnly, setNamedOnly] = useState(false);
  const [showPath, setShowPath] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [sort, setSort] = useState<"recent" | "modified" | "name">("recent");
  const [dialog, setDialog] = useState<{
    kind: "rename" | "delete";
    session: ProjectSessionInfo;
  }>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focusedId, setFocusedId] = useState(
    current ? sessionKey(current) : undefined,
  );
  const available = useMemo(
    () =>
      filterSessions(sessions, {
        cwd,
        allProjects: scopeAll,
        includeArchived: archived,
      })
        .filter((session) => !namedOnly || !!session.metadata.name?.trim())
        .sort((a, b) => {
          if (sort === "name") {
            return (
              (a.metadata.name || a.firstMessage).localeCompare(
                b.metadata.name || b.firstMessage,
              ) || a.id.localeCompare(b.id)
            );
          }
          if (sort === "modified") {
            return (
              b.modTime.getTime() - a.modTime.getTime() ||
              a.id.localeCompare(b.id)
            );
          }
          return (
            (b.lastUserMessageTime?.getTime() ?? -1) -
              (a.lastUserMessageTime?.getTime() ?? -1) ||
            a.id.localeCompare(b.id)
          );
        }),
    [sessions, cwd, scopeAll, archived, namedOnly, sort],
  );
  const fuse = useMemo(
    () =>
      new Fuse(available, {
        keys: ["id", "firstMessage", "metadata.name", "metadata.tags", "cwd"],
        threshold: 0.35,
        ignoreLocation: true,
        shouldSort: false,
      }),
    [available],
  );
  const matches = useMemo(() => {
    if (/(?:^|\s)(?:name|tag|project):/u.test(query)) {
      try {
        return filterSessions(available, {
          cwd,
          allProjects: scopeAll,
          includeArchived: archived,
          query,
        });
      } catch {
        return [];
      }
    }
    return query.trim()
      ? fuse.search(query.trim()).map(({ item }) => item)
      : available;
  }, [available, cwd, scopeAll, archived, fuse, query]);
  const cursor = Math.max(
    0,
    matches.findIndex((session) => sessionKey(session) === focusedId),
  );

  const submitDialog = (): void => {
    if (!dialog || busy) {
      return;
    }
    setBusy(true);
    setError("");
    void Promise.resolve()
      .then(() =>
        dialog.kind === "rename"
          ? onRename?.(dialog.session, draft.trim())
          : onDelete?.(dialog.session),
      )
      .then(() => {
        setDialog(undefined);
        setError("");
      })
      .catch((cause: unknown) => {
        setError(asErrorString(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (dialog) {
      if (
        key.escape ||
        (dialog.kind === "delete" && input.toLowerCase() === "n")
      ) {
        setDialog(undefined);
        setError("");
      } else if (
        (dialog.kind === "rename" && key.return) ||
        (dialog.kind === "delete" && input.toLowerCase() === "y")
      ) {
        submitDialog();
      } else if (dialog.kind === "rename") {
        setDraft(
          updateSelectorQuery(draft, input, key).slice(0, MAX_METADATA_TEXT),
        );
      }
      return;
    }
    if (key.ctrl && ["a", "x", "n", "p", "s", "r", "d", "k"].includes(input)) {
      setError("");
      if (input === "a") {
        setScopeAll((value) => !value);
      }
      if (input === "x") {
        setArchived((value) => !value);
      }
      if (input === "k") {
        setShowHelp((value) => !value);
      }
      if (input === "n") {
        setNamedOnly((value) => !value);
      }
      if (input === "p") {
        setShowPath((value) => !value);
      }
      if (input === "s") {
        setSort((value) =>
          value === "recent"
            ? "modified"
            : value === "modified"
              ? "name"
              : "recent",
        );
      }
      const session = matches[cursor];
      if (input === "r" && session && onRename) {
        setDraft(session.metadata.name ?? "");
        setDialog({ kind: "rename", session });
      }
      if (input === "d" && session && onDelete) {
        if (isCurrent(session)) {
          setError("Switch away from the current session before deleting it");
        } else {
          setDialog({ kind: "delete", session });
        }
      }
      return;
    }
    if (key.escape) {
      onCancel();
    } else if (key.upArrow || key.downArrow) {
      if (matches.length) {
        const next =
          (cursor + (key.upArrow ? -1 : 1) + matches.length) % matches.length;
        setFocusedId(sessionKey(matches[next]));
      }
    } else if (key.return) {
      const session = matches.at(cursor);
      if (session) {
        onSelect(session.id, session.cwd);
      }
    } else {
      const nextQuery = updateSelectorQuery(query, input, key).slice(
        0,
        MAX_SESSION_SEARCH_CHARS,
      );
      if (nextQuery !== query) {
        setQuery(nextQuery);
        setFocusedId(
          nextQuery.trim()
            ? undefined
            : current
              ? sessionKey(current)
              : undefined,
        );
      }
    }
  });

  return (
    <SelectorList
      cursor={cursor}
      emptyText={query.trim() ? "No matching sessions" : "No saved sessions"}
      hint={
        busy
          ? "Saving…"
          : dialog
            ? dialog.kind === "rename"
              ? "Enter save · Esc cancel · Ctrl+U clear"
              : "Y delete · N/Esc cancel"
            : "↑↓ · Enter resume · Ctrl+R rename · Ctrl+D delete · Ctrl+K help · Esc"
      }
      error={error}
      help={
        showHelp && !dialog
          ? [
              "Ctrl+A scope · Ctrl+S sort · Ctrl+N named",
              "Ctrl+P paths · Ctrl+X archived · Ctrl+K hide help",
              "Search name:/tag:/project: · Ctrl+U clear",
            ]
          : undefined
      }
      subtitle={
        dialog
          ? `${dialog.session.metadata.name || dialog.session.firstMessage || dialog.session.id} · ${dialog.session.cwd}`
          : `${scopeAll ? "All projects" : "This project"} · ${sort} · ${namedOnly ? "named only" : "all names"} · ${archived ? "including archived" : "active"}`
      }
      queryLabel={dialog?.kind === "rename" ? "Name: " : "Search: "}
      queryPlaceholder={
        dialog?.kind === "rename" ? "type a name" : "type to filter"
      }
      searchActive={!busy && dialog?.kind !== "delete"}
      itemCount={matches.length}
      itemHeight={2}
      query={dialog?.kind === "rename" ? draft : query}
      title={
        dialog
          ? `${dialog.kind === "rename" ? "Rename" : "Delete"} session · ${dialog.session.metadata.name || dialog.session.firstMessage || dialog.session.id}`
          : `Resume session${scopeAll ? " · all projects" : ""} · ${sort}${namedOnly ? " · named" : ""}${archived ? " · archived" : ""}`
      }
      totalCount={available.length}
      reservedRows={reservedRows}
    >
      {(start, count, width) =>
        matches
          .slice(start, start + count)
          .map((session, index) => (
            <SelectorListRow
              key={sessionKey(session)}
              current={isCurrent(session)}
              detail={`${session.id} · ${String(session.messageCount)} messages · ${session.lastUserMessageTime ? formatRelativeTime(session.lastUserMessageTime) : "no user messages"}${showPath ? ` · ${session.cwd}` : ""}${session.metadata.tags?.length ? ` · ${session.metadata.tags.map((tag) => `#${tag}`).join(" ")}` : ""}${session.metadata.archived ? " · archived" : ""}`}
              focused={start + index === cursor}
              label={
                session.metadata.name ||
                session.firstMessage ||
                "(empty session)"
              }
              width={width}
            />
          ))
      }
    </SelectorList>
  );
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  return `${String(Math.floor(hours / 24))}d ago`;
}
