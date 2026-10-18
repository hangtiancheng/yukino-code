// Shallow workspace file scan shared by the terminal @-mention completion and
// the remote server's browser completion endpoint.

import { readdirSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";

import { createChildLogger } from "@/logger/index.js";
import { SKIP_DIRS } from "@/tools/types.js";

const log = createChildLogger({ module: "file-scan" });

/** Lists cwd-relative file paths (max entries, skipping hidden/SKIP_DIRS). */
export function scanCwdFiles(root: string, max = 2000): string[] {
  const out: string[] = [];
  let visited = 0;
  const budget = Math.max(2000, max * 10);
  const walk = (dir: string, rel: string): void => {
    if (out.length >= max || visited >= budget) {
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      log.error({ err }, "cwd scan failed");
      return;
    }
    for (const name of names) {
      if (out.length >= max || visited >= budget) {
        return;
      }
      visited++;
      if (name.startsWith(".") || SKIP_DIRS.has(name)) {
        continue;
      }
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        const info = lstatSync(full);
        if (info.isSymbolicLink()) {
          if (statSync(full).isFile()) {
            out.push(relPath);
          }
          continue;
        }
        if (!info.isDirectory() && !info.isFile()) {
          continue;
        }
        isDir = info.isDirectory();
      } catch (err) {
        log.error({ err }, "cwd scan failed");
        continue;
      }
      if (isDir) {
        walk(full, relPath);
      } else {
        out.push(relPath);
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * Filters scanned files the way the terminal @-mention dropdown does:
 * prefix matches first, then substring matches, capped.
 */
export function filterFileMatches(
  files: readonly string[],
  query: string,
  limit = 8,
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
