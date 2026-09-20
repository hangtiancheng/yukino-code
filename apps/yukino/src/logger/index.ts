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

// Root logger singleton: initLogger() / closeLogger(), plus the module-level
// `logger` export and the createChildLogger() factory.
//
// Design:
// - pino.destination(fd) writes from the main thread (no worker), compatible
//   with tsup noExternal bundling. Writes are buffered asynchronously; the
//   process exit handler calls closeLogger(), which flushSync()s the buffer.
// - Writes to a file fd; stdout is only mirrored in remote mode via the
//   `stdout` option (Ink owns stdout in UI mode; teammates use it for IPC).
// - Before initLogger(), a Proxy falls back to a silent pino logger so early
//   log calls are safe no-ops (startup errors should use console.error).

import { openSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

import pino, { type Logger, type LoggerOptions } from "pino";

/** Execution mode, written into the base field of every log entry. */
type LoggerMode = "terminal" | "remote" | "teammate";

/** Options for initLogger. Named to avoid clashing with pino's LoggerOptions. */
interface InitLoggerOptions {
  /** Session ID, used as the log filename and a base field. */
  sessionId: string;
  /** Execution mode. */
  mode: LoggerMode;
  /** Working directory; defaults .yukino/logs/ root. */
  workDir?: string;
  /** Override log directory (teammates use ~/.yukino/teams/<team>/logs/). */
  logDir?: string;
  /** Subprocess passes true to skip expired-log cleanup (avoid multi-process races). */
  skipCleanup?: boolean;
  /**
   * Mirror JSONL to stdout in addition to the log file. Only safe in remote
   * mode (UI owns stdout; teammates use it for IPC). Lets users watch logs
   * live or pipe them through pino-pretty.
   */
  stdout?: boolean;
}

let currentLogger: Logger | null = null;
let currentDest: ReturnType<typeof pino.destination> | null = null;
let currentFd: number | null = null;

/** Compute the log file path. */
function resolveLogPath(opts: InitLoggerOptions): string {
  const dir =
    opts.logDir ?? join(opts.workDir ?? process.cwd(), ".yukino", "logs");
  return join(dir, `${opts.sessionId}.jsonl`);
}

/**
 * Write a self-ignoring .gitignore ("*") into the nearest `.yukino` ancestor
 * of the log file, so the runtime directory never gets committed. Existing
 * files are left untouched; failures are non-fatal.
 */
function ensureYukinoGitignore(logPath: string): void {
  let dir = dirname(logPath);
  while (basename(dir) !== ".yukino") {
    const parent = dirname(dir);
    if (parent === dir) {
      return; // no .yukino ancestor (custom logDir outside .yukino)
    }
    dir = parent;
  }
  try {
    // wx: create only if missing, so user edits are never clobbered.
    writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch {
    // Already exists or unwritable — either way logging proceeds.
  }
}

/** Sanitize a filename segment to prevent path traversal (member names, etc.). */
export function sanitizeNameSegment(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "unnamed";
}

/** Flush a pino destination via Reflect.get, avoiding type assertions. */
function flushDestination(dest: unknown): void {
  if (typeof dest !== "object" || dest === null) {
    return;
  }
  // Reflect.get returns `any`; annotate unknown so typeof narrows to Function.
  const fn: unknown = Reflect.get(dest, "flushSync");
  if (typeof fn === "function") {
    fn.call(dest);
  }
}

// Only warnings and errors are recorded, by design.
const LOG_LEVEL = "warn";

/**
 * Initialize the root logger. Creates the log file, opens the fd, and builds
 * the pino instance. When called by the main process (skipCleanup defaults
 * false), also triggers expired-log cleanup.
 */
export function initLogger(opts: InitLoggerOptions): Logger {
  // Guard against fd leak on re-init.
  if (currentLogger) {
    closeLogger();
  }

  const logPath = resolveLogPath(opts);
  mkdirSync(dirname(logPath), { recursive: true });
  ensureYukinoGitignore(logPath);
  // Append mode: multi-process safe, supports resume.
  const fd = openSync(logPath, "a");
  currentFd = fd;
  currentDest = pino.destination(fd);

  const pinoOpts: LoggerOptions = {
    level: LOG_LEVEL,
    base: { sessionId: opts.sessionId, mode: opts.mode },
    serializers: { err: errSerializer },
  };

  if (opts.stdout) {
    // Explicit per-stream level: multistream would otherwise filter each
    // stream at its own default ("info"), ignoring the logger level.
    currentLogger = pino(
      pinoOpts,
      pino.multistream([
        { stream: currentDest, level: LOG_LEVEL },
        { stream: process.stdout, level: LOG_LEVEL },
      ]),
    );
  } else {
    currentLogger = pino(pinoOpts, currentDest);
  }

  // Main-process startup: clean expired logs.
  if (!opts.skipCleanup) {
    const workDir = opts.workDir ?? process.cwd();
    void cleanExpiredLogs(workDir).catch(() => {
      // Cleanup failure is non-fatal.
    });
  }

  return currentLogger;
}

/** Return the current logger instance, or null if not initialized. */
function getLogger(): Logger | null {
  return currentLogger;
}

/**
 * Flush and close the fd. Registered on process.on('exit') to ensure the
 * SonicBoom internal buffer is written to disk.
 */
export function closeLogger(): void {
  if (currentLogger) {
    try {
      currentLogger.flush();
    } catch {
      // Flush failure is non-fatal
    }
    currentLogger = null;
  }
  if (currentDest) {
    flushDestination(currentDest);
    currentDest = null;
  }
  if (currentFd !== null) {
    try {
      closeSync(currentFd);
    } catch {
      // Ignore
    }
    currentFd = null;
  }
}

// A real silent pino logger used as the Proxy target for the global logger
// and pre-init child loggers. Its methods are only reached before
// initLogger(); afterwards every access is forwarded to the current logger.
// Using a real Logger instance as the target gives the correct return type
// without type assertions.
const silentFallback = pino({ level: "silent" });

/**
 * Global logger export. Modules can import and use it at file top level:
 * ```ts
 * import { logger } from "@/logger/index.js";
 * logger.warn({ module: "app" }, "something looks off");
 * ```
 * Before initLogger(), calls fall back to the silent target (pre-init logs
 * are discarded; startup errors should use console.error directly).
 */
export const logger: Logger = new Proxy(silentFallback, {
  get(_target, prop, receiver) {
    const current = getLogger();
    const target = current ?? _target;
    // Reflect.get returns `any`; annotate unknown so typeof narrows correctly.
    const value: unknown = Reflect.get(target, prop, receiver);
    if (typeof value === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return value.bind(target);
    }
    return value;
  },
  set(_target, prop, value) {
    // Route writes (e.g. logger.level = ...) to the live logger; without
    // this trap they would silently land on the silent fallback.
    return Reflect.set(getLogger() ?? _target, prop, value);
  },
});

/**
 * Create a module-level child logger. Each module calls this at file top,
 * with bindings holding static fields like { module: "session" }.
 *
 * Returns a Proxy that forwards every access to the current root logger's
 * child, so it stays valid across initLogger() calls. The child pino
 * instance is cached and only rebuilt when the root logger changes,
 * avoiding redundant pino.child() allocations on every log call.
 */
export function createChildLogger(bindings: { module: string }): Logger {
  let cachedChild: Logger | null = null;
  let cachedLogger: Logger | null = null;

  const resolveChild = (): Logger | null => {
    const current = getLogger();
    if (!current) {
      return null;
    }
    if (cachedChild === null || cachedLogger !== current) {
      cachedChild = current.child(bindings);
      cachedLogger = current;
    }
    return cachedChild;
  };

  return new Proxy(silentFallback, {
    get(_target, prop, receiver) {
      const target = resolveChild() ?? _target;
      // Reflect.get returns `any`; annotate unknown so typeof narrows correctly.
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        // Function.bind returns `any` in lib.es5; the bound callable is
        // type-safe by construction (pino method signatures are preserved).
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return value.bind(target);
      }
      return value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolveChild() ?? _target, prop, value);
    },
  });
}

