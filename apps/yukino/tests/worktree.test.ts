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

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { createAgentWorktree } from "@/worktree/index.js";

function initRepo(): string {
  // realpath: on macOS mkdtemp returns /var/... which is a symlink to
  // /private/var/...; git resolves it, so compare against the real path.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "yukino-wt-")));
  execSync("git init -q -b main", { cwd: repo });
  execSync(
    "git -c user.email=t@test -c user.name=t commit -q --allow-empty -m init",
    {
      cwd: repo,
    },
  );
  return repo;
}

describe("createAgentWorktree .yukino settings propagation", () => {
  it("copies shared settings into the worktree", async () => {
    const repo = initRepo();
    mkdirSync(join(repo, ".agents", "skills", "demo"), { recursive: true });
    mkdirSync(join(repo, ".yukino", "memory"), { recursive: true });
    writeFileSync(join(repo, ".yukino", "memory", "notes.md"), "note\n");
    writeFileSync(join(repo, ".yukino", "permissions.yaml"), "rules: []\n");
    writeFileSync(
      join(repo, ".agents", "skills", "demo", "SKILL.md"),
      "demo\n",
    );

    const wt = await createAgentWorktree("copy-test", repo);

    expect(wt.path).toBe(join(repo, ".yukino", "worktrees", "copy-test"));
    expect(existsSync(join(wt.path, ".yukino", "memory", "notes.md"))).toBe(
      true,
    );
    expect(existsSync(join(wt.path, ".yukino", "permissions.yaml"))).toBe(true);
    expect(
      existsSync(join(wt.path, ".agents", "skills", "demo", "SKILL.md")),
    ).toBe(true);
  });

  it("excludes runtime state and the nested worktrees directory", async () => {
    const repo = initRepo();
    mkdirSync(join(repo, ".yukino", "sessions"), { recursive: true });
    mkdirSync(join(repo, ".yukino", "file-history", "sess-1"), {
      recursive: true,
    });
    writeFileSync(join(repo, ".yukino", "sessions", "s.jsonl"), "{}\n");
    writeFileSync(
      join(repo, ".yukino", "file-history", "sess-1", "img.png"),
      "x",
    );
    writeFileSync(join(repo, ".yukino", "permissions.yaml"), "rules: []\n");

    const wt = await createAgentWorktree("exclude-test", repo);

    expect(existsSync(join(wt.path, ".yukino", "permissions.yaml"))).toBe(true);
    expect(existsSync(join(wt.path, ".yukino", "sessions"))).toBe(false);
    expect(existsSync(join(wt.path, ".yukino", "file-history"))).toBe(false);
    expect(existsSync(join(wt.path, ".yukino", "worktrees"))).toBe(false);
  });
});
