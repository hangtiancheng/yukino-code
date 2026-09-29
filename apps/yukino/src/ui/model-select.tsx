import Fuse from "fuse.js";
import { Text, useInput } from "ink";
import { useMemo, useState } from "react";

import { SelectorFrame } from "./selector-frame.js";
import { SelectorList, SelectorListRow } from "./selector-list.js";
import { updateSelectorQuery } from "./selector-search.js";
import { TextField } from "./text-field.js";

import type { DiscoveredModel } from "@/llm/model-discovery.js";
import { THEME } from "@/ui/styles.js";

export interface ModelPickerState {
  status: "loading" | "ready" | "empty" | "error";
  models: DiscoveredModel[];
}

interface ModelSelectProps {
  currentModel: string;
  reservedRows?: number;
  state: ModelPickerState;
  onCancel: () => void;
  onSelect: (model: DiscoveredModel) => void;
}

/** Focus sentinel for the free-text row; never a real model id. */
const OTHER = "\u0000other";
export const OTHER_LABEL = "Other (type your own)";

const STATUS_MESSAGES: Record<
  Exclude<ModelPickerState["status"], "ready">,
  string
> = {
  loading: "Fetching models…",
  empty: "No models returned by this provider",
  error: "Model discovery failed for this provider",
};

type Entry = { kind: "model"; model: DiscoveredModel } | { kind: "other" };

export function ModelSelect({
  currentModel,
  reservedRows,
  state,
  onCancel,
  onSelect,
}: ModelSelectProps) {
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState(currentModel);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState("");
  const fuse = useMemo(
    () =>
      new Fuse(state.models, {
        keys: ["id", "display_name", "name"],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [state.models],
  );
  const entries = useMemo<Entry[]>(() => {
    const matched = query.trim()
      ? fuse.search(query.trim()).map(({ item }) => item)
      : state.models;
    return [
      ...matched.map((model): Entry => ({ kind: "model", model })),
      { kind: "other" },
    ];
  }, [fuse, state.models, query]);
  const cursor =
    focusedId === OTHER
      ? entries.length - 1
      : Math.max(
          0,
          entries.findIndex(
            (entry) => entry.kind === "model" && entry.model.id === focusedId,
          ),
        );
  const ready = state.status === "ready";
  // Discovery produced no usable list, so the free-text field is the dialog.
  const forcedTextEntry = state.status === "empty" || state.status === "error";

  useInput((input, key) => {
    // The TextField owns every key while it is mounted; ink dispatches input to
    // all handlers, so this dialog must not also act on them.
    if (customMode || forcedTextEntry) {
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (!ready) {
      return;
    }
    if (key.upArrow || key.downArrow) {
      const next =
        (cursor + (key.upArrow ? -1 : 1) + entries.length) % entries.length;
      const entry = entries[next];
      if (entry) {
        setFocusedId(entry.kind === "other" ? OTHER : entry.model.id);
      }
      return;
    }
    if (key.return) {
      const entry = entries.at(cursor);
      if (entry?.kind === "other") {
        setCustomMode(true);
        setCustomText(query.trim());
      } else if (entry) {
        onSelect(entry.model);
      }
      return;
    }
    const nextQuery = updateSelectorQuery(query, input, key);
    if (nextQuery !== query) {
      setQuery(nextQuery);
      setFocusedId(nextQuery.trim() ? "" : currentModel);
    }
  });

  if (customMode || forcedTextEntry) {
    return (
      <SelectorFrame
        compact
        hint={
          customMode
            ? "Enter set model · Esc back to list"
            : "Enter set model · Esc cancel"
        }
        subtitle={
          customMode
            ? `Current model: ${currentModel}`
            : `${STATUS_MESSAGES[state.status === "error" ? "error" : "empty"]} — type a model id`
        }
        title="Select model"
      >
        <TextField
          isActive
          initialValue={customText}
          prompt="Model id: "
          onChange={setCustomText}
          onSubmit={(value) => {
            const id = value.trim();
            if (id) {
              onSelect({ id });
            }
          }}
          onEscape={() => {
            if (customMode) {
              setCustomMode(false);
              setFocusedId(OTHER);
            } else {
              onCancel();
            }
          }}
        />
        <Text color={THEME.dim}>
          Any id is accepted, even one the provider does not list.
        </Text>
      </SelectorFrame>
    );
  }

  if (!ready) {
    return (
      <SelectorFrame
        compact
        hint="Esc cancel"
        subtitle={`Current model: ${currentModel}`}
        title="Select model"
      >
        <Text color={THEME.muted}>{STATUS_MESSAGES.loading}</Text>
      </SelectorFrame>
    );
  }

  return (
    <SelectorList
      cursor={cursor}
      emptyText="No models available"
      hint="↑↓ navigate · Enter select · Esc cancel · Ctrl+U clear"
      itemCount={entries.length}
      itemHeight={1}
      query={query}
      title="Select model"
      totalCount={state.models.length}
      reservedRows={reservedRows}
    >
      {(start, count, width) =>
        entries
          .slice(start, start + count)
          .map((entry, index) =>
            entry.kind === "other" ? (
              <SelectorListRow
                key={OTHER}
                current={false}
                focused={start + index === cursor}
                label={OTHER_LABEL}
                width={width}
              />
            ) : (
              <SelectorListRow
                key={entry.model.id}
                current={entry.model.id === currentModel}
                detail={
                  entry.model.display_name &&
                  entry.model.display_name !== entry.model.id
                    ? entry.model.display_name
                    : undefined
                }
                focused={start + index === cursor}
                label={entry.model.id}
                width={width}
              />
            ),
          )
      }
    </SelectorList>
  );
}
