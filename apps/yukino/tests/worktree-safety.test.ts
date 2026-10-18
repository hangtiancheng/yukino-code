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

import { PermissionChecker } from "@/permissions/index.js";
import type { SandboxConfig } from "@/sandbox/index.js";
import { yukinoPath, projectKey } from "@/storage/index.js";
import { BashTool } from "@/tools/bash.js";
import { EnterWorktreeTool } from "@/tools/enter-worktree.js";
import { ExitWorktreeTool } from "@/tools/exit-worktree.js";
import type { WorktreeResult } from "@/worktree/index.js";
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

async function exit(repo: string, worktree: WorktreeResult, head?: string) {
  const checker = new PermissionChecker(repo);
  if (head) {
    await checker.registerWorktree(worktree);
  }
  return new ExitWorktreeTool().execute(
    { cwd: repo, permissionChecker: checker },
    {
      path: worktree.path,
      head_commit: head,
      branch: "forged",
      git_root: "/forged",
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
    expect(worktree.path).toBe(
      yukinoPath("worktrees", projectKey(repo), "literal"),
    );
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
    expect(await createAgentWorktree("literal", repo)).toEqual({
      ...worktree,
      created: false,
    });

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
    const directory = yukinoPath("worktrees", projectKey(repo), "ordinary");
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
  it("keeps a worktree without runtime ownership", async () => {
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

  it("cleans up an owned clean worktree using its recorded baseline", async () => {
    const repo = initRepo();
    const worktree = await createAgentWorktree("clean", repo);
    const result = await exit(repo, worktree, worktree.headCommit);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("cleaned up");
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", worktree.branch)).toBe("");
  });

  it("keeps committed changes despite a caller-supplied replacement baseline", async () => {
    const repo = initRepo();
    const worktree = await createAgentWorktree("unmerged", repo);
    git(worktree.path, "commit", "-q", "--allow-empty", "-m", "unmerged work");
    const tip = git(worktree.path, "rev-parse", "HEAD");

    const result = await exit(repo, worktree, tip);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("kept");
    expect(existsSync(worktree.path)).toBe(true);
    expect(git(repo, "rev-parse", worktree.branch)).toBe(tip);
  });
});

describe("runtime worktree ownership and sandbox roots", () => {
  it("rejects user worktrees, trees from another runtime, and branch identity changes", async () => {
    const repo = initRepo();
    const userTree = join(repo, "user-tree");
    git(repo, "worktree", "add", "-b", "user-branch", userTree);
    const checker = new PermissionChecker(repo, "acceptEdits");
    const tool = new ExitWorktreeTool();
    expect(
      (
        await tool.execute(
          { cwd: repo, permissionChecker: checker },
          {
            path: userTree,
            branch: "user-branch",
            git_root: repo,
            head_commit: git(repo, "rev-parse", "HEAD"),
          },
        )
      ).isError,
    ).toBe(true);
    expect(existsSync(userTree)).toBe(true);
    const worktree = await createAgentWorktree("owned", repo);
    await checker.registerWorktree(worktree);
    const other = new PermissionChecker(repo);
    expect(
      (
        await tool.execute(
          { cwd: repo, permissionChecker: other },
          { path: worktree.path },
        )
      ).isError,
    ).toBe(true);
    git(worktree.path, "switch", "-c", "replacement");
    expect(
      (
        await tool.execute(
          { cwd: repo, permissionChecker: checker },
          { path: worktree.path },
        )
      ).output,
    ).toContain("branch changed");
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("does not adopt an existing worktree or replace its original baseline", async () => {
    const repo = initRepo();
    const original = await createAgentWorktree("prior", repo);
    const reused = await createAgentWorktree("prior", repo);
    expect(reused.created).toBe(false);
    const checker = new PermissionChecker(repo);
    await checker.registerWorktree(reused);
    expect(
      (
        await new ExitWorktreeTool().execute(
          { cwd: repo, permissionChecker: checker },
          { path: original.path },
        )
      ).isError,
    ).toBe(true);
    expect(existsSync(original.path)).toBe(true);
    await checker.registerWorktree(original);
    git(
      original.path,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "keep committed work",
    );
    await checker.registerWorktree(await createAgentWorktree("prior", repo));
    const result = await new ExitWorktreeTool().execute(
      { cwd: repo, permissionChecker: checker },
      {
        path: original.path,
        head_commit: git(original.path, "rev-parse", "HEAD"),
      },
    );
    expect(result.output).toContain("has changes, kept");
    expect(existsSync(original.path)).toBe(true);
  });

  it("grants main EnterWorktree paths and isolates child Bash writes without changing a shared tool", async () => {
    const repo = initRepo();
    const parent = new PermissionChecker(repo, "acceptEdits");
    const entered = await new EnterWorktreeTool().execute(
      { cwd: repo, permissionChecker: parent },
      { slug: "entered" },
    );
    expect(entered.isError).toBe(false);
    const enteredPath = yukinoPath("worktrees", projectKey(repo), "entered");
    expect(parent.sandboxWriteRoots([repo])).toContain(enteredPath);
    const first = await createAgentWorktree("first", repo);
    const second = await createAgentWorktree("second", repo);
    const [a, b] = await Promise.all([
      parent.forWorktree(first),
      parent.forWorktree(second),
    ]);
    expect(
      a.check("WriteFile", "write", { file_path: join(first.path, "new.ts") })
        .effect,
    ).toBe("allow");
    expect(
      a.check("WriteFile", "write", { file_path: join(second.path, "new.ts") })
        .effect,
    ).toBe("ask");
    expect(
      a.check("WriteFile", "write", { file_path: join(repo, "new.ts") }).effect,
    ).toBe("ask");
    const tool = new BashTool();
    const captured: SandboxConfig[] = [];
    tool.sandboxConfig = {
      allowWrite: [repo, tmpdir()],
      denyWrite: [join(first.path, "protected")],
      networkEnabled: false,
    };
    tool.sandbox = {
      implementation: "bwrap",
      available: () => true,
      prepare(_command, config) {
        captured.push(config);
        return {
          executable: process.execPath,
          args: ["-e", "process.stdout.write('prepared')"],
        };
      },
    };
    const results = await Promise.all([
      tool.execute(
        { cwd: first.path, permissionChecker: a, sessionId: "first" },
        { command: "printf one" },
      ),
      tool.execute(
        { cwd: second.path, permissionChecker: b, sessionId: "second" },
        { command: "printf two" },
      ),
    ]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(captured[0].allowWrite).toContain(first.path);
    expect(captured[0].allowWrite).not.toContain(second.path);
    expect(captured[1].allowWrite).toContain(second.path);
    for (const config of captured) {
      expect(config.allowWrite).not.toContain(repo);
      expect(config.allowWrite).not.toContain(tmpdir());
      expect(config.denyWrite).toEqual(tool.sandboxConfig.denyWrite);
    }
    expect(tool.sandboxConfig.allowWrite).toEqual([repo, tmpdir()]);
  });
});
