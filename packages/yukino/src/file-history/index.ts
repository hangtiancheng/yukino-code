import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";

import { safeParse, z } from "zod";

import {
  FILE_HISTORY_DIR_NAME,
  INVALID_FILE_HISTORY,
  MAX_SNAPSHOTS,
  MAX_SUMMARY_TEXT_LENGTH,
  PERSISTED_STATE_VERSION,
  SNAPSHOTS_FILE_NAME,
} from "@/file-history/constants.js";
import { createChildLogger } from "@/logger/index.js";
import { sessionPath } from "@/storage/index.js";
import { writePrivateFileAtomicallySync } from "@/storage/private.js";
import {
  mkdirPrivateSync,
  writePrivateFileSync,
  readPrivateFileSync,
} from "@/storage/private.js";
import { withFileSyncLock } from "@/teams/file-lock.js";

export * from "@/file-history/constants.js";

const log = createChildLogger({ module: "file-history" });

export const BackupSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("existing"),
    backupPath: z.string(),
    time: z.string(),
  }),
  z.object({ state: z.literal("absent"), time: z.string() }),
  z.object({ state: z.literal("unavailable"), time: z.string() }),
]);

export type Backup = z.infer<typeof BackupSchema>;

export const SnapshotSchema = z.strictObject({
  id: z.uuid(),
  entryId: z.string().min(1),
  userText: z.string(),
  backups: z.record(z.string(), BackupSchema),
  timestamp: z.iso.datetime(),
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

const PersistedStateSchema = z.strictObject({
  version: z.literal(PERSISTED_STATE_VERSION),
  trackedFiles: z.array(z.string()),
  snapshots: z.array(SnapshotSchema).max(MAX_SNAPSHOTS),
  baselines: z.record(z.string(), FileBaselineSchema),
  nextSnapshotSeq: z.number().int().nonnegative(),
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
export function fileHistoryDir(sessionId: string): string {
  return sessionPath(sessionId, FILE_HISTORY_DIR_NAME);
}

export class FileHistory {
  private sessionDir: string;
  private statePath: string;
  private readonly enabled: boolean;

  /** Tracked file absolute paths. */
  private trackedFiles = new Set<string>();
  /** Session-owned first-track states, retained across all branches. */
  private baselines = new Map<string, FileBaseline>();
  private snapshots: Snapshot[] = [];
  /** Monotonic backup-name counter shared by every branch. */
  private nextSnapshotSeq = 0;

  constructor(
    sessionID: string,
    persist = true,
    private readonly onBeforeEdit?: (path: string) => void,
  ) {
    this.enabled = persist;
    this.sessionDir = fileHistoryDir(sessionID);
    this.statePath = join(this.sessionDir, SNAPSHOTS_FILE_NAME);
    if (!persist) {
      return;
    }
    mkdirPrivateSync(this.sessionDir);
    withFileSyncLock(this.statePath, () => {
      this.loadUnlocked();
    });
  }

  /**
   * Registers a file immediately before its first edit. Its original content,
   * absence, or an unavailable read is captured once so rewind can safely cross
   * the point where tracking began.
   */
  trackEdit(path: string): void {
    if (!this.enabled) {
      return;
    }
    this.onBeforeEdit?.(resolve(path));
    withFileSyncLock(this.statePath, () => {
      this.loadUnlocked();
      const filePath = resolve(path);
      if (!this.trackedFiles.has(filePath)) {
        this.baselines.set(filePath, this.captureBaseline(filePath));
        this.trackedFiles.add(filePath);
      }
      this.saveUnlocked();
    });
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
      writePrivateFileSync(backupPath, content);
      return { state: "existing", backupPath };
    } catch (err) {
      log.error({ err }, "file-history baseline capture failed");
      return { state: "unavailable" };
    }
  }

  makeSnapshot(entryId: string, userText: string): void {
    if (!this.enabled) {
      return;
    }
    withFileSyncLock(this.statePath, () => {
      this.loadUnlocked();
      if (
        typeof entryId !== "string" ||
        !entryId ||
        this.snapshots.some((snapshot) => snapshot.entryId === entryId)
      ) {
        throw new Error("Checkpoint requires a unique session entry ID.");
      }
      if (this.snapshots.length >= MAX_SNAPSHOTS) {
        throw new Error(
          "File-history checkpoint limit reached; existing branch backups are preserved.",
        );
      }
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
          backups[filePath] = { state: "absent", time: now };
          continue;
        }
        try {
          writePrivateFileSync(backupPath, readFileSync(filePath));
          backups[filePath] = { state: "existing", backupPath, time: now };
        } catch (err) {
          log.error({ err }, "file-history operation failed");
          backups[filePath] = { state: "unavailable", time: now };
        }
      }
      this.snapshots.push({
        id: randomUUID(),
        entryId,
        userText: text,
        backups,
        timestamp: now,
      });
      this.saveUnlocked();
    });
  }

  rewind(snapshotId: string): string[] {
    if (!this.enabled) {
      return [];
    }
    return withFileSyncLock(this.statePath, () => {
      this.loadUnlocked();
      return this.rewindUnlocked(snapshotId);
    });
  }

  private rewindUnlocked(snapshotId: string): string[] {
    const target = this.snapshots.find(
      (snapshot) => snapshot.id === snapshotId,
    );
    if (!target) {
      throw new Error(`Unknown checkpoint snapshot: ${snapshotId}`);
    }
    const changed: string[] = [];
    for (const [filePath, backup] of Object.entries(target.backups)) {
      if (backup.state === "unavailable") {
        continue;
      }

      if (backup.state === "absent") {
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

      let backupData: Buffer<ArrayBuffer>;
      try {
        backupData = readPrivateFileSync(backup.backupPath);
      } catch (err) {
        log.error({ err }, "file-history backup read failed");
        continue;
      }

      let currentData: Buffer<ArrayBuffer> | null = null;
      try {
        currentData = readFileSync(filePath);
      } catch (err) {
        // File doesn't exist now but backup exists -> restore
        log.error({ err }, "file-history operation failed");
      }

      if (!currentData || !backupData.equals(currentData)) {
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
    for (const filePath of trackedAfterTarget) {
      const baseline = this.baselines.get(filePath);
      if (baseline?.state === "existing") {
        try {
          const baselineData = readPrivateFileSync(baseline.backupPath);
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
        } catch (err) {
          log.error({ err }, "file-history baseline restore failed");
        }
      } else if (baseline?.state === "absent" && existsSync(filePath)) {
        try {
          unlinkSync(filePath);
          changed.push(filePath);
        } catch (err) {
          log.error({ err }, "file-history baseline delete failed");
        }
      }
    }

    return changed;
  }

  getSnapshots(): Snapshot[] {
    if (!this.enabled) {
      return [];
    }
    return withFileSyncLock(this.statePath, () => {
      this.loadUnlocked();
      return structuredClone(this.snapshots);
    });
  }

  hasSnapshots(): boolean {
    if (!this.enabled) {
      return false;
    }
    return withFileSyncLock(this.statePath, () => {
      this.loadUnlocked();
      return this.snapshots.length > 0;
    });
  }

  private saveUnlocked(): void {
    const state: PersistedState = {
      version: PERSISTED_STATE_VERSION,
      trackedFiles: [...this.trackedFiles],
      snapshots: this.snapshots,
      baselines: Object.fromEntries(this.baselines),
      nextSnapshotSeq: this.nextSnapshotSeq,
    };
    writePrivateFileAtomicallySync(
      this.statePath,
      JSON.stringify(state, null, 2),
    );
  }

  private loadUnlocked(): void {
    this.trackedFiles = new Set();
    this.baselines = new Map();
    this.snapshots = [];
    this.nextSnapshotSeq = 0;
    if (!existsSync(this.statePath)) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readPrivateFileSync(this.statePath, "utf-8"));
    } catch (err) {
      throw new Error(INVALID_FILE_HISTORY, { cause: err });
    }
    const result = safeParse(PersistedStateSchema, raw);
    if (!result.success) {
      throw new Error(INVALID_FILE_HISTORY, { cause: result.error });
    }
    const state: PersistedState = result.data;
    if (
      new Set(state.snapshots.map((snapshot) => snapshot.entryId)).size !==
        state.snapshots.length ||
      new Set(state.snapshots.map((snapshot) => snapshot.id)).size !==
        state.snapshots.length ||
      state.nextSnapshotSeq < state.snapshots.length
    ) {
      throw new Error(INVALID_FILE_HISTORY);
    }
    this.snapshots = state.snapshots;
    this.nextSnapshotSeq = state.nextSnapshotSeq;
    this.baselines = new Map(Object.entries(state.baselines));
    this.trackedFiles = new Set(state.trackedFiles);
  }
}