// Expired log cleanup. Mirrors session/index.ts cleanExpiredSessions:
// same directory iteration, 30-day mtime check, silent unlink failure.
// Scans <workDir>/.yukino/logs/ and ~/.yukino/teams/<team>/logs/.
// All fs operations are async to avoid blocking the event loop.

/** Clean expired log files in a single directory. Returns count removed. Failures are silent. */
async function cleanDir(dir: string): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return 0; // missing or unreadable directory
  }

  const now = Date.now();
  let removed = 0;
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const s = await stat(filePath);
      if (now - s.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
        await unlink(filePath);
        removed++;
      }
    } catch {
      // Silently skip
    }
  }
  return removed;
}

/**
 * Clean expired logs. Scans the project .yukino/logs/ and all team-specific
 * ~/.yukino/teams/<team>/logs/ directories (team data lives under the home
 * directory — see teams/team-file.ts teamsBaseDir). Only called by the main
 * process (teammate subprocesses skip via skipCleanup).
 */
async function cleanExpiredLogs(workDir: string): Promise<number> {
  let removed = 0;
  removed += await cleanDir(join(workDir, ".yukino", "logs"));

  const teamsDir = join(homedir(), ".yukino", "teams");
  let teams: string[];
  try {
    teams = await readdir(teamsDir);
  } catch {
    return removed; // no teams directory
  }
  for (const team of teams) {
    removed += await cleanDir(join(teamsDir, team, "logs"));
  }
  return removed;
}

