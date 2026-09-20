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

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";

import z, { safeParse } from "zod";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "teams" });

const FileMailMessageSchema = z.object({
  from: z.string(),
  text: z.string(),
  timestamp: z.string(),
  // timestamp: z
  //   .union([z.string(), z.number()])
  //   .nullish()
  //   .transform((v) => (!v ? "" : String(v))),

  // Read marker: false on delivery, set to true once the message is read or explicitly marked.
  read: z.boolean().optional(),
  // Three fields for structured messages; left empty for plain-text messages.
  // See the constants in protocol.ts for type values; requestId correlates responses
  // to their originating requests; approve uses an optional field to distinguish
  // "no response yet" from "explicitly rejected".
  type: z.string().optional(),
  requestId: z.string().optional(),
  approve: z.boolean().optional(),
});

export type FileMailMessage = z.infer<typeof FileMailMessageSchema>;

// ---------------------------------------------------------------------------
// File-based lock
//
// Uses exclusive-create (wx flag) on a .lock file.  Retries with a small
// random back-off until the LOCK_ACQUIRE_TIMEOUT_MS deadline.  Stale locks
// (older than LOCK_STALE_MS) are automatically removed so a crashed process
// cannot block others forever.
// ---------------------------------------------------------------------------

// Total timeout for acquiring the file lock. Throws on expiry so the caller can
// handle the failure — silently dropping messages is not acceptable.
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000; // Locks older than 10 s are considered abandoned (holder crashed) and may be preempted
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

function acquireLock(lockFile: string): void {
  // Exponential backoff with jitter to avoid multiple processes waking at the same instant and colliding repeatedly
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let backoff = LOCK_MIN_BACKOFF_MS;

  while (true) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails if the file already exists.
      const fd = openSync(lockFile, "wx");
      closeSync(fd);
      return; // lock acquired
    } catch (err: unknown) {
      log.error({ err }, "teams operation failed");
      const { data, success } = safeParse(ErrnoExceptionSchema, err);
      let code = "";
      if (success && data.code) {
        code = data.code;
      }
      if (code !== "EEXIST") {
        throw err; // unexpected filesystem error
      }
      // Lock is held by another process — check whether it is stale enough to take over

      try {
        const info = statSync(lockFile);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lockFile);
            continue;
          } catch (err) {
            log.error({ err }, "teams operation failed");
            // another process may have removed it already
          }
        }
      } catch (err2) {
        log.error({ err: err2 }, "teams operation failed");
        // stat failed — file may have been removed between our open and stat
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `mailbox lock ${lockFile}: timed out after ${String(LOCK_ACQUIRE_TIMEOUT_MS)}ms, message not written`,
        );
      }
      sleepSync(backoff + Math.floor(Math.random() * backoff));
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
    }
  }
}

function releaseLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch (err) {
    log.error({ err }, "teams operation failed");
    // best-effort — file may already be gone
  }
}

/** Execute `fn` while holding an exclusive .lock file for `filePath`. */
function withLock<T>(filePath: string, fn: () => T): T {
  const lockFile = filePath + ".lock";
  acquireLock(lockFile);
  try {
    return fn();
  } finally {
    releaseLock(lockFile);
  }
}

// ---------------------------------------------------------------------------

export class FileMailbox {
  private filePath: string;

  constructor(dir: string, memberName: string) {
    mkdirSync(dir, { recursive: true });
    // Each recipient owns a dedicated JSON array file; read state is tracked per-message via the read field.
    this.filePath = join(dir, `${memberName}.json`);
  }

  private readAll(): FileMailMessage[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
      const data: FileMailMessage[] = [];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const result = FileMailMessageSchema.safeParse(item);
          if (result.success) {
            data.push(result.data);
          }
        }
      }
      return data;
    } catch (err) {
      log.error({ err }, "teams operation failed");
      // Treat a corrupted file as an empty mailbox — one bad record should not block the entire teammate
      return [];
    }
  }

  private writeAll(messages: FileMailMessage[]): void {
    writeFileSync(this.filePath, JSON.stringify(messages, null, 2), "utf-8");
  }

  /**
   * Delivers a message. When `structured` is provided the entire message object is
   * persisted as-is, preserving the type / requestId / approve fields of structured messages.
   */
  async send(from: string, text: string, structured?: FileMailMessage): Promise<void> {
    const msg: FileMailMessage = structured ?? {
      from,
      text,
      timestamp: new Date().toISOString(),
    };
    msg.read = false;
    withLock(this.filePath, () => {
      const messages = this.readAll();
      messages.push(msg);
      this.writeAll(messages);
    });
    return Promise.resolve();
  }

  // Reads unread messages and marks them as read in place (read-modify-write on the full array).
  receiveSync(): FileMailMessage[] {
    return withLock(this.filePath, () => {
      const messages = this.readAll();
      const unread = messages.filter((m) => !m.read);
      if (unread.length > 0) {
        for (const m of messages) {
          m.read = true;
        }
        this.writeAll(messages);
      }
      return unread;
    });
  }

  async receive(): Promise<FileMailMessage[]> {
    return Promise.resolve(this.receiveSync());
  }

  // Counts unread messages without consuming them.
  unreadCount(): number {
    return this.readAll().filter((m) => !m.read).length;
  }

  // Marks all messages in the mailbox as read without returning their content.
  markAllRead(): void {
    withLock(this.filePath, () => {
      const messages = this.readAll();
      let changed = false;
      for (const m of messages) {
        if (!m.read) {
          m.read = true;
          changed = true;
        }
      }
      if (changed) {
        this.writeAll(messages);
      }
    });
  }

  async *poll(intervalMs = 1000): AsyncGenerator<FileMailMessage> {
    while (true) {
      const messages = await this.receive();
      for (const msg of messages) {
        yield msg;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
