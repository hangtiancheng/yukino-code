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

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { ExitWorktreeTool } from "@/tools/exit-worktree.js";
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from "@/worktree/index.js";

const temporaryDirectories: string[] = [];

// Hide the machine's global git config so hook-path assertions observe only
// repository and worktree configuration created by each test.
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
});
afterAll(() => {
  if (originalGitConfigGlobal === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  }
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function optionalGit(repo: string, ...args: string[]): string {
  try {
    return git(repo, ...args);
  } catch {
    return "";
  }
}

function initRepo(name = "repo"): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "yukino-worktree-safety-")),
  );
  temporaryDirectories.push(parent);
  const repo = join(parent, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Worktree Test");
  git(repo, "config", "user.email", "worktree@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "initial\n");
  writeFileSync(join(repo, ".gitignore"), ".yukino/\n");
  git(repo, "add", "tracked.txt", ".gitignore");
  git(repo, "commit", "-q", "-m", "initial");
  return repo;
}

function exit(
  repo: string,
  worktree: { path: string; branch: string },
  head?: string,
) {
  return new ExitWorktreeTool().execute(
    { workDir: repo },
    {
      path: worktree.path,
      branch: worktree.branch,
      git_root: repo,
      ...(head ? { head_commit: head } : {}),
    },
  );
}

describe("worktree creation safety", () => {
  it.each([
    "repo with spaces 'quotes' $(touch injected-dollar)",
    "repo `touch injected-backtick`",
  ])("treats special characters in %s as literal paths", async (name) => {
    const repo = initRepo(name);
    const worktree = await createAgentWorktree("literal", repo);
    expect(worktree.path).toBe(join(repo, ".yukino", "worktrees", "literal"));
    expect(readFileSync(join(worktree.path, "tracked.txt"), "utf-8")).toBe(
      "initial\n",
    );
    expect(
      optionalGit(worktree.path, "config", "--get", "core.hooksPath"),
    ).toBe("");
    expect(optionalGit(repo, "config", "--get", "core.hooksPath")).toBe("");
    expect(await hasWorktreeChanges(worktree.path, worktree.headCommit)).toBe(
      false,
    );
    expect(await createAgentWorktree("literal", repo)).toEqual(worktree);

    const result = await exit(repo, worktree, worktree.headCommit);
    expect(result.isError).toBe(false);
    expect(existsSync(worktree.path)).toBe(false);
    expect(existsSync(join(repo, "injected-dollar"))).toBe(false);
    expect(existsSync(join(repo, "injected-backtick"))).toBe(false);
  });

  it("leaves a user-configured core.hooksPath untouched", async () => {
    const repo = initRepo();
    const custom = join(repo, "custom-hooks");
    git(repo, "config", "core.hooksPath", custom);
    await createAgentWorktree("hooks-preserved", repo);
    expect(git(repo, "config", "core.hooksPath")).toBe(custom);
  });

  it("configures Husky only in the new worktree", async () => {
    const repo = initRepo();
    const huskyPath = join(repo, ".husky");
    mkdirSync(huskyPath);

    const worktree = await createAgentWorktree("husky", repo);

    expect(
      git(worktree.path, "config", "--worktree", "--get", "core.hooksPath"),
    ).toBe(huskyPath);
    expect(optionalGit(repo, "config", "--get", "core.hooksPath")).toBe("");
    expect(
      optionalGit(
        repo,
        "config",
        "--file",
        join(repo, ".git", "config"),
        "--get",
        "core.hooksPath",
      ),
    ).toBe("");
    expect(git(repo, "config", "--get", "extensions.worktreeConfig")).toBe(
      "true",
    );
  });

  it("rejects an existing ordinary directory and preserves its contents", async () => {
    const repo = initRepo();
    const directory = join(repo, ".yukino", "worktrees", "ordinary");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "keep.txt"), "existing data\n");
    const head = git(repo, "rev-parse", "HEAD");

    await expect(createAgentWorktree("ordinary", repo)).rejects.toThrow(
      "Existing directory is not a worktree root",
    );
    expect(readFileSync(join(directory, "keep.txt"), "utf-8")).toBe(
      "existing data\n",
    );
    expect(existsSync(join(directory, ".git"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "branch", "--list", "worktree-ordinary")).toBe("");
  });

  it("reuses a residual branch without resetting its unmerged commit", async () => {
    const repo = initRepo();
    git(repo, "switch", "-c", "worktree-residual");
    writeFileSync(join(repo, "unique.txt"), "preserve this work\n");
    git(repo, "add", "unique.txt");
    git(repo, "commit", "-q", "-m", "unique work");
    const tip = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "main");
    git(repo, "pack-refs", "--all");

    const worktree = await createAgentWorktree("residual", repo);
    expect(worktree.headCommit).toBe(tip);
    expect(git(repo, "rev-parse", "worktree-residual")).toBe(tip);
    expect(readFileSync(join(worktree.path, "unique.txt"), "utf-8")).toBe(
      "preserve this work\n",
    );
  });

  it.each([
    "",
    "../escape",
    "../../escape",
    "a/b",
    "a\\b",
    "$(touch injected)",
  ])("rejects invalid slug %s before creating a worktree", async (slug) => {
    const repo = initRepo();
    await expect(createAgentWorktree(slug, repo)).rejects.toThrow(/slug/i);
    expect(existsSync(join(repo, ".yukino"))).toBe(false);
  });
});

