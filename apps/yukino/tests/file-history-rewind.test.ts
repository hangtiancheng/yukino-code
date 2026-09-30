import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, it, expect } from "vitest";

import { FileHistory, fileHistoryDir } from "@/file-history/index.js";
import {
  getSessionFilePath,
  loadSession,
  rebuildFromSession,
  saveMessage,
  sessionLineCount,
  truncateSessionLines,
} from "@/session/index.js";

function makeTempProject(): { base: string; projectDir: string } {
  const base = mkdtempSync(join(tmpdir(), "yukino-fh-"));
  const projectDir = join(base, "project");
  mkdirSync(projectDir, { recursive: true });
  return { base, projectDir };
}

describe("FileHistory rewind", () => {
  it("deletes a file created after the target snapshot", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");

    // Round 1: no file changes, pure conversation, take a snapshot.
    fh.makeSnapshot(0, "Round 1");

    // Round 2: create a new file. trackEdit is called before the write, when the file does not exist yet.
    const newFile = join(projectDir, "new-file.ts");
    fh.trackEdit(newFile);
    writeFileSync(newFile, "export const x = 1;");
    fh.makeSnapshot(2, "Round 2: new file created");

    expect(existsSync(newFile)).toBe(true);

    // Rewind after reloading to prove the absent baseline survives restart.
    const resumed = new FileHistory(base, "session-1");
    const changed = resumed.rewind(0);

    expect(existsSync(newFile)).toBe(false);
    expect(changed).toContain(newFile);
  });

  it("restores a pre-existing baseline first tracked after the target", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");
    fh.makeSnapshot(0, "before tracking");

    const existing = join(projectDir, "late-edit.ts");
    writeFileSync(existing, "original before tracking");
    fh.trackEdit(existing);
    writeFileSync(existing, "modified");
    fh.makeSnapshot(1, "after tracking");

    const resumed = new FileHistory(base, "session-1");
    const changed = resumed.rewind(0);

    expect(readFileSync(existing, "utf-8")).toBe("original before tracking");
    expect(changed).toContain(existing);
  });

  it("retains an existing baseline when restore fails so rewind can retry", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");
    fh.makeSnapshot(0, "before tracking");

    const parent = join(projectDir, "nested");
    const existing = join(parent, "late-edit.ts");
    mkdirSync(parent);
    writeFileSync(existing, "original before tracking");
    fh.trackEdit(existing);
    writeFileSync(existing, "modified");
    fh.makeSnapshot(1, "after tracking");

    const baselineName = `${createHash("sha256")
      .update(existing)
      .digest("hex")
      .slice(0, 16)}@baseline`;
    const baselinePath = join(fileHistoryDir(base, "session-1"), baselineName);

    rmSync(parent, { recursive: true });
    writeFileSync(parent, "blocks directory creation");
    expect(fh.rewind(0)).not.toContain(existing);
    expect(existsSync(baselinePath)).toBe(true);

    rmSync(parent);
    mkdirSync(parent);
    const resumed = new FileHistory(base, "session-1");
    const changed = resumed.rewind(0);

    expect(readFileSync(existing, "utf-8")).toBe("original before tracking");
    expect(changed).toContain(existing);
    expect(existsSync(baselinePath)).toBe(false);
  });

  it("retains an absent baseline when deletion fails so rewind can retry", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");
    fh.makeSnapshot(0, "before tracking");

    const newFile = join(projectDir, "late-file.ts");
    fh.trackEdit(newFile);
    mkdirSync(newFile);

    expect(fh.rewind(0)).not.toContain(newFile);
    expect(existsSync(newFile)).toBe(true);

    rmSync(newFile, { recursive: true });
    writeFileSync(newFile, "created after failed rewind");
    const resumed = new FileHistory(base, "session-1");
    const changed = resumed.rewind(0);

    expect(changed).toContain(newFile);
    expect(existsSync(newFile)).toBe(false);
  });

  it("restores an edit on an existing file", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");

    const existing = join(projectDir, "existing.ts");
    writeFileSync(existing, "original");

    fh.trackEdit(existing);
    fh.makeSnapshot(0, "Round 1: snapshot before modification");

    writeFileSync(existing, "modified");
    fh.makeSnapshot(2, "Round 2: content changed");

    const changed = fh.rewind(0);

    expect(readFileSync(existing, "utf-8")).toBe("original");
    expect(changed).toContain(existing);
  });

  it("preserves a tracked file when its snapshot backup cannot be written", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");
    const file = join(projectDir, "file.ts");
    writeFileSync(file, "original");
    fh.trackEdit(file);

    const backupName = `${createHash("sha256")
      .update(file)
      .digest("hex")
      .slice(0, 16)}@s0`;
    mkdirSync(join(fileHistoryDir(base, "session-1"), backupName));
    fh.makeSnapshot(0, "backup fails");
    writeFileSync(file, "modified");

    const resumed = new FileHistory(base, "session-1");
    const changed = resumed.rewind(0);

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("modified");
    expect(changed).not.toContain(file);
  });

  it("keeps the created file when rewinding to its own snapshot", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");

    fh.makeSnapshot(0, "Round 1");

    const newFile = join(projectDir, "new-file.ts");
    fh.trackEdit(newFile);
    writeFileSync(newFile, "export const x = 1;");
    fh.makeSnapshot(2, "Round 2: new file created");

    // Rewinding to the snapshot taken after the file was created should keep the
    // file (with its content restored to what was written at that time).
    fh.rewind(1);

    expect(existsSync(newFile)).toBe(true);
    expect(readFileSync(newFile, "utf-8")).toBe("export const x = 1;");
  });

  it("restores a file whose parent directory was deleted after the snapshot", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");

    const nestedDir = join(projectDir, "src", "deep");
    const nested = join(nestedDir, "file.ts");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(nested, "original");

    fh.trackEdit(nested);
    fh.makeSnapshot(0, "Round 1: nested file present");

    writeFileSync(nested, "modified");
    fh.makeSnapshot(2, "Round 2: content changed");

    // The whole directory tree disappears before the rewind (e.g. git clean).
    rmSync(join(projectDir, "src"), { recursive: true, force: true });
    expect(existsSync(dirname(nested))).toBe(false);

    const changed = fh.rewind(0);

    expect(readFileSync(nested, "utf-8")).toBe("original");
    expect(changed).toContain(nested);
  });

  it("captures content at snapshot time, so rewinding to the latest snapshot keeps the latest edit", () => {
    const { base, projectDir } = makeTempProject();
    const fh = new FileHistory(base, "session-1");

    const file = join(projectDir, "file.ts");
    writeFileSync(file, "v1");

    fh.trackEdit(file);
    writeFileSync(file, "v2");
    fh.makeSnapshot(0, "after first edit");

    fh.trackEdit(file);
    writeFileSync(file, "v3");
    fh.makeSnapshot(1, "after second edit");

    const changed = fh.rewind(1);

    expect(changed).not.toContain(file);
    expect(readFileSync(file, "utf-8")).toBe("v3");
  });

  it("persists snapshots and reloads them in a new instance", () => {
    const { base, projectDir } = makeTempProject();
    const existing = join(projectDir, "file.ts");
    writeFileSync(existing, "original");

    const first = new FileHistory(base, "session-1");
    first.trackEdit(existing);
    first.makeSnapshot(1, "checkpoint");
    writeFileSync(existing, "modified");

    const second = new FileHistory(base, "session-1");
    expect(second.hasSnapshots()).toBe(true);
    const changed = second.rewind(0);

    expect(changed).toContain(existing);
    expect(readFileSync(existing, "utf-8")).toBe("original");
  });
});

