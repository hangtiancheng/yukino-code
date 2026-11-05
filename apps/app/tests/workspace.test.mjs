import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Workspace } from "../src/main/workspace.ts";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "yukino-workspace-"));
  const workspace = new Workspace(root, () => {});
  try {
    await run(workspace, root);
  } finally {
    workspace.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("reads and saves text without overwriting concurrent disk changes", async () =>
  fixture(async (workspace, root) => {
    await writeFile(join(root, "hello.ts"), "const hello = 1;\n");
    const initial = await workspace.read("hello.ts");
    await workspace.save("hello.ts", "const hello = 2;\n", initial.revision);
    await writeFile(join(root, "hello.ts"), "agent changed this\n");
    await assert.rejects(
      workspace.save("hello.ts", "stale user draft", initial.revision),
      /已被 Agent/,
    );
    assert.equal(
      await readFile(join(root, "hello.ts"), "utf8"),
      "agent changed this\n",
    );
  }));

test("blocks traversal and symlinks escaping the workspace", async () =>
  fixture(async (workspace, root) => {
    const outside = await mkdtemp(join(tmpdir(), "yukino-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(root, "escape"));
      await assert.rejects(workspace.read("../outside"), /当前项目/);
      await assert.rejects(workspace.read("escape/secret.txt"), /当前项目/);
      assert.equal(
        (await workspace.list()).some((entry) => entry.name === "escape"),
        false,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }));

test("hides generated directories and rejects binary and oversized files", async () =>
  fixture(async (workspace, root) => {
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "binary"), Buffer.from([1, 0, 2]));
    await writeFile(join(root, "large"), "a".repeat(2 * 1024 * 1024 + 1));
    assert.equal(
      (await workspace.list()).some((entry) => entry.name === "node_modules"),
      false,
    );
    await assert.rejects(workspace.read("binary"), /二进制/);
    await assert.rejects(workspace.read("large"), /2 MB/);
  }));

test("keeps pre-edit baseline and emits watcher updates for Agent writes", async () =>
  fixture(async (workspace, root) => {
    await writeFile(join(root, "source.ts"), "before\n");
    await workspace.capture("source.ts");
    const update = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("watcher timed out")),
        4000,
      );
      const watcher = new Workspace(root, (path) => {
        clearTimeout(timer);
        watcher.dispose();
        resolve(path);
      });
      watcher.start();
    });
    await writeFile(join(root, "source.ts"), "after\n");
    assert.equal(await update, "source.ts");
    const next = await workspace.read("source.ts");
    assert.equal(next.baseline, "before\n");
    assert.equal(next.content, "after\n");
  }));

test("uses paths relative to a nested project and supports deleted file diffs", async () =>
  fixture(async (_workspace, root) => {
    const git = (...args) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "file with spaces.ts"), "committed\n");
    git("add", ".");
    git("commit", "-m", "fixture");
    await writeFile(join(root, "nested", "file with spaces.ts"), "changed\n");
    const nested = new Workspace(join(root, "nested"), () => {});
    try {
      assert.deepEqual((await nested.snapshot()).changes, [
        { path: "file with spaces.ts", status: "M" },
      ]);
      assert.equal(
        (await nested.read("file with spaces.ts")).baseline,
        "committed\n",
      );
      await rm(join(root, "nested", "file with spaces.ts"));
      const deleted = await nested.read("file with spaces.ts");
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.baseline, "committed\n");
      assert.equal(deleted.content, "");
      await assert.rejects(
        nested.save(deleted.path, "draft", deleted.revision),
        /已删除/,
      );
    } finally {
      nested.dispose();
    }
  }));

test("serializes saves so only one editor can use a disk revision", async () =>
  fixture(async (workspace, root) => {
    await writeFile(join(root, "same.ts"), "initial\n");
    const initial = await workspace.read("same.ts");
    const results = await Promise.allSettled([
      workspace.save("same.ts", "first\n", initial.revision),
      workspace.save("same.ts", "second\n", initial.revision),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(await readFile(join(root, "same.ts"), "utf8"), "first\n");
  }));