describe("worktree cleanup safety", () => {
  it("keeps the worktree when the original head is omitted", async () => {
    const repo = initRepo();
    const worktree = await createAgentWorktree("unknown-head", repo);
    const result = await exit(repo, worktree);
    expect(result.output).toContain("kept");
    expect(existsSync(worktree.path)).toBe(true);
    expect(git(repo, "rev-parse", worktree.branch)).toBe(worktree.headCommit);
  });

  it.each(["tracked.txt", "untracked.txt"])(
    "keeps dirty worktree containing %s",
    async (file) => {
      const repo = initRepo();
      const worktree = await createAgentWorktree("dirty", repo);
      writeFileSync(join(worktree.path, file), "unsaved work\n");

      const result = await exit(repo, worktree, worktree.headCommit);
      expect(result.output).toContain("kept");
      expect(readFileSync(join(worktree.path, file), "utf-8")).toBe(
        "unsaved work\n",
      );
      expect(git(repo, "rev-parse", worktree.branch)).toBe(worktree.headCommit);
    },
  );

  it("lets git refuse removal when a file appears after the clean check", async () => {
    const repo = initRepo();
    const worktree = await createAgentWorktree("raced-write", repo);
    expect(await hasWorktreeChanges(worktree.path, worktree.headCommit)).toBe(
      false,
    );
    writeFileSync(join(worktree.path, "concurrent.txt"), "concurrent work\n");

    await expect(
      removeAgentWorktree(worktree.path, worktree.branch, repo),
    ).rejects.toThrow();
    expect(readFileSync(join(worktree.path, "concurrent.txt"), "utf-8")).toBe(
      "concurrent work\n",
    );
    expect(git(repo, "rev-parse", worktree.branch)).toBe(worktree.headCommit);
  });

  it("cleans up a clean worktree and merged branch when the original head is provided", async () => {
    const repo = initRepo();
    const worktree = await createAgentWorktree("clean", repo);
    const result = await exit(repo, worktree, worktree.headCommit);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("cleaned up");
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", worktree.branch)).toBe("");
  });

  it("reports a branch deletion failure and preserves its unmerged tip", async () => {
    const repo = initRepo();
    const worktree = await createAgentWorktree("unmerged", repo);
    git(worktree.path, "commit", "-q", "--allow-empty", "-m", "unmerged work");
    const tip = git(worktree.path, "rev-parse", "HEAD");

    const result = await exit(repo, worktree, tip);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Error cleaning up worktree");
    expect(result.output).not.toContain("cleaned up (no changes)");
    expect(git(repo, "rev-parse", worktree.branch)).toBe(tip);
  });
});