describe("session log line coordinates", () => {
  it("counts non-empty lines and truncates the log to a snapshot coordinate", () => {
    const { base } = makeTempProject();
    saveMessage(base, "s1", {
      role: "user",
      content: "a",
      timestamp: 1,
    });
    saveMessage(base, "s1", {
      role: "assistant",
      content: "b",
      timestamp: 2,
    });
    saveMessage(base, "s1", {
      role: "user",
      content: "c",
      timestamp: 3,
    });
    const filePath = getSessionFilePath(base, "s1");

    expect(sessionLineCount(filePath)).toBe(3);

    truncateSessionLines(filePath, 2);

    expect(sessionLineCount(filePath)).toBe(2);
    const restored = rebuildFromSession(loadSession(base, "s1"));
    expect(restored).toHaveLength(2);
    expect(restored[1]?.content).toBe("b");
  });

  it("passes the session line count through the snapshot for rewind", () => {
    const { base } = makeTempProject();
    saveMessage(base, "s2", {
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    saveMessage(base, "s2", {
      role: "assistant",
      content: "hi",
      timestamp: 2,
    });

    const fh = new FileHistory(base, "s2");
    const lines = sessionLineCount(getSessionFilePath(base, "s2"));
    expect(lines).toBeDefined();
    fh.makeSnapshot(2, "turn complete", lines);

    const [snapshot] = fh.getSnapshots();
    expect(snapshot?.sessionLineCount).toBe(lines);
  });
});
