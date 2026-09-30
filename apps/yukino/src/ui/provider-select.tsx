import Fuse from "fuse.js";
import { useInput } from "ink";
import { useMemo, useState } from "react";

import { SelectorList, SelectorListRow } from "./selector-list.js";
import { updateSelectorQuery } from "./selector-search.js";

import type { ProviderConfig } from "@/config/provider-config.js";

interface ProviderSelectProps {
  /** Index into `providers` of the active provider; out-of-range marks none. */
  currentProviderIndex?: number;
  reservedRows?: number;
  providers: ProviderConfig[];
  onCancel?: () => void;
  onSelect: (provider: ProviderConfig) => void;
}

export function ProviderSelect({
  currentProviderIndex,
  reservedRows,
  providers,
  onCancel,
  onSelect,
}: ProviderSelectProps) {
  const [query, setQuery] = useState("");
  const currentProvider =
    currentProviderIndex === undefined
      ? undefined
      : providers[currentProviderIndex];
  // Focus tracks base_url — the provider identity (see provider-login) — so it
  // stays on the same entry when the list updates while the dialog is open.
  const [focusedBaseUrl, setFocusedBaseUrl] = useState(
    currentProvider?.base_url,
  );
  const fuse = useMemo(
    () =>
      new Fuse(providers, {
        keys: ["name", "protocol", "base_url", "model"],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [providers],
  );
  const matches = useMemo(
    () =>
      query.trim()
        ? fuse.search(query.trim()).map(({ item }) => item)
        : providers,
    [fuse, providers, query],
  );
  const cursor = Math.max(
    0,
    matches.findIndex((provider) => provider.base_url === focusedBaseUrl),
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
    } else if (key.upArrow || key.downArrow) {
      if (matches.length > 0) {
        const next =
          (cursor + (key.upArrow ? -1 : 1) + matches.length) % matches.length;
        setFocusedBaseUrl(matches[next].base_url);
      }
    } else if (key.return) {
      const provider = matches.at(cursor);
      if (provider) {
        onSelect(provider);
      }
    } else {
      const nextQuery = updateSelectorQuery(query, input, key);
      if (nextQuery !== query) {
        setQuery(nextQuery);
        setFocusedBaseUrl(
          nextQuery.trim() ? undefined : currentProvider?.base_url,
        );
      }
    }
  });

  return (
    <SelectorList
      cursor={cursor}
      emptyText={
        query.trim() ? "No matching providers" : "No providers configured"
      }
      hint={`↑↓ navigate · Enter select${onCancel ? " · Esc cancel" : ""} · Ctrl+U clear`}
      itemCount={matches.length}
      itemHeight={1}
      query={query}
      title="Select provider"
      totalCount={providers.length}
      reservedRows={reservedRows}
    >
      {(start, count, width) =>
        matches
          .slice(start, start + count)
          .map((provider, index) => (
            <SelectorListRow
              key={provider.base_url}
              current={provider === currentProvider}
              description={`${provider.protocol} · ${provider.model}`}
              focused={start + index === cursor}
              label={provider.name}
              width={width}
            />
          ))
      }
    </SelectorList>
  );
}
