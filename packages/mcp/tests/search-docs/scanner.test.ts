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
