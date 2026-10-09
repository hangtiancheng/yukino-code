import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync as createTempDir,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import {
  yukinoPath,
  projectKey,
  projectPath,
  getSessionsDir,
  sessionPath,
} from "@/storage/paths.js";
import { createAgentWorktree } from "@/worktree/index.js";

const tempDirs = new Set<string>();

function mkdtempSync(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function runGit(repo: string, args: string[]): void {
  const emptyConfig = join(repo, ".empty-gitconfig");
  writeFileSync(emptyConfig, "");
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: "ignore",
  });
}

function initRepo(): string {
  // realpath: on macOS mkdtemp returns /var/... which is a symlink to
  // /private/var/...; git resolves it, so compare against the real path.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "yukino-wt-")));
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, [
    "-c",
    "user.email=t@test",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  return repo;
}

describe("global worktree storage", () => {
  it("resolves the repository from the delegated caller's cwd rather than the host process", async () => {
    const repo = initRepo();
    const nested = join(repo, "nested");
    mkdirSync(nested);
    const worktree = await createAgentWorktree("caller-cwd", undefined, nested);
    expect(worktree.gitRoot).toBe(repo);
    expect(worktree.path).toBe(
      yukinoPath("worktrees", projectKey(repo), "caller-cwd"),
    );
  });

  it("shares global prompts and copies standard project skills", async () => {
    const repo = initRepo();
    mkdirSync(join(repo, ".agents", "skills", "demo"), { recursive: true });
    mkdirSync(yukinoPath("prompts"), { recursive: true });
    mkdirSync(projectPath(repo, "memory"), { recursive: true });
    writeFileSync(yukinoPath("prompts", "deploy.md"), "deploy\n");
    writeFileSync(projectPath(repo, "memory", "notes.md"), "note\n");
    mkdirSync(projectPath(repo), { recursive: true });
    writeFileSync(projectPath(repo, "permissions.yaml"), "rules: []\n");
    writeFileSync(
      join(repo, ".agents", "skills", "demo", "SKILL.md"),
      "demo\n",
    );

    const wt = await createAgentWorktree("copy-test", repo);

    expect(wt.path).toBe(
      yukinoPath("worktrees", projectKey(repo), "copy-test"),
    );
    expect(existsSync(projectPath(wt.path, "memory", "notes.md"))).toBe(false);
    expect(existsSync(join(wt.path, ".yukino"))).toBe(false);
    expect(existsSync(yukinoPath("prompts", "deploy.md"))).toBe(true);
    expect(
      existsSync(join(wt.path, ".agents", "skills", "demo", "SKILL.md")),
    ).toBe(true);
  });

  it("excludes runtime state and the nested worktrees directory", async () => {
    const repo = initRepo();
    mkdirSync(join(getSessionsDir(repo)), { recursive: true });
    mkdirSync(sessionPath("sess-1", "file-history"), {
      recursive: true,
    });
    writeFileSync(join(getSessionsDir(repo), "s.jsonl"), "{}\n");
    writeFileSync(sessionPath("sess-1", "file-history", "img.png"), "x");
    mkdirSync(projectPath(repo), { recursive: true });
    writeFileSync(projectPath(repo, "permissions.yaml"), "rules: []\n");

    const wt = await createAgentWorktree("exclude-test", repo);

    expect(existsSync(join(wt.path, ".yukino"))).toBe(false);
    expect(existsSync(join(getSessionsDir(wt.path)))).toBe(false);
    expect(existsSync(yukinoPath("file-history"))).toBe(false);
    expect(existsSync(yukinoPath("worktrees", projectKey(wt.path)))).toBe(
      false,
    );
  });
});
