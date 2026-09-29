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

import { randomBytes } from "node:crypto";
import {
  readFileSync,
  unlinkSync,
  statSync,
  openSync,
  closeSync,
  writeSync,
} from "node:fs";

import { safeParse, z } from "zod";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "teams" });

// Total timeout for acquiring the file lock. Throws on expiry so the caller can
// handle the failure — silently dropping work is not acceptable.
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
// Locks older than this whose holder process died are considered abandoned and
// may be preempted; a live holder is never preempted.
const LOCK_STALE_MS = 10_000;
const LOCK_MIN_BACKOFF_MS = 5;
// Backoff cap to prevent unbounded retry delays under high concurrency.
const LOCK_MAX_BACKOFF_MS = 80;

const ErrnoExceptionSchema = z.looseObject({
  errno: z.number().optional(),
  code: z.string().optional(),
  path: z.string().optional(),
  syscall: z.string().optional(),
});

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether the given pid identifies a running process (EPERM still means alive). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const { data, success } = safeParse(ErrnoExceptionSchema, err);
    return success && data.code === "EPERM";
  }
}

/**
 * Reads the holder pid from a lock file. Returns undefined when the content is
 * unreadable or malformed — treated as a dead holder.
 */
function lockHolderPid(lockFile: string): number | undefined {
  try {
    const pid = Number.parseInt(
      readFileSync(lockFile, "utf-8").split(":")[0] ?? "",
      10,
    );
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates the lock file carrying this process's token ("<pid>:<random>") and
 * returns the token. Exclusive-create (wx) plus backoff-with-jitter until the
 * LOCK_ACQUIRE_TIMEOUT_MS deadline.
 */
function acquireLock(lockFile: string): string {
  const token = `${String(process.pid)}:${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let backoff = LOCK_MIN_BACKOFF_MS;

  while (true) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails if the file already exists.
      const fd = openSync(lockFile, "wx");
      writeSync(fd, token);
      closeSync(fd);
      return token; // lock acquired
    } catch (err: unknown) {
      const { data, success } = safeParse(ErrnoExceptionSchema, err);
      let code = "";
      if (success && data.code) {
        code = data.code;
      }
      if (code !== "EEXIST") {
        log.error({ err }, "file lock acquire failed");
        throw err; // unexpected filesystem error
      }
      // Lock is held by another process — preempt only when the holder died
      try {
        const info = statSync(lockFile);
        const holderPid = lockHolderPid(lockFile);
        const holderAlive = holderPid !== undefined && isPidAlive(holderPid);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS && !holderAlive) {
          try {
            unlinkSync(lockFile);
            continue;
          } catch (err2) {
            log.warn({ err: err2 }, "file lock stale-removal failed");
            // another process may have removed it already
          }
        }
      } catch (err3) {
        log.warn({ err: err3 }, "file lock stale-check failed");
        // stat failed — file may have been removed between our open and stat
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `file lock ${lockFile}: timed out after ${String(LOCK_ACQUIRE_TIMEOUT_MS)}ms`,
        );
      }
      sleepSync(backoff + Math.floor(Math.random() * backoff));
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
    }
  }
}

/**
 * Releases the lock, but only while it still belongs to us: after a stale
 * takeover the lock file belongs to another process and must be left alone.
 */
function releaseLock(lockFile: string, token: string): void {
  try {
    const current = readFileSync(lockFile, "utf-8").trim();
    if (current === token) {
      unlinkSync(lockFile);
    }
  } catch (err) {
    log.warn({ err }, "file lock release failed");
    // best-effort — file may already be gone
  }
}

/**
 * Executes `fn` while holding an exclusive `<filePath>.lock` file. Every
 * read-modify-write of a file shared across processes must go through this —
 * unlocked writers overwrite each other's changes and collide on IDs.
 */
export function withFileSyncLock<T>(filePath: string, fn: () => T): T {
  const lockFile = `${filePath}.lock`;
  const token = acquireLock(lockFile);
  try {
    return fn();
  } finally {
    releaseLock(lockFile, token);
  }
}
