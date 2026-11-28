// Root logger singleton: initLogger() / closeLogger(), plus the module-level
// `logger` export and the createChildLogger() factory.
//
// Design:
// - pino.destination(fd) writes from the main thread (no worker), compatible
//   with tsup noExternal bundling. Synchronous writes let closeLogger() drain
//   and close the destination safely, including during process exit.
// - Writes to a file fd; stdout is only mirrored in remote mode via the
//   `stdout` option (Ink owns stdout in UI mode).
// - Before initLogger(), a Proxy falls back to a silent pino logger so early
//   log calls are safe no-ops (startup errors should use console.error).

import { readdir, stat, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

import pino, { type Logger, type LoggerOptions } from "pino";

import {
  DEFAULT_NAME_SEGMENT,
  LOG_EXPIRY_DAYS,
  LOG_FILE_EXTENSION,
  LOG_LEVEL,
  LOGS_DIR_NAME,
  SILENT_LOG_LEVEL,
  UNSAFE_NAME_SEGMENT_PATTERN,
} from "@/logger/constants.js";
import { yukinoPath } from "@/storage/index.js";
import {
  openPrivateFileSync as openSync,
  mkdirPrivateSync as mkdirSync,
} from "@/storage/private.js";
import { TEAMS_DIR_NAME } from "@/teams/constants.js";

export * from "@/logger/constants.js";

/** Execution mode, written into the base field of every log entry. */
type LoggerMode = "terminal" | "remote" | "teammate";

/** Options for initLogger. Named to avoid clashing with pino's LoggerOptions. */
interface InitLoggerOptions {
  /** Session ID, used as the log filename and a base field. */
  sessionId: string;
  /** Execution mode. */
  mode: LoggerMode;
  /** Override log directory (teammates use ~/.yukino/teams/<namespace>/<team>/logs/). */
  logDir?: string;
  /** Subprocess passes true to skip expired-log cleanup (avoid multi-process races). */
  skipCleanup?: boolean;
  /**
   * Mirror JSONL to stdout in addition to the log file. Only safe in remote
   * mode (UI owns stdout). Lets users watch logs
   * live or pipe them through pino-pretty.
   */
  stdout?: boolean;
}

let currentLogger: Logger | null = null;
let currentDest: ReturnType<typeof pino.destination> | null = null;

function resolveLogPath(opts: InitLoggerOptions): string {
  const dir = opts.logDir ?? yukinoPath(LOGS_DIR_NAME);
  return join(dir, `${opts.sessionId}${LOG_FILE_EXTENSION}`);
}

/** Sanitize a filename segment to prevent path traversal (member names, etc.). */
export function sanitizeNameSegment(name: string): string {
  const cleaned = name.replace(UNSAFE_NAME_SEGMENT_PATTERN, "_");
  return cleaned || DEFAULT_NAME_SEGMENT;
}

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
  mkdirSync(dirname(logPath));
  // Append mode: multi-process safe, supports resume.
  const fd = openSync(logPath, "a");
  currentDest = pino.destination({ dest: fd, sync: true });

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
    void cleanExpiredLogs().catch(() => {
      // Cleanup failure is non-fatal.
    });
  }

  return currentLogger;
}

function getLogger(): Logger | null {
  return currentLogger;
}

/**
 * Flush and close the fd. Registered on process.on('exit') to ensure the
 * SonicBoom internal buffer is written to disk.
 */
export function closeLogger(): void {
  currentLogger = null;
  if (currentDest) {
    const destination = currentDest;
    currentDest = null;
    destination.flushSync();
    // SonicBoom owns the fd; let it close its own destination.
    destination.end();
  }
}

// A real silent pino logger used as the Proxy target for the global logger
// and pre-init child loggers. Its methods are only reached before
// initLogger(); afterwards every access is forwarded to the current logger.
// Using a real Logger instance as the target gives the correct return type
// without type assertions.
const silentFallback = pino(
  { level: SILENT_LOG_LEVEL },
  { write: () => undefined },
);

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
      const bound: unknown = value.bind(target);
      return bound;
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
        const bound: unknown = value.bind(target);
        return bound;
      }
      return value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolveChild() ?? _target, prop, value);
    },
  });
}

// Expired log cleanup. Mirrors session/index.ts cleanExpiredSessions: same
// directory iteration and 30-day mtime check; unlike the session sweep, which
// logs failures, cleanup errors here stay silent.
// Scans ~/.yukino/logs/ and teammate team log directories.
// All fs operations are async to avoid blocking the event loop.

/** Clean expired log files in a single directory. Returns count removed. Failures are silent. */
async function cleanDir(dir: string): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(LOG_FILE_EXTENSION));
  } catch {
    return 0; // missing or unreadable directory
  }

  const now = Date.now();
  const expiryMs = LOG_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const s = await stat(filePath);
      if (now - s.mtimeMs > expiryMs) {
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
 * Clean expired logs. Scans ~/.yukino/logs/ and every
 * ~/.yukino/teams/<namespace>/<team>/logs/ directory.
 * Only called by the main process (teammate subprocesses skip via
 * skipCleanup).
 */
async function cleanExpiredLogs(): Promise<number> {
  let removed = 0;
  removed += await cleanDir(yukinoPath(LOGS_DIR_NAME));

  const teamsDir = yukinoPath(TEAMS_DIR_NAME);
  let teams: string[];
  try {
    teams = await readdir(teamsDir);
  } catch {
    return removed; // no teams directory
  }
  for (const namespace of teams) {
    let teamNames: string[];
    try {
      teamNames = await readdir(join(teamsDir, namespace));
    } catch {
      continue;
    }
    for (const teamName of teamNames) {
      removed += await cleanDir(
        join(teamsDir, namespace, teamName, LOGS_DIR_NAME),
      );
    }
  }
  return removed;
}

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

function errSerializer(err: unknown): unknown {
  try {
    return err instanceof Error
      ? pino.stdSerializers.errWithCause(err)
      : { message: safeStringify(err), value: err };
  } catch {
    return { message: safeStringify(err) };
  }
}
