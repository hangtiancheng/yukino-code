import { useContext, useId, useMemo, useState } from "react";

import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxEmpty,
} from "#/components/ui/combobox.js";
import { Label } from "#/components/ui/label.js";
import { ModalCloseContext } from "#/lib/modal-context.js";
import { MAX_SESSION_SEARCH_CHARS } from "@/session/constants.js";

interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  meta?: string;
  searchText?: string;
  current?: boolean;
  hasChildren?: boolean;
  folded?: boolean;
}

interface PickerListProps {
  items: PickerItem[];
  onSelect: (id: string) => void;
  onBranchToggle?: (id: string, folded: boolean) => void;
}

export function PickerList({
  items,
  onSelect,
  onBranchToggle,
}: PickerListProps) {
  const closeModal = useContext(ModalCloseContext);
  const id = useId();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<PickerItem>();
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        const text =
          `${item.label} ${item.detail ?? ""} ${item.searchText ?? ""}`
            .normalize("NFC")
            .toLowerCase();
        return query
          .normalize("NFC")
          .toLowerCase()
          .trim()
          .split(/\s+/u)
          .every((term) => text.includes(term));
      }),
    [items, query],
  );
  const selected =
    highlighted ?? filtered.find((item) => item.current) ?? filtered[0];
  return (
    <Combobox<PickerItem>
      items={items}
      filteredItems={filtered}
      inline
      open
      autoHighlight
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => item.id}
      onValueChange={(item) => {
        if (item) {
          onSelect(item.id);
        }
      }}
      onItemHighlighted={setHighlighted}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeModal();
          } else if (
            (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
            selected?.hasChildren &&
            onBranchToggle
          ) {
            event.preventDefault();
            onBranchToggle(selected.id, event.key === "ArrowLeft");
          }
        }}
      >
        <div className="picker-search mx-4 my-3 flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 sm:mx-5">
          <Label className="text-muted" htmlFor={`${id}-search`}>
            Search:
          </Label>
          <ComboboxInput
            id={`${id}-search`}
            maxLength={MAX_SESSION_SEARCH_CHARS}
            autoFocus
            showTrigger={false}
            placeholder="type to filter"
            className="min-w-0 flex-1"
          />
          <span className="text-xs text-dim">
            {selected ? String(filtered.indexOf(selected) + 1) : "0"}/
            {String(filtered.length)}
          </span>
        </div>
        <ComboboxList
          aria-label="Choices"
          className="min-h-0 max-h-none overflow-y-auto px-2 pb-2"
        >
          {(item: PickerItem) => (
            <ComboboxItem
              key={item.id}
              value={item}
              className="flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-3 py-2.5 text-left data-highlighted:bg-selected"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {item.label}
                  {item.current && <span className="ml-2 text-success">✓</span>}
                </span>
                {item.detail && (
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {item.detail}
                  </span>
                )}
              </span>
              {item.meta && (
                <span className="shrink-0 text-xs text-dim">{item.meta}</span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty className="px-3 py-2 text-muted">
          No matching entries
        </ComboboxEmpty>
        <p className="border-t border-border bg-surface px-4 py-3 text-xs text-dim sm:px-5">
          ↑↓ navigate · Enter select · Esc cancel
        </p>
      </div>
    </Combobox>
  );
}
