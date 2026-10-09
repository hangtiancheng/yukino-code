import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  rmSync,
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

// Locking: every read-modify-write goes through withFileSyncLock (see
// file-lock.ts) — a lock directory of exclusive-create contender entries,
// token-protected release, dead-holder-only preemption, and
// write-then-rename persistence below.

const MAX_READ_MESSAGES = 500;

export class FileMailbox {
  private filePath: string;

  constructor(dir: string, memberName: string) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(memberName)) {
      throw new Error("Invalid mailbox member name");
    }
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
      return z.array(FileMailMessageSchema).parse(raw);
    } catch (err) {
      log.error({ err }, "teams operation failed");
      throw new Error(
        "Cannot load an unreadable teammate mailbox; original contents were preserved",
        { cause: err },
      );
    }
  }

  private writeAll(messages: FileMailMessage[]): void {
    // Write-then-rename so a crash mid-write never leaves a truncated JSON
    // file behind (a reader would see an empty mailbox and lose history).
    const tmpPath = `${this.filePath}.${String(process.pid)}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(messages, null, 2), "utf-8");
      renameSync(tmpPath, this.filePath);
    } finally {
      rmSync(tmpPath, { force: true });
    }
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
    this.sendSync(from, text, structured);
    return Promise.resolve();
  }

  sendSync(from: string, text: string, structured?: FileMailMessage): void {
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
  }

  receiveSync(): FileMailMessage[] {
    return this.receiveMatchingSync(() => true);
  }

  receiveMatchingSync(
    predicate: (message: FileMailMessage) => boolean,
  ): FileMailMessage[] {
    return withFileSyncLock(this.filePath, () => {
      const messages = this.readAll();
      const unread = messages.filter((m) => !m.read && predicate(m));
      if (unread.length > 0) {
        for (const m of unread) {
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

  unreadCount(): number {
    return withFileSyncLock(
      this.filePath,
      () => this.readAll().filter((m) => !m.read).length,
    );
  }
}