// Custom error serializer for pino.
// The default pino err serializer does not recurse into Error.cause chains
// and does not handle non-Error values. This module fills those gaps:
// recursive cause (max 5 levels), preserves extra fields, tolerates non-Error.

/** Serialized error shape: always has type/message/stack, optional cause + extras. */
interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  cause?: SerializedError | { message: string };
  [key: string]: unknown;
}

const CAUSE_MAX_DEPTH = 5;
const RESERVED_KEYS = new Set(["name", "message", "stack", "cause"]);

/** Recursively serialize an Error instance (including its cause chain). */
function serializeErrorInstance(err: Error, depth: number): SerializedError {
  const out: SerializedError = {
    type: err.name,
    message: err.message,
    stack: err.stack,
  };

  // Recursive cause chain, guard against circular references.
  // Use getOwnPropertyDescriptor to read `cause` without type assertions
  // (Error.cause is not present on older TS lib definitions).
  const causeDescriptor = Object.getOwnPropertyDescriptor(err, "cause");
  if (causeDescriptor && depth < CAUSE_MAX_DEPTH) {
    const cause: unknown = causeDescriptor.value;
    if (cause instanceof Error) {
      out.cause = serializeErrorInstance(cause, depth + 1);
    } else if (cause !== undefined) {
      out.cause = { message: safeStringify(cause) };
    }
  }

  // Preserve extra fields (code, errno, statusCode, path, etc.) that Error
  // subclasses may attach. Read via getOwnPropertyDescriptor to avoid
  // unsafe member access on the Error type.
  for (const key of Object.keys(err)) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(err, key);
    if (descriptor) {
      const fieldValue: unknown = descriptor.value;
      out[key] = fieldValue;
    }
  }

  return out;
}

/**
 * Stringify an arbitrary value without ever throwing. pino does not guard
 * serializer exceptions, so a throwing serializer would crash the log call
 * site: JSON.stringify throws on circular structures and String() throws on
 * null-prototype objects.
 */
function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) {
      return json;
    }
  } catch {
    // Circular structure or throwing toJSON — fall through.
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * pino err serializer: tolerates Error instances and non-Error values.
 * - Error instance: recursive cause chain + preserved extra fields.
 * - string/undefined/plain object: normalized to { message, value }.
 * Never throws — pino propagates serializer exceptions to the caller.
 */
function errSerializer(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return serializeErrorInstance(err, 0);
  }
  return { message: safeStringify(err), value: err };
}
