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
  /** Snapshot-scoped destination for the file content. */
  backupPath: z.string(),
  time: z.string(),
  /** Capture failed, so rewind must leave the current file untouched. */
  unavailable: z.literal(true).optional(),
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

const FileBaselineSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("existing"),
    backupPath: z.string(),
  }),
  z.object({ state: z.literal("absent") }),
  z.object({ state: z.literal("unavailable") }),
]);

type FileBaseline = z.infer<typeof FileBaselineSchema>;

const PersistedStateSchema = z.object({
  version: z.literal(1),
  trackedFiles: z.array(z.string()),
  snapshots: z.array(SnapshotSchema),
  /** First-track file states used when rewinding before a file was tracked. */
  baselines: z.record(z.string(), FileBaselineSchema).optional(),
  /**
   * Monotonic counter for backup file names. Pruning shrinks the snapshots
   * array to a fixed length, so array positions would be reused as name
   * suffixes and overwrite still-live backups; the counter never repeats.
   * Absent in pre-evolution files — derived on load for those.
   */
  nextSnapshotSeq: z.number().optional(),
});

type PersistedState = z.infer<typeof PersistedStateSchema>;

function filePathHash(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

function getBackupName(filePath: string, snapshotIndex: number): string {
  return `${filePathHash(filePath)}@s${String(snapshotIndex)}`;
}

function getBaselineBackupName(filePath: string): string {
  return `${filePathHash(filePath)}@baseline`;
}

/** Single source of truth for a session's file-history directory layout. */
export function fileHistoryDir(baseDir: string, sessionId: string): string {
  return join(baseDir, ".yukino", "file-history", sessionId);
}

export class FileHistory {
  private sessionDir: string;

  /** Tracked file absolute paths. */
  private trackedFiles = new Set<string>();
  /** File state immediately before the first edit in this history branch. */
  private baselines = new Map<string, FileBaseline>();
  private snapshots: Snapshot[] = [];
  /** Monotonic backup-name counter; array positions recycle, this must not. */
  private nextSnapshotSeq = 0;

  constructor(baseDir: string, sessionID: string) {
    this.sessionDir = fileHistoryDir(baseDir, sessionID);
    mkdirSync(this.sessionDir, { recursive: true });
    this.load();
  }

  /**
   * Registers a file immediately before its first edit. Its original content,
   * absence, or an unavailable read is captured once so rewind can safely cross
   * the point where tracking began.
   */
  trackEdit(path: string): void {
    const filePath = resolve(path);
    if (!this.trackedFiles.has(filePath)) {
      this.baselines.set(filePath, this.captureBaseline(filePath));
      this.trackedFiles.add(filePath);
    }
    this.save();
  }

  private captureBaseline(filePath: string): FileBaseline {
    let content: Buffer<ArrayBuffer>;
    try {
      content = readFileSync(filePath);
    } catch (err: unknown) {
      const parsed = z
        .looseObject({ code: z.string().optional() })
        .safeParse(err);
      if (parsed.success && parsed.data.code === "ENOENT") {
        return { state: "absent" };
      }
      log.error({ err }, "file-history baseline capture failed");
      return { state: "unavailable" };
    }

    const backupPath = join(this.sessionDir, getBaselineBackupName(filePath));
    try {
      writeFileSync(backupPath, content);
      return { state: "existing", backupPath };
    } catch (err) {
      log.error({ err }, "file-history baseline capture failed");
      return { state: "unavailable" };
    }
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
    const snapshotIndex = this.nextSnapshotSeq;
    this.nextSnapshotSeq++;
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
        backups[filePath] = { backupPath, time: now, unavailable: true };
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
      const pruned = this.snapshots.slice(
        0,
        this.snapshots.length - MAX_SNAPSHOTS,
      );
      this.snapshots = this.snapshots.slice(
        this.snapshots.length - MAX_SNAPSHOTS,
      );
      // Pruned snapshots can no longer be rewound to: delete their backups so
      // the directory does not grow without bound.
      this.deleteBackups(pruned);
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
      if (backup.unavailable) {
        continue;
      }

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

    // Files first tracked after `target` have no snapshot entry. Restore their
    // first-track baseline: pre-existing files regain their original content,
    // truly new files are removed, and unavailable baselines are left untouched.
    const trackedAfterTarget = [...this.trackedFiles].filter(
      (path) => !(path in target.backups),
    );
    const unresolvedBaselines = new Set<string>();
    for (const filePath of trackedAfterTarget) {
      const baseline = this.baselines.get(filePath);
      let resolved = false;
      if (baseline?.state === "existing") {
        try {
          const baselineData = readFileSync(baseline.backupPath);
          let currentData: Buffer<ArrayBuffer> | null = null;
          try {
            currentData = readFileSync(filePath);
          } catch {
            // Missing current content is restored below.
          }
          if (!currentData || !baselineData.equals(currentData)) {
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, baselineData);
            changed.push(filePath);
          }
          resolved = true;
        } catch (err) {
          log.error({ err }, "file-history baseline restore failed");
        }
        if (resolved) {
          try {
            unlinkSync(baseline.backupPath);
          } catch {
            // Restoration no longer depends on the backup; cleanup is best-effort.
          }
        }
      } else if (baseline?.state === "absent") {
        if (!existsSync(filePath)) {
          resolved = true;
        } else {
          try {
            unlinkSync(filePath);
            changed.push(filePath);
            resolved = true;
          } catch (err) {
            log.error({ err }, "file-history baseline delete failed");
          }
        }
      }

      if (resolved) {
        this.baselines.delete(filePath);
      } else {
        // Keep both the first-track state and tracking membership so a later
        // rewind can retry after the transient restore/delete failure clears.
        unresolvedBaselines.add(filePath);
      }
    }

    // Truncate snapshot history -- can't redo forward. The removed snapshots
    // can no longer be reached: delete their backups from disk too.
    const removed = this.snapshots.slice(snapshotIndex + 1);
    this.deleteBackups(removed);
    this.snapshots = this.snapshots.slice(0, snapshotIndex + 1);
    this.trackedFiles = new Set([
      ...Object.keys(target.backups),
      ...unresolvedBaselines,
    ]);
    this.save();

    return changed;
  }

  /** Best-effort removal of the backup files owned by the given snapshots. */
  private deleteBackups(snapshots: Snapshot[]): void {
    for (const snapshot of snapshots) {
      for (const backup of Object.values(snapshot.backups)) {
        try {
          unlinkSync(backup.backupPath);
        } catch {
          // already gone — pruning must not fail on it
        }
      }
    }
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
      baselines: Object.fromEntries(this.baselines),
      nextSnapshotSeq: this.nextSnapshotSeq,
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
    this.nextSnapshotSeq = state.nextSnapshotSeq ?? state.snapshots.length;
    for (const [path, baseline] of Object.entries(state.baselines ?? {})) {
      this.baselines.set(path, baseline);
    }
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
    // Legacy histories lack baselines. Treat those as unavailable rather than
    // guessing that a file first tracked after a target snapshot was new.
    for (const path of this.trackedFiles) {
      if (!this.baselines.has(path)) {
        this.baselines.set(path, { state: "unavailable" });
      }
    }
  }
}
