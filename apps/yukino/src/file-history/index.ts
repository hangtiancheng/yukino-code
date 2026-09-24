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

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "file-history" });

const MAX_SNAPSHOTS = 100;
const MAX_SUMMARY_TEXT_LENGTH = 60;

export interface Backup {
  backupPath: string;
  version: number;
  time: string;
}

export interface Snapshot {
  messageIndex: number;
  userText: string;
  backups: Record<string, Backup>;
  timestamp: string;
}

function getBackupName(filePath: string, version: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${hash}@v${String(version)}`;
}

/** Single source of truth for a session's file-history directory layout. */
export function fileHistoryDir(baseDir: string, sessionId: string): string {
  return join(baseDir, ".yukino", "file-history", sessionId);
}

export class FileHistory {
  private sessionDir: string;

  /** Tracked file absolute path to version */
  private trackedFiles = new Map<string, number>();
  private snapshots: Snapshot[] = [];

  constructor(baseDir: string, sessionID: string) {
    this.sessionDir = fileHistoryDir(baseDir, sessionID);
    mkdirSync(this.sessionDir, { recursive: true });
  }

  trackEdit(path: string): void {
    const absPath = resolve(path);
    const version = this.trackedFiles.get(absPath) ?? 0;
    const newVersion = version + 1;
    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath);
        const backupName = getBackupName(absPath, newVersion);
        writeFileSync(join(this.sessionDir, backupName), content);
      } catch (err) {
        log.error({ err }, "file-history operation failed");
        // Skip unreadable file
      }
    }

    // If file doesn't exist, we still bump version
    // -- signals "file didn't exist" on rewind
    this.trackedFiles.set(absPath, newVersion);
  }

  makeSnapshot(messageIndex: number, userText: string): void {
    let text = userText;
    if (text.length > MAX_SUMMARY_TEXT_LENGTH) {
      text = text.slice(0, MAX_SUMMARY_TEXT_LENGTH) + "...";
    }
    const backups: Record<string, Backup> = {};
    for (const [filePath, version] of this.trackedFiles) {
      const backupName = getBackupName(filePath, version);
      const backupPath = join(this.sessionDir, backupName);

      // Safety net: if backup doesn't exist yet but file does, create it now.
      if (!existsSync(backupPath) && existsSync(filePath)) {
        try {
          writeFileSync(backupPath, readFileSync(filePath));
        } catch (err) {
          log.error({ err }, "file-history operation failed");
          // Skip...
        }
      }

      backups[filePath] = {
        backupPath,
        version,
        time: new Date().toISOString(),
      };
    }
    this.snapshots.push({
      messageIndex,
      userText: text,
      backups,
      timestamp: new Date().toISOString(),
    });

    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(
        this.snapshots.length - MAX_SNAPSHOTS,
      );
    }
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
      } catch (err) {
        log.error({ err }, "file-history operation failed");

        // Backup missing -> file didn't exist at snapshot time -> delete it now.
        if (existsSync(filePath)) {
          try {
            unlinkSync(filePath);
          } catch (err2) {
            log.error({ err: err2 }, "file-history operation failed");
            // Skip
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

          // Skip
        }
      }
    }

    // Files first tracked after `target` have no record in target.backups, so the
    // loop above never touches them: they did not exist at that point in time, so
    // rewinding to it must delete them rather than leave them on disk.
    const createdAfterTarget = [...this.trackedFiles.keys()].filter(
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

    // Reset version counters to snapshot state
    for (const [filePath, backup] of Object.entries(target.backups)) {
      this.trackedFiles.set(filePath, backup.version);
    }

    return changed;
  }

  getSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }

  hasSnapshots(): boolean {
    return this.snapshots.length > 0;
  }

  save(): void {
    const filePath = join(this.sessionDir, "snapshots.json");
    writeFileSync(filePath, JSON.stringify(this.snapshots, null, 2), "utf-8");
  }
}
