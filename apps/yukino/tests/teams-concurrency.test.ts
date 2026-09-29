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
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileHistory } from "@/file-history/index.js";
import { FileMailbox } from "@/teams/file-mailbox.js";
import { SharedTaskStore } from "@/teams/shared-task.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yukino-conc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("SharedTaskStore cross-instance writes", () => {
  it("create() reloads under the lock so a stale in-memory counter cannot collide", () => {
    const dir = makeTempDir();
    const path = join(dir, "tasks.json");
    const a = new SharedTaskStore(path);
    const b = new SharedTaskStore(path);

    const first = a.create("first");
    expect(first.id).toBe("1");

    // b was constructed before a's create, so its in-memory nextId is still
    // 1. Without the in-lock reload it would reuse id "1" and its save would
    // drop a's task entirely.
    const second = b.create("second");
    expect(second.id).toBe("2");

    const tasks = new SharedTaskStore(path).listTasks();
    expect(tasks.map((t) => t.title).sort()).toEqual(["first", "second"]);
  });

  it("update() reloads under the lock so it cannot resurrect a dropped task list", () => {
    const dir = makeTempDir();
    const path = join(dir, "tasks.json");
    const a = new SharedTaskStore(path);
    const b = new SharedTaskStore(path);

    a.create("first");
    b.create("second");

    // a's in-memory task list only knows about "first"; without the in-lock
    // reload its save would wipe "second".
    const updated = a.update("2", { status: "completed" });
    expect(updated?.status).toBe("completed");

    const tasks = new SharedTaskStore(path).listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === "2")?.status).toBe("completed");
  });
});

describe("FileMailbox lock discipline", () => {
  it("releases the lock file once the operation completes", () => {
    const dir = makeTempDir();
    const mailbox = new FileMailbox(dir, "leader");
    void mailbox.send("ann", "hello");
    expect(existsSync(join(dir, "leader.json.lock"))).toBe(false);
    expect(mailbox.unreadCount()).toBe(1);
  });

  it("takes over a stale lock whose holder process is dead", () => {
    const dir = makeTempDir();
    const mailbox = new FileMailbox(dir, "leader");
    const lockPath = join(dir, "leader.json.lock");
    // A holder pid that cannot exist and an mtime far past the stale
    // threshold: the next operation must preempt it, not time out.
    writeFileSync(lockPath, "999999999:deadbeef");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    expect(mailbox.unreadCount()).toBe(0);
    // The takeover lock was ours to release: it must be gone.
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("FileHistory snapshot sequencing", () => {
  it("never reuses backup names after pruning reaches the cap", () => {
    const baseDir = makeTempDir();
    const sessionId = "seq-test";
    const fh = new FileHistory(baseDir, sessionId);
    const file = join(baseDir, "f.txt");
    writeFileSync(file, "content-0");
    fh.trackEdit(file);

    // One more snapshot than the retention cap, each with distinct content.
    for (let i = 0; i < 101; i++) {
      fh.makeSnapshot(i, `s${String(i)}`);
      writeFileSync(file, `content-${String(i + 1)}`);
    }

    const afterCap = fh.getSnapshots();
    expect(afterCap.length).toBeLessThanOrEqual(100);

    // The snapshot taken past the cap must not overwrite the surviving
    // backups (the pre-fix code reused array positions as name suffixes).
    writeFileSync(file, "content-101");
    fh.makeSnapshot(999, "after-cap");
    const snaps = fh.getSnapshots();
    const newest = snaps[snaps.length - 1];
    const prev = snaps[snaps.length - 2];
    expect(readFileSync(newest.backups[file]?.backupPath ?? "", "utf-8")).toBe(
      "content-101",
    );
    expect(readFileSync(prev.backups[file]?.backupPath ?? "", "utf-8")).toBe(
      "content-100",
    );

    // Pruning must delete the evicted backups, not just forget them.
    const sessionDir = join(baseDir, ".yukino", "file-history", sessionId);
    const backupCount = readdirSync(sessionDir).filter((f) =>
      f.includes("@s"),
    ).length;
    expect(backupCount).toBeLessThanOrEqual(100);
  });
});
