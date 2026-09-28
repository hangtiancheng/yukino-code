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

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";

import { safeParse, z } from "zod";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "file-history" });

const MAX_SNAPSHOTS = 100;
const MAX_SUMMARY_TEXT_LENGTH = 60;

export const BackupSchema = z.object({
  /**
   * Snapshot-scoped copy of the file content; absent on disk = the path did
   * not exist at snapshot time.
   */
  backupPath: z.string(),
  time: z.string(),
});

export type Backup = z.infer<typeof BackupSchema>;

export const SnapshotSchema = z.object({
  messageIndex: z.number(),
  userText: z.string(),
  backups: z.record(z.string(), BackupSchema),
  timestamp: z.string(),
  /**
   * Session-log line count at snapshot time. This is the authoritative rewind
   * coordinate: unlike messageIndex it survives resume and compaction, because
   * the session file is replayed 1:1 on resume. Undefined for snapshots taken
   * without a session log.
   */
  sessionLineCount: z.number().optional(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

const PersistedStateSchema = z.object({
  version: z.literal(1),
  trackedFiles: z.array(z.string()),
  snapshots: z.array(SnapshotSchema),
});

type PersistedState = z.infer<typeof PersistedStateSchema>;

function getBackupName(filePath: string, snapshotIndex: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${hash}@s${String(snapshotIndex)}`;
}

/** Single source of truth for a session's file-history directory layout. */
export function fileHistoryDir(baseDir: string, sessionId: string): string {
  return join(baseDir, ".yukino", "file-history", sessionId);
}

export class FileHistory {
  private sessionDir: string;

  /** Tracked file absolute paths. */
  private trackedFiles = new Set<string>();
  private snapshots: Snapshot[] = [];

  constructor(baseDir: string, sessionID: string) {
    this.sessionDir = fileHistoryDir(baseDir, sessionID);
    mkdirSync(this.sessionDir, { recursive: true });
    this.load();
  }

  /**
   * Register a file about to be modified by a tool. Content is captured at
   * snapshot time (not here), so a failed edit or a re-edit leaves no stale
   * copies behind.
   */
  trackEdit(path: string): void {
    this.trackedFiles.add(resolve(path));
    this.save();
  }

  /**
   * Capture the current content of every tracked file as a checkpoint.
   *
   * `sessionLineCount` records the session-log coordinate of this moment so
   * /rewind can truncate the session file exactly; the agent passes it because
   * only the agent knows where the log lives.
   */
  makeSnapshot(
    messageIndex: number,
    userText: string,
    sessionLineCount?: number,
  ): void {
    let text = userText;
    if (text.length > MAX_SUMMARY_TEXT_LENGTH) {
      text = text.slice(0, MAX_SUMMARY_TEXT_LENGTH) + "...";
    }
    const now = new Date().toISOString();
    const snapshotIndex = this.snapshots.length;
    const backups: Record<string, Backup> = {};
    for (const filePath of this.trackedFiles) {
      const backupPath = join(
        this.sessionDir,
        getBackupName(filePath, snapshotIndex),
      );
      if (!existsSync(filePath)) {
        // Absent at snapshot time: keep the entry with an unwritten backup path;
        // rewind treats a missing backup file as "delete this file".
        backups[filePath] = { backupPath, time: now };
        continue;
      }
      try {
        writeFileSync(backupPath, readFileSync(filePath));
      } catch (err) {
        log.error({ err }, "file-history operation failed");
        // Unreadable: skip the file entirely so a rewind never deletes it.
        continue;
      }
      backups[filePath] = { backupPath, time: now };
    }
    this.snapshots.push({
      messageIndex,
      userText: text,
      backups,
      timestamp: now,
      ...(sessionLineCount === undefined ? {} : { sessionLineCount }),
    });

    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(
        this.snapshots.length - MAX_SNAPSHOTS,
      );
    }
    this.save();
  }

  rewind(snapshotIndex: number): string[] {
    if (snapshotIndex < 0 || snapshotIndex >= this.snapshots.length) {
      throw new Error(`Invalid snapshot index: ${String(snapshotIndex)}`);
    }

    const target = this.snapshots[snapshotIndex];
    const changed: string[] = [];
    for (const [filePath, backup] of Object.entries(target.backups)) {
      let backupData: Buffer<ArrayBuffer> | null = null;
      try {
        backupData = readFileSync(backup.backupPath);
      } catch {
        // Backup missing -> file didn't exist at snapshot time -> delete it now.
        if (existsSync(filePath)) {
          try {
            unlinkSync(filePath);
            changed.push(filePath);
          } catch (err) {
            log.error({ err }, "file-history operation failed");
          }
        }
        continue;
      }

      // Compare with current file
      let currentData: Buffer<ArrayBuffer> | null = null;
      try {
        currentData = readFileSync(filePath);
      } catch (err) {
        // File doesn't exist now but backup exists -> restore
        log.error({ err }, "file-history operation failed");
      }

      const backupStr = backupData.toString();
      const currentStr = currentData?.toString();
      if (backupStr !== currentStr) {
        try {
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, backupData);
          changed.push(filePath);
        } catch (err) {
          log.error({ err }, "file-history operation failed");
        }
      }
    }

    // Files first tracked after `target` have no record in target.backups, so the
    // loop above never touches them: they did not exist at that point in time, so
    // rewinding to it must delete them rather than leave them on disk.
    const createdAfterTarget = [...this.trackedFiles].filter(
      (p) => !(p in target.backups),
    );
    for (const filePath of createdAfterTarget) {
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
          changed.push(filePath);
        } catch {
          // skip
        }
      }
      this.trackedFiles.delete(filePath);
    }

    // Truncate snapshot history -- can't redo forward
    this.snapshots = this.snapshots.slice(0, snapshotIndex + 1);
    this.trackedFiles = new Set(Object.keys(target.backups));
    this.save();

    return changed;
  }

  getSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }

  hasSnapshots(): boolean {
    return this.snapshots.length > 0;
  }

  save(): void {
    const state: PersistedState = {
      version: 1,
      trackedFiles: [...this.trackedFiles],
      snapshots: this.snapshots,
    };
    try {
      writeFileSync(
        join(this.sessionDir, "snapshots.json"),
        JSON.stringify(state, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.error({ err }, "file-history operation failed");
    }
  }

  private load(): void {
    const filePath = join(this.sessionDir, "snapshots.json");
    if (!existsSync(filePath)) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (err) {
      log.error({ err }, "file-history operation failed");
      return;
    }
    const result = safeParse(PersistedStateSchema, raw);
    if (!result.success) {
      log.error({ err: result.error }, "file-history operation failed");
      return;
    }
    const state: PersistedState = result.data;
    this.snapshots = state.snapshots;
    if (state.trackedFiles.length > 0) {
      for (const path of state.trackedFiles) {
        this.trackedFiles.add(path);
      }
    } else if (state.snapshots.length > 0) {
      // Rebuild tracking from the newest snapshot so post-resume edits of
      // already-tracked files keep landing in new snapshots.
      const last = state.snapshots[state.snapshots.length - 1];
      for (const path of Object.keys(last.backups)) {
        this.trackedFiles.add(path);
      }
    }
  }
}
