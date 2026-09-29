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
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

import z from "zod";

import { withFileSyncLock } from "./file-lock.js";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "teams" });

const FileMailMessageSchema = z.object({
  from: z.string(),
  text: z.string(),
  timestamp: z.string(),

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
// Locking: every read-modify-write goes through withFileSyncLock (see
// file-lock.ts) — exclusive-create lock file with token-protected release,
// dead-holder-only preemption, and write-then-rename persistence below.
// ---------------------------------------------------------------------------

// Read messages retained in the mailbox file; older read messages are pruned
// on write so long-lived teams do not grow the file without bound. Unread
// messages are never dropped.
const MAX_READ_MESSAGES = 500;

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
    // Write-then-rename so a crash mid-write never leaves a truncated JSON
    // file behind (a reader would see an empty mailbox and lose history).
    const tmpPath = `${this.filePath}.${String(process.pid)}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(messages, null, 2), "utf-8");
    renameSync(tmpPath, this.filePath);
  }

  /**
   * Caps the number of read messages retained on disk. Unread messages are
   * never dropped; read messages are removed oldest-first (array order is
   * append order) so long-lived teams do not grow the file without bound.
   */
  private pruneRead(messages: FileMailMessage[]): FileMailMessage[] {
    const readCount = messages.reduce((n, m) => (m.read ? n + 1 : n), 0);
    if (readCount <= MAX_READ_MESSAGES) {
      return messages;
    }
    let excess = readCount - MAX_READ_MESSAGES;
    const dropped = new Set<FileMailMessage>();
    for (const m of messages) {
      if (excess === 0) {
        break;
      }
      if (m.read) {
        dropped.add(m);
        excess--;
      }
    }
    return messages.filter((m) => !dropped.has(m));
  }

  /**
   * Delivers a message. When `structured` is provided that message object is persisted
   * (with `read` forced to false), preserving the type / requestId / approve fields of
   * structured messages.
   */
  async send(
    from: string,
    text: string,
    structured?: FileMailMessage,
  ): Promise<void> {
    const msg: FileMailMessage = structured ?? {
      from,
      text,
      timestamp: new Date().toISOString(),
    };
    msg.read = false;
    withFileSyncLock(this.filePath, () => {
      const messages = this.readAll();
      messages.push(msg);
      this.writeAll(this.pruneRead(messages));
    });
    return Promise.resolve();
  }

  // Reads unread messages and marks them as read in place (read-modify-write on the full array).
  receiveSync(): FileMailMessage[] {
    return withFileSyncLock(this.filePath, () => {
      const messages = this.readAll();
      const unread = messages.filter((m) => !m.read);
      if (unread.length > 0) {
        for (const m of messages) {
          m.read = true;
        }
        this.writeAll(this.pruneRead(messages));
      }
      return unread;
    });
  }

  async receive(): Promise<FileMailMessage[]> {
    return Promise.resolve(this.receiveSync());
  }

  /**
   * Restores messages previously consumed by receiveSync as unread, appended
   * at the end of the mailbox. Used by consumers that wait for one specific
   * message and must not discard the others that arrived meanwhile.
   */
  requeue(messages: FileMailMessage[]): void {
    if (messages.length === 0) {
      return;
    }
    withFileSyncLock(this.filePath, () => {
      const all = this.readAll();
      for (const m of messages) {
        all.push({ ...m, read: false });
      }
      this.writeAll(this.pruneRead(all));
    });
  }

  // Counts unread messages without consuming them.
  unreadCount(): number {
    return withFileSyncLock(
      this.filePath,
      () => this.readAll().filter((m) => !m.read).length,
    );
  }

  // Marks all messages in the mailbox as read without returning their content.
  markAllRead(): void {
    withFileSyncLock(this.filePath, () => {
      const messages = this.readAll();
      let changed = false;
      for (const m of messages) {
        if (!m.read) {
          m.read = true;
          changed = true;
        }
      }
      if (changed) {
        this.writeAll(this.pruneRead(messages));
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
