import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  closeSync,
  openSync,
  ftruncateSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { collectDiffs } from "@/review/git.js";
import { selectFiles } from "@/review/selection.js";

const isPosix = process.platform !== "win32";

describe("collectDiffs never dereferences symlinks in the reviewed tree", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRepo(): { repo: string; outside: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "yukino-rev-sym-")));
    roots.push(root);
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    return { repo, outside };
  }

  it("excludes over-limit sparse files instead of reviewing a placeholder", async () => {
    const { repo } = makeRepo();
    const fd = openSync(join(repo, "large.txt"), "w");
    ftruncateSync(fd, 64 * 1024 * 1024);
    closeSync(fd);
    const diffs = await collectDiffs({ cwd: repo, mode: "workspace" });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].newFileContent).toBeUndefined();
    expect(selectFiles(diffs)[0].reason).toBe("too-large");
  });

  it.skipIf(!isPosix)(
    "keeps multiline symlink targets inside their diff hunk",
    async () => {
      const { repo } = makeRepo();
      symlinkSync("first\nsecond", join(repo, "multiline-link"));
      const [diff] = await collectDiffs({ cwd: repo, mode: "workspace" });
      expect(diff.hunks[0].newCount).toBe(2);
      expect(
        diff.hunks[0].lines
          .filter((line) => line.type === "added")
          .map((line) => line.content),
      ).toEqual(["first", "second"]);
    },
  );

  it.skipIf(!isPosix)(
    "keeps Git symlink semantics and never reads the out-of-repo target body",
    async () => {
      const { repo, outside } = makeRepo();
      const secretPath = join(outside, "secret.txt");
      writeFileSync(secretPath, "SUPER_SECRET_OUT_OF_REPO\n");
      symlinkSync(secretPath, join(repo, "leak.txt"));

      const diffs = await collectDiffs({ cwd: repo, mode: "workspace" });
      const leak = diffs.find((d) => d.newPath === "leak.txt");
      expect(leak).toBeDefined();
      // The link itself is represented with Git's symlink mode and target text.
      expect(leak?.diffText).toContain("120000");
      expect(leak?.diffText).toContain("secret.txt");
      // The target's body must never be pulled into memory.
      expect(leak?.newFileContent).toBeUndefined();
      expect(JSON.stringify(diffs)).not.toContain("SUPER_SECRET_OUT_OF_REPO");
    },
  );

  it.skipIf(!isPosix)(
    "does not hang when a symlink points at a FIFO",
    async () => {
      const { repo } = makeRepo();
      const fifo = join(repo, "hang.fifo");
      execFileSync("mkfifo", [fifo]);
      symlinkSync(fifo, join(repo, "fifo-link.txt"));

      // A regression blocks forever in open() on the FIFO; race a bounded wait
      // so the test fails instead of hanging the runner.
      const outcome = await Promise.race([
        collectDiffs({ cwd: repo, mode: "workspace" }).then(() => "returned"),
        new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            resolve("hung");
          }, 5000);
          timer.unref?.();
        }),
      ]);
      expect(outcome).toBe("returned");
    },
    15000,
  );
});
