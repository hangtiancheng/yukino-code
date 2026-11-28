import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { SNAPSHOTS_FILE_NAME } from "@/file-history/constants.js";
import { FileHistory, fileHistoryDir } from "@/file-history/index.js";
import { SessionManager } from "@/session/manager.js";
import { getYukinoDir } from "@/storage/index.js";

function project(): string {
  const directory = join(dirname(getYukinoDir()), "project");
  mkdirSync(directory, { recursive: true });
  return directory;
}
function baselinePath(file: string): string {
  const hash = createHash("sha256").update(file).digest("hex").slice(0, 16);
  return join(fileHistoryDir("session"), `${hash}@baseline`);
}
function snapshotId(history: FileHistory, entryId: string): string {
  const snapshot = history
    .getSnapshots()
    .find((item) => item.entryId === entryId);
  if (!snapshot) {
    throw new Error("Missing checkpoint fixture");
  }
  return snapshot.id;
}

describe("entry-ID file checkpoints", () => {
  it("binds checkpoints to entries and rewinds only by snapshot identity", () => {
    const manager = SessionManager.create(project());
    const entry = manager.append({ role: "user", content: "task" });
    const history = new FileHistory(manager.id);
    history.makeSnapshot(entry, "task");
    const snapshot = history.getSnapshots()[0];
    expect(snapshot).toMatchObject({ entryId: entry });
    expect(snapshot.id).not.toBe(entry);
    expect(snapshot).not.toHaveProperty("messageIndex");
    expect(snapshot).not.toHaveProperty("sessionLineCount");
    expect(() => {
      history.makeSnapshot(entry, "duplicate");
    }).toThrow("unique session entry");
    expect(() => history.rewind(entry)).toThrow("Unknown checkpoint snapshot");
    expect(history.rewind(snapshot.id)).toEqual([]);
  });

  it("restores tree A → B → A after restart without deleting any branch backups", () => {
    const manager = SessionManager.create(project());
    const file = join(project(), "file.ts");
    writeFileSync(file, "A");
    const history = new FileHistory(manager.id);
    history.trackEdit(file);
    const a = manager.append({ role: "user", content: "branch A" });
    history.makeSnapshot(a, "branch A");
    manager.append({ role: "assistant", content: "A reply" });
    manager.navigate(a);
    writeFileSync(file, "B");
    const b = manager.append({ role: "user", content: "branch B" });
    history.makeSnapshot(b, "branch B");
    manager.append({ role: "assistant", content: "B reply" });
    const backups = history
      .getSnapshots()
      .flatMap((snapshot) => Object.values(snapshot.backups))
      .flatMap((backup) =>
        backup.state === "existing" ? [backup.backupPath] : [],
      );
    expect(history.rewind(snapshotId(history, a))).toEqual([file]);
    manager.navigate(a);
    expect(readFileSync(file, "utf8")).toBe("A");
    writeFileSync(file, "C");
    const c = manager.append({ role: "user", content: "branch C" });
    history.makeSnapshot(c, "new branch");
    const resumed = new FileHistory(manager.id);
    resumed.rewind(snapshotId(resumed, b));
    manager.navigate(b);
    expect(readFileSync(file, "utf8")).toBe("B");
    resumed.rewind(snapshotId(resumed, a));
    manager.navigate(a);
    expect(readFileSync(file, "utf8")).toBe("A");
    expect(resumed.getSnapshots().map((snapshot) => snapshot.entryId)).toEqual([
      a,
      b,
      c,
    ]);
    expect(manager.getTree()).toHaveLength(3);
    expect(manager.getEntries()).toHaveLength(5);
    for (const backup of backups) {
      expect(existsSync(backup)).toBe(true);
    }
  });

  it("preserves baselines and future checkpoints when rewinding before first tracking", () => {
    const directory = project();
    const existing = join(directory, "existing.ts");
    const created = join(directory, "new.ts");
    writeFileSync(existing, "original");
    const history = new FileHistory("session");
    history.makeSnapshot("before", "before tracking");
    history.trackEdit(existing);
    history.trackEdit(created);
    writeFileSync(existing, "edited");
    writeFileSync(created, "created");
    history.makeSnapshot("after", "after edits");
    const resumed = new FileHistory("session");
    expect(resumed.rewind(snapshotId(resumed, "before")).sort()).toEqual(
      [existing, created].sort(),
    );
    expect(readFileSync(existing, "utf8")).toBe("original");
    expect(existsSync(created)).toBe(false);
    expect(existsSync(baselinePath(existing))).toBe(true);
    resumed.rewind(snapshotId(resumed, "after"));
    expect(readFileSync(existing, "utf8")).toBe("edited");
    expect(readFileSync(created, "utf8")).toBe("created");
    resumed.rewind(snapshotId(resumed, "before"));
    expect(readFileSync(existing, "utf8")).toBe("original");
    expect(existsSync(created)).toBe(false);
  });

  it("retries unavailable baseline restoration without losing the backup", () => {
    const parent = join(project(), "nested");
    const file = join(parent, "file.ts");
    mkdirSync(parent);
    writeFileSync(file, "original");
    const history = new FileHistory("session");
    history.makeSnapshot("before", "before");
    history.trackEdit(file);
    writeFileSync(file, "edited");
    history.makeSnapshot("after", "after");
    rmSync(parent, { recursive: true });
    writeFileSync(parent, "blocks mkdir");
    expect(history.rewind(snapshotId(history, "before"))).not.toContain(file);
    expect(existsSync(baselinePath(file))).toBe(true);
    rmSync(parent);
    mkdirSync(parent);
    const resumed = new FileHistory("session");
    resumed.rewind(snapshotId(resumed, "before"));
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(existsSync(baselinePath(file))).toBe(true);
  });

  it("retries deletion of a newly tracked file after a failure", () => {
    const file = join(project(), "new.ts");
    const history = new FileHistory("session");
    history.makeSnapshot("before", "before");
    history.trackEdit(file);
    mkdirSync(file);
    expect(history.rewind(snapshotId(history, "before"))).not.toContain(file);
    rmSync(file, { recursive: true });
    writeFileSync(file, "created");
    const resumed = new FileHistory("session");
    expect(resumed.rewind(snapshotId(resumed, "before"))).toContain(file);
    expect(existsSync(file)).toBe(false);
  });

  it("leaves unavailable snapshot backups untouched", () => {
    const file = join(project(), "file.ts");
    writeFileSync(file, "original");
    const history = new FileHistory("session");
    history.trackEdit(file);
    const hash = createHash("sha256").update(file).digest("hex").slice(0, 16);
    mkdirSync(join(fileHistoryDir("session"), `${hash}@s0`));
    history.makeSnapshot("checkpoint", "backup fails");
    writeFileSync(file, "edited");
    const resumed = new FileHistory("session");
    expect(resumed.rewind(snapshotId(resumed, "checkpoint"))).not.toContain(
      file,
    );
    expect(readFileSync(file, "utf8")).toBe("edited");
  });

  it("restores deleted parent directories and keeps immutable getter results", () => {
    const directory = join(project(), "nested");
    const file = join(directory, "file.ts");
    mkdirSync(directory);
    writeFileSync(file, "original");
    const history = new FileHistory("session");
    history.trackEdit(file);
    history.makeSnapshot("checkpoint", "checkpoint");
    const snapshots = history.getSnapshots();
    snapshots[0].backups = {};
    rmSync(directory, { recursive: true });
    history.rewind(snapshots[0].id);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("rejects and preserves obsolete snapshots and damaged state", () => {
    const directory = fileHistoryDir("session");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, SNAPSHOTS_FILE_NAME);
    for (const content of [
      JSON.stringify({
        version: 2,
        trackedFiles: [],
        snapshots: [],
        nextSnapshotSeq: 0,
      }),
      "{broken",
    ]) {
      writeFileSync(path, content);
      expect(() => new FileHistory("session")).toThrow(
        "Entry-ID checkpoints are required",
      );
      expect(readFileSync(path, "utf8")).toBe(content);
    }
  });
});
