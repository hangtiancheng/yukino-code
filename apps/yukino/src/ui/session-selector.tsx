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

import Fuse from "fuse.js";
import { useInput } from "ink";
import { useMemo, useState } from "react";

import { SelectorList, SelectorListRow } from "./selector-list.js";
import { updateSelectorQuery } from "./selector-search.js";

import type { SessionInfo } from "@/session/index.js";

interface SessionSelectorProps {
  currentSessionId?: string;
  reservedRows?: number;
  sessions: SessionInfo[];
  onCancel: () => void;
  onSelect: (sessionId: string) => void;
}

export function SessionSelector({
  currentSessionId,
  reservedRows,
  sessions,
  onCancel,
  onSelect,
}: SessionSelectorProps) {
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState(currentSessionId);
  const fuse = useMemo(
    () =>
      new Fuse(sessions, {
        keys: ["id", "firstMessage"],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [sessions],
  );
  const matches = useMemo(
    () =>
      query.trim()
        ? fuse.search(query.trim()).map(({ item }) => item)
        : sessions,
    [fuse, query, sessions],
  );
  const cursor = Math.max(
    0,
    matches.findIndex((session) => session.id === focusedId),
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.upArrow || key.downArrow) {
      if (matches.length > 0) {
        const next =
          (cursor + (key.upArrow ? -1 : 1) + matches.length) % matches.length;
        setFocusedId(matches[next].id);
      }
    } else if (key.return) {
      const session = matches.at(cursor);
      if (session) {
        onSelect(session.id);
      }
    } else {
      const nextQuery = updateSelectorQuery(query, input, key);
      if (nextQuery !== query) {
        setQuery(nextQuery);
        setFocusedId(nextQuery.trim() ? undefined : currentSessionId);
      }
    }
  });

  return (
    <SelectorList
      cursor={cursor}
      emptyText={query.trim() ? "No matching sessions" : "No saved sessions"}
      hint="↑↓ navigate · Enter resume · Esc cancel · Ctrl+U clear"
      itemCount={matches.length}
      itemHeight={2}
      query={query}
      title="Resume session"
      totalCount={sessions.length}
      reservedRows={reservedRows}
    >
      {(start, count, width) =>
        matches
          .slice(start, start + count)
          .map((session, index) => (
            <SelectorListRow
              key={session.id}
              current={session.id === currentSessionId}
              detail={`${session.id} · ${String(session.messageCount)} messages · ${formatRelativeTime(session.modTime)}`}
              focused={start + index === cursor}
              label={session.firstMessage || "(empty session)"}
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
