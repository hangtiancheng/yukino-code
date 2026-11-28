import { useInput } from "ink";
import { useMemo, useState } from "react";

import {
  sessionTreeRows,
  updateSessionTreeOptions,
  type SessionTreeOptions,
} from "@/session/actions.js";
import {
  MAX_SESSION_SEARCH_CHARS,
  SESSION_TREE_FILTERS,
} from "@/session/constants.js";
import { sessionSearchTerms } from "@/session/organization.js";
import type { SessionTreeNode } from "@/session/records.js";
import { SelectorList, SelectorListRow } from "@/ui/selector-list.js";
import { updateSelectorQuery } from "@/ui/selector-search.js";

export function SessionTreeSelector({
  tree,
  leafId,
  onSelect,
  onCancel,
  options,
  onOptionsChange,
  initialQuery = "",
}: {
  tree: SessionTreeNode[];
  options: SessionTreeOptions;
  onOptionsChange: (options: SessionTreeOptions) => void;
  initialQuery?: string;
  leafId: string | null;
  onSelect: (entryId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [focused, setFocused] = useState(leafId);
  const all = useMemo(() => sessionTreeRows(tree, leafId), [tree, leafId]);
  const rows = useMemo(
    () => sessionTreeRows(tree, leafId, query, options),
    [tree, leafId, query, options],
  );
  const cursor = Math.max(
    0,
    rows.findIndex((row) => row.id === focused),
  );
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.return) {
      const row = rows[cursor];
      if (row) {
        onSelect(row.id);
      }
    } else if (key.leftArrow || key.rightArrow) {
      const row = rows[cursor];
      if (row?.hasChildren) {
        onOptionsChange(
          updateSessionTreeOptions(tree, options, {
            action: key.leftArrow ? "fold" : "unfold",
            entryId: row.id,
            text: "",
          }),
        );
      }
    } else if (key.ctrl && input === "f") {
      const index = SESSION_TREE_FILTERS.indexOf(options.filter ?? "all");
      onOptionsChange({
        ...options,
        filter: SESSION_TREE_FILTERS[(index + 1) % SESSION_TREE_FILTERS.length],
      });
    } else if (key.ctrl && (input === "e" || input === "o")) {
      onOptionsChange(
        updateSessionTreeOptions(tree, options, {
          action: input === "e" ? "fold" : "unfold",
          all: true,
          text: "",
        }),
      );
    } else if (key.ctrl && input === "l") {
      onOptionsChange({ ...options, labeledOnly: !options.labeledOnly });
    } else if (key.upArrow || key.downArrow) {
      const row =
        rows[(cursor + (key.upArrow ? -1 : 1) + rows.length) % rows.length];
      if (row) {
        setFocused(row.id);
      }
    } else {
      const next = updateSelectorQuery(query, input, key).slice(
        0,
        MAX_SESSION_SEARCH_CHARS,
      );
      try {
        sessionSearchTerms(next);
      } catch {
        return;
      }
      setQuery(next);
    }
  });
  return (
    <SelectorList
      title={`Session tree · ${options.filter ?? "all"}${options.labeledOnly ? " · labels + active branch" : ""}`}
      query={query}
      cursor={cursor}
      totalCount={all.length}
      itemCount={rows.length}
      itemHeight={2}
      emptyText="No matching entries"
      hint="Ctrl+F filter · Ctrl+L labels + branch · ←/→ fold · Ctrl+E/O fold/unfold all · Enter navigate · Esc cancel"
    >
      {(start, count, width) =>
        rows
          .slice(start, start + count)
          .map((row, index) => (
            <SelectorListRow
              key={row.id}
              label={`${"  ".repeat(row.depth)}${row.hasChildren ? (row.folded ? "▸" : "▾") : "·"} ${row.label.slice(row.depth * 2)}`}
              detail={`${row.detail}${row.current ? " · current" : row.onCurrentPath ? " · active branch" : ""}`}
              current={row.current}
              focused={start + index === cursor}
              width={width}
            />
          ))
      }
    </SelectorList>
  );
}
