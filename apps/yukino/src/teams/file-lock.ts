import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { safeParse, z } from "zod";

const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_MIN_BACKOFF_MS = 5;
const LOCK_MAX_BACKOFF_MS = 80;
const heldLocks = new Set<string>();

const ErrnoExceptionSchema = z.looseObject({
  errno: z.number().optional(),
  code: z.string().optional(),
  path: z.string().optional(),
  syscall: z.string().optional(),
});

function errorCode(error: unknown): string | undefined {
  const parsed = safeParse(ErrnoExceptionSchema, error);
  return parsed.success ? parsed.data.code : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface LockContender {
  choosingPath: string;
  ticketPath: string;
  ticketName: string;
}

function ticketNumber(entry: string): number {
  const match = /^ticket-(\d+)-/u.exec(entry);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function lockOwnerPid(entry: string): number | null {
  const match = /^(?:choosing-|ticket-\d+-)(\d+)-/u.exec(entry);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

// Best-effort process-instance identity: the kernel start-time tick of a PID.
// kill(pid, 0) only proves *some* process holds the PID, which a recycled PID
// makes ambiguous; the start tick distinguishes the original lock owner from an
// unrelated later process. Returns undefined where the platform exposes no such
// marker, in which case liveness safely falls back to kill(pid, 0) alone.
function processStartTick(pid: number): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // The comm field (2) is parenthesized and may contain spaces/parens, so
    // split after the last ')'; starttime is field 22, i.e. index 19 after it.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    return afterComm.split(" ")[19];
  } catch {
    return undefined;
  }
}

// Owner identity recorded in a contender file: "<pid>" or "<pid>:<startTick>".
function ownerIdentity(): string {
  const tick = processStartTick(process.pid);
  return tick === undefined
    ? String(process.pid)
    : `${String(process.pid)}:${tick}`;
}

function recordedStartTick(entryPath: string): string | undefined {
  try {
    const content = readFileSync(entryPath, "utf8");
    const idx = content.indexOf(":");
    return idx >= 0 ? content.slice(idx + 1) : undefined;
  } catch {
    return undefined;
  }
}

function createContender(lockDir: string): LockContender {
  const id = `${String(process.pid)}-${randomBytes(8).toString("hex")}`;
  const choosingPath = join(lockDir, `choosing-${id}`);

  while (true) {
    mkdirSync(lockDir, { recursive: true });
    try {
      writeFileSync(choosingPath, ownerIdentity(), { flag: "wx" });
      break;
    } catch (err: unknown) {
      const parsed = safeParse(ErrnoExceptionSchema, err);
      if (!parsed.success || parsed.data.code !== "ENOENT") {
        throw err;
      }
    }
  }

  let ticketPath: string | undefined;
  try {
    const nextNumber =
      readdirSync(lockDir)
        .filter((entry) => entry.startsWith("ticket-"))
        .reduce((max, entry) => Math.max(max, ticketNumber(entry)), 0) + 1;
    const ticketName = `ticket-${String(nextNumber).padStart(16, "0")}-${id}`;
    ticketPath = join(lockDir, ticketName);
    writeFileSync(ticketPath, ownerIdentity(), { flag: "wx" });
    unlinkSync(choosingPath);
    return { choosingPath, ticketPath, ticketName };
  } catch (err) {
    for (const path of [choosingPath, ticketPath]) {
      if (!path) {
        continue;
      }
      try {
        unlinkSync(path);
      } catch {
        // The partial contender entry may already be gone.
      }
    }
    throw err;
  }
}

function liveLockEntries(
  lockDir: string,
  contender: LockContender,
): { choosing: string[]; tickets: string[] } {
  const now = Date.now();
  for (const entry of readdirSync(lockDir)) {
    const entryPath = join(lockDir, entry);
    if (
      entryPath === contender.choosingPath ||
      entryPath === contender.ticketPath
    ) {
      continue;
    }
    try {
      const info = statSync(entryPath);
      const ownerPid = lockOwnerPid(entry);
      // A recorded start tick that no longer matches the PID's current occupant
      // proves the original owner exited and the PID was recycled — reclaim it
      // even though kill(pid, 0) now succeeds for the unrelated process.
      const recorded = recordedStartTick(entryPath);
      const current =
        ownerPid === null ? undefined : processStartTick(ownerPid);
      const pidReused =
        recorded !== undefined && current !== undefined && recorded !== current;
      const ownerDead =
        ownerPid === null || pidReused || !isProcessAlive(ownerPid);
      if (now - info.mtimeMs > LOCK_STALE_MS && ownerDead) {
        unlinkSync(entryPath);
      }
    } catch {
      // Another contender may have released its unique entry.
    }
  }

  const entries = readdirSync(lockDir);
  return {
    choosing: entries.filter((entry) => entry.startsWith("choosing-")),
    tickets: entries.filter((entry) => entry.startsWith("ticket-")).sort(),
  };
}

function releaseTicket(lockDir: string, contender: LockContender): void {
  try {
    unlinkSync(contender.ticketPath);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      throw err;
    }
  }
  try {
    rmdirSync(lockDir);
  } catch {
    // Other contenders still have tickets in the directory.
  }
}

function acquireLock(filePath: string, wait: boolean): (() => void) | null {
  const lockDir = resolve(`${filePath}.lock`);
  if (heldLocks.has(lockDir)) {
    if (!wait) {
      return null;
    }
    throw new Error(`file lock ${lockDir}: recursive acquisition`);
  }

  const contender = createContender(lockDir);
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let backoff = LOCK_MIN_BACKOFF_MS;

  try {
    while (true) {
      const { choosing, tickets } = liveLockEntries(lockDir, contender);
      if (choosing.length === 0 && tickets[0] === contender.ticketName) {
        heldLocks.add(lockDir);
        let released = false;
        return () => {
          if (released) {
            return;
          }
          releaseTicket(lockDir, contender);
          released = true;
          heldLocks.delete(lockDir);
        };
      }
      if (!wait || Date.now() >= deadline) {
        releaseTicket(lockDir, contender);
        if (!wait) {
          return null;
        }
        throw new Error(
          `file lock ${lockDir}: timed out after ${String(LOCK_ACQUIRE_TIMEOUT_MS)}ms`,
        );
      }
      sleepSync(backoff + Math.floor(Math.random() * backoff));
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
    }
  } catch (err) {
    try {
      releaseTicket(lockDir, contender);
    } catch {
      // Preserve the acquisition error.
    }
    throw err;
  }
}

export function tryAcquireFileSyncLock(filePath: string): (() => void) | null {
  return acquireLock(filePath, false);
}

export function withFileSyncLock<T>(filePath: string, fn: () => T): T {
  const release = acquireLock(filePath, true);
  if (!release) {
    throw new Error(`file lock ${filePath}: acquisition failed`);
  }
  try {
    return fn();
  } finally {
    release();
  }
}
