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

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve, isAbsolute, relative } from "node:path";

import { createChildLogger } from "@/logger/index.js";
const log = createChildLogger({ module: "memory" });

/** Maximum recursion depth for @include to prevent infinite nesting */
const MAX_INCLUDE_DEPTH = 5;

/** Loaded instruction file */
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
 *  2. Project: AGENTS.md, and .yukino/AGENTS.md in every
 *     directory from the git root down to workDir
 *
 * Supports @include directives:
 *  - @./relative/path, @~/home/path, @/absolute/path
 *  - Resolved relative to the directory of the containing file
 *  - Ignored inside fenced code blocks
 *  - Cycle detection (the same absolute path is never included twice)
 */
export function loadInstructions(workDir: string): string {
  const sources = discoverInstructions(workDir);
  if (sources.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const s of sources) {
    // Prefer relative paths as labels for better readability
    let label = s.path;
    try {
      const rel = relative(workDir, s.path);
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
export function discoverInstructions(workDir: string): InstructionSource[] {
  const sources: InstructionSource[] = [];
  const seen = new Set<string>();

  // 1. User-global instructions
  try {
    const home = homedir();
    addSource(sources, seen, join(home, ".yukino", "AGENTS.md"));
  } catch (err) {
    log.error({ err }, "memory operation failed");

    // Skip if $HOME is unavailable
  }

  // 2. Every directory from git root to workDir
  const dirs = projectInstructionDirs(workDir);
  for (const dir of dirs) {
    addSource(sources, seen, join(dir, "AGENTS.md"));
    // Same-named file under .yukino/: for projects that want instructions in .gitignore
    addSource(sources, seen, join(dir, ".yukino", "AGENTS.md"));
  }

  return sources;
}

/** Attempts to read an instruction file and add it to the list, supporting @include expansion */
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
  const content = expandIncludes(data, dirname(abs), seen, 0);
  out.push({ path: abs, content });
}

/**
 * Recursively expands @include directives.
 * Lines starting with @ inside fenced code blocks are ignored.
 * The same absolute path will not be included twice (cycle-safe).
 */
function expandIncludes(
  content: string,
  baseDir: string,
  seen: Set<string>,
  depth: number,
): string {
  if (depth > MAX_INCLUDE_DEPTH) {
    return content;
  }

  const lines = content.split("\n");
  const out: string[] = [];
  let inCode = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect fenced code block boundaries
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      out.push(line);
      continue;
    }

    if (!inCode) {
      const includePath = parseInclude(trimmed);
      if (includePath) {
        const resolved = resolveInclude(includePath, baseDir);
        if (resolved) {
          let abs: string;
          try {
            abs = resolve(resolved);
          } catch (err) {
            log.error({ err }, "memory operation failed");
            out.push(line);
            continue;
          }
          if (!seen.has(abs)) {
            try {
              const data = readFileSync(abs, "utf-8");
              seen.add(abs);
              out.push(`<!-- included from ${includePath} -->`);
              out.push(expandIncludes(data, dirname(abs), seen, depth + 1));
              continue;
            } catch (err) {
              log.error({ err }, "memory operation failed");
              // On read failure, keep the original line visible to the user
            }
          }
        }
        // Unresolvable or already included; keep the original line
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

/**
 * Parses @include lines: @./path, @~/path, @/abs/path.
 * Other @-tokens (e.g., @username) are ignored to avoid false positives.
 */
function parseInclude(trimmed: string): string {
  // Must start with @, but @@ is an escape and should be ignored
  if (!trimmed.startsWith("@") || trimmed.startsWith("@@")) {
    return "";
  }

  const rest = trimmed.slice(1);
  if (!rest) {
    return "";
  }
  // Cannot contain spaces or tabs (excludes cases like @username)
  if (/[\s\t]/.test(rest)) {
    return "";
  }

  // Only accept relative paths, ~/ paths, and absolute paths
  if (
    rest.startsWith("./") ||
    rest.startsWith("../") ||
    rest.startsWith("~/") ||
    rest.startsWith("/")
  ) {
    return rest;
  }
  return "";
}

/** Resolves an include path to an absolute path */
function resolveInclude(p: string, baseDir: string): string {
  if (p.startsWith("~/")) {
    try {
      return join(homedir(), p.slice(2));
    } catch (err) {
      log.error({ err }, "memory operation failed");
      return "";
    }
  }
  if (isAbsolute(p)) {
    return p;
  }
  return join(baseDir, p);
}

/**
 * Returns the list of directories from the git root to workDir.
 * If workDir is not inside a git repository, returns only [workDir].
 */
function projectInstructionDirs(workDir: string): string[] {
  let abs: string;
  try {
    abs = resolve(workDir);
  } catch (err) {
    log.error({ err }, "memory operation failed");
    return [workDir];
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

/** Traverses upward to find the .git directory and determine the git repository root */
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
      // ignore
    }
    const parent = dirname(cur);
    if (parent === cur) {
      return "";
    }
    cur = parent;
  }
}
