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

import type { ProviderConfig } from "@/config/index.js";

interface ProviderSelectProps {
  currentBaseUrl?: string;
  reservedRows?: number;
  providers: ProviderConfig[];
  onCancel?: () => void;
  onSelect: (provider: ProviderConfig) => void;
}

export function ProviderSelect({
  currentBaseUrl,
  reservedRows,
  providers,
  onCancel,
  onSelect,
}: ProviderSelectProps) {
  const [query, setQuery] = useState("");
  const [focusedBaseUrl, setFocusedBaseUrl] = useState(currentBaseUrl);
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
    () => (query.trim() ? fuse.search(query.trim()).map(({ item }) => item) : providers),
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
        const next = (cursor + (key.upArrow ? -1 : 1) + matches.length) % matches.length;
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
        setFocusedBaseUrl(nextQuery.trim() ? undefined : currentBaseUrl);
      }
    }
  });

  return (
    <SelectorList
      cursor={cursor}
      emptyText={query.trim() ? "No matching providers" : "No providers configured"}
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
              current={provider.base_url === currentBaseUrl}
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
