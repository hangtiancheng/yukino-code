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

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanDocsDir } from "@/tools/docs/scanner.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "yukino-mcp-scanner-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scanDocsDir", () => {
  it("returns an empty list for a missing directory", async () => {
    expect(await scanDocsDir(path.join(dir, "nope"))).toEqual([]);
  });

  it("recursively collects supported files as POSIX-relative sources, sorted", async () => {
    await mkdir(path.join(dir, "guides", "deep"), { recursive: true });
    await writeFile(path.join(dir, "b.md"), "# B");
    await writeFile(path.join(dir, "a.txt"), "plain");
    await writeFile(path.join(dir, "guides", "deep", "c.markdown"), "# C");
    await writeFile(path.join(dir, "skip.pdf"), "binary");

    const docs = await scanDocsDir(dir);
    expect(docs.map((d) => d.source)).toEqual([
      "a.txt",
      "b.md",
      "guides/deep/c.markdown",
    ]);
    expect(docs[1].content).toBe("# B");
  });

  it("matches extensions case-insensitively", async () => {
    await writeFile(path.join(dir, "UPPER.MD"), "# U");
    const docs = await scanDocsDir(dir);
    expect(docs.map((d) => d.source)).toEqual(["UPPER.MD"]);
  });
});
