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

import { FileHistory } from "@/file-history/index.js";

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

    // Rewind to the round-1 snapshot, i.e. the state before this file was created.
    const changed = fh.rewind(0);

    expect(existsSync(newFile)).toBe(false);
    expect(changed).toContain(newFile);
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
});
