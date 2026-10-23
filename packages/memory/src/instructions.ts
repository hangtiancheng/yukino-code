import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

import { createChildLogger } from "@yukino.js/logger";
import { yukinoPath } from "@yukino.js/storage";

import { AGENTS_FILE_NAME } from "./constants.js";
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
 *  1. User-global: ~/.yukino/AGENTS.md
 *  2. Project: AGENTS.md in every
 *     directory from the git root down to cwd
 *
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
    addSource(sources, seen, yukinoPath(AGENTS_FILE_NAME));
  } catch (err) {
    log.error({ err }, "memory operation failed");

    // Skip if $HOME is unavailable
  }

  // 2. Every directory from git root to cwd
  const dirs = projectInstructionDirs(cwd);
  for (const dir of dirs) {
    addSource(sources, seen, join(dir, AGENTS_FILE_NAME));
  }

  return sources;
}

/** Attempts to read an instruction file and add it to the list. */
function addSource(
  out: InstructionSource[],
  seen: Set<string>,
  filePath: string,
): void {
  let abs: string;
  try {
    abs = resolve(filePath);
  } catch (err) {
    log.error({ err }, "memory operation failed");
    return;
  }
  if (seen.has(abs)) {
    return;
  }
  if (!existsSync(abs)) {
    return;
  }

  let data: string;
  try {
    data = readFileSync(abs, "utf-8");
  } catch (err) {
    log.error({ err }, "memory operation failed");

    return;
  }
  seen.add(abs);
  out.push({ path: abs, content: data });
}

/**
 * Returns the list of directories from the git root to cwd.
 * If cwd is not inside a git repository, returns only [cwd].
 */
function projectInstructionDirs(cwd: string): string[] {
  let abs: string;
  try {
    abs = resolve(cwd);
  } catch (err) {
    log.error({ err }, "memory operation failed");
    return [cwd];
  }

  const root = findGitRoot(abs);
  if (!root) {
    return [abs];
  }

  // Collect directories from abs up to root
  const dirs: string[] = [];
  let cur = abs;
  while (true) {
    dirs.unshift(cur);
    if (cur === root) {
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return dirs;
}

/** Traverses upward to find the .git entry (a directory, or a file in linked worktrees) and determine the git repository root */
function findGitRoot(start: string): string {
  let cur = start;
  while (true) {
    try {
      const gitPath = join(cur, ".git");
      if (existsSync(gitPath)) {
        return cur;
      }
    } catch (err) {
      log.error({ err }, "memory operation failed");
    }
    const parent = dirname(cur);
    if (parent === cur) {
      return "";
    }
    cur = parent;
  }
}
