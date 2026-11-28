import { readFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

import { createChildLogger } from "@/logger/index.js";
import { AGENTS_FILE_NAMES } from "@/memory/constants.js";
import { yukinoPath } from "@/storage/index.js";
import { projectAncestorDirs } from "@/utils/paths.js";
const log = createChildLogger({ module: "memory" });

export interface InstructionSource {
  path: string;
  content: string;
}

/**
 * Discovers and concatenates all project- and user-level instruction files.
 *
 * Discovery order (later entries take higher precedence — the model attends
 * more to content appearing later):
 * User-global instructions precede each directory from the git root to cwd.
 * In each directory, the first readable AGENTS_FILE_NAMES candidate wins.
 */
export function loadInstructions(cwd: string): string {
  const sources = discoverInstructions(cwd);
  if (sources.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const s of sources) {
    // Prefer relative paths as labels for better readability
    let label = s.path;
    try {
      const rel = relative(cwd, s.path);
      if (!rel.startsWith("..")) {
        label = rel;
      }
    } catch (err) {
      log.error({ err }, "memory operation failed");
      // Fallback to absolute path
    }
    parts.push(`Contents of ${label}:\n\n${s.content.replace(/\n+$/, "")}`);
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Returns all loaded instruction sources in priority order.
 * Lowest priority first (user-global), highest last (local override).
 */
export function discoverInstructions(cwd: string): InstructionSource[] {
  const sources: InstructionSource[] = [];
  const seen = new Set<string>();

  // 1. User-global instructions
  try {
    addDirectory(sources, seen, yukinoPath());
  } catch (err) {
    log.error({ err }, "memory operation failed");

    // Skip if $HOME is unavailable
  }

  // 2. Every directory from git root to cwd
  const dirs = projectAncestorDirs(cwd);
  for (const dir of dirs) {
    addDirectory(sources, seen, dir);
  }

  return sources;
}

/** Attempts to read an instruction file and add it to the list. */
function addSource(
  out: InstructionSource[],
  seen: Set<string>,
  filePath: string,
): boolean {
  let abs: string;
  try {
    abs = resolve(filePath);
  } catch (err) {
    log.error({ err }, "memory operation failed");
    return false;
  }
  if (seen.has(abs)) {
    return true;
  }
  if (!existsSync(abs)) {
    return false;
  }

  let data: string;
  try {
    data = readFileSync(abs, "utf-8");
  } catch (err) {
    log.error({ err }, "memory operation failed");

    return false;
  }
  seen.add(abs);
  out.push({ path: abs, content: data });
  return true;
}

function addDirectory(
  out: InstructionSource[],
  seen: Set<string>,
  directory: string,
): void {
  for (const name of AGENTS_FILE_NAMES) {
    if (addSource(out, seen, join(directory, name))) {
      break;
    }
  }
}
