import { useScrollFollow } from "@browser/hooks/use-scroll-follow";
import { useId, useMemo, useState, type KeyboardEvent } from "react";

interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  meta?: string;
  current?: boolean;
}

interface PickerListProps {
  items: PickerItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function PickerList({ items, onSelect, onClose }: PickerListProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.current),
    ),
  );
  const filtered = useMemo(
    () =>
      items.filter((item) =>
        `${item.label} ${item.detail ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [items, query],
  );
  const selected = Math.min(cursor, Math.max(0, filtered.length - 1));
  const { listRef, setItemRef } = useScrollFollow(selected);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setCursor(
        (selected + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) %
          Math.max(1, filtered.length),
      );
    } else if (event.key === "Enter" && filtered[selected]) {
      event.preventDefault();
      onSelect(filtered[selected].id);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
        <label className="text-muted" htmlFor={`${id}-search`}>
          Search:
        </label>
        <input
          id={`${id}-search`}
          type="text"
          autoFocus
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={
            filtered[selected] ? `${id}-${String(selected)}` : undefined
          }
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
          placeholder="type to filter"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
        />
        <span className="text-xs text-dim">
          {filtered.length ? String(selected + 1) : "0"}/
          {String(filtered.length)}
        </span>
      </div>
      <div
        ref={listRef}
        id={`${id}-list`}
        role="listbox"
        aria-label="Choices"
        className="min-h-0 overflow-y-auto px-2 pb-2"
      >
        {filtered.map((item, index) => (
          <button
            key={item.id}
            ref={setItemRef(index)}
            id={`${id}-${String(index)}`}
            type="button"
            role="option"
            aria-selected={index === selected}
            tabIndex={-1}
            onClick={() => {
              onSelect(item.id);
            }}
            onMouseEnter={() => {
              setCursor(index);
            }}
            className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left hover:bg-selected/40"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {item.label}
                {item.current && <span className="ml-2 text-green">✓</span>}
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
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="px-3 py-2 text-muted">No matching entries</p>
        )}
      </div>
      <p className="px-4 pt-2 pb-3 text-xs text-dim sm:px-5">
        ↑↓ navigate · Enter select · Esc cancel
      </p>
    </div>
  );
}
