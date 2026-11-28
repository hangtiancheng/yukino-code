import { statSync } from "node:fs";
import { relative, sep } from "node:path";

import type { Path as GlobPath } from "glob";
import { globIterateSync } from "glob";

import { SKIP_DIRS } from "@/tools/constants.js";
import {
  DEFAULT_FILE_MATCH_LIMIT,
  DEFAULT_SCAN_MAX_FILES,
  MIN_SCAN_VISITED_BUDGET,
  SCAN_VISITED_BUDGET_MULTIPLIER,
} from "@/utils/constants.js";

export function scanCwdFiles(
  root: string,
  max = DEFAULT_SCAN_MAX_FILES,
): string[] {
  if (max <= 0) {
    return [];
  }
  const budget = Math.max(
    MIN_SCAN_VISITED_BUDGET,
    max * SCAN_VISITED_BUDGET_MULTIPLIER,
  );
  const visited = new Set<string>();
  const ignored = (entry: GlobPath) => {
    const path = entry.fullpath();
    if (path === root) {
      return false;
    }
    if (!visited.has(path)) {
      if (visited.size >= budget) {
        return true;
      }
      visited.add(path);
    }
    return entry.name.startsWith(".") || SKIP_DIRS.has(entry.name);
  };
  const files: string[] = [];
  for (const entry of globIterateSync("**/*", {
    cwd: root,
    nodir: true,
    stat: true,
    withFileTypes: true,
    ignore: {
      ignored,
      childrenIgnored: (entry) => entry.isSymbolicLink() || ignored(entry),
    },
  })) {
    if (entry.isSymbolicLink()) {
      try {
        if (!statSync(entry.fullpath()).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
    }
    files.push(relative(root, entry.fullpath()).split(sep).join("/"));
    if (files.length >= max) {
      break;
    }
  }
  return files.sort();
}

/**
 * Filters scanned files the way the terminal @-mention dropdown does:
 * prefix matches first, then substring matches, capped.
 */
export function filterFileMatches(
  files: readonly string[],
  query: string,
  limit = DEFAULT_FILE_MATCH_LIMIT,
): string[] {
  const q = query.toLowerCase();
  if (!q) {
    return files.slice(0, limit);
  }
  const pre = files.filter((f) => f.toLowerCase().startsWith(q));
  const sub = files.filter(
    (f) => !f.toLowerCase().startsWith(q) && f.toLowerCase().includes(q),
  );
  return [...pre, ...sub].slice(0, limit);
}
