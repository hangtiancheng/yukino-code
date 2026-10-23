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

import { Agent } from "@yukino.js/agent";
import { ConversationManager } from "@yukino.js/conversation";
import type { LLMClient } from "@yukino.js/llm/client.js";
import type { StreamEvent } from "@yukino.js/llm/events.js";
import { PermissionChecker } from "@yukino.js/permissions";
import type { SandboxConfig } from "@yukino.js/sandbox";
import { SeatbeltSandbox } from "@yukino.js/sandbox/seatbelt.js";
import { yukinoPath, projectKey } from "@yukino.js/storage";
import { BashTool } from "@yukino.js/tools/bash.js";
import { EnterWorktreeTool } from "@yukino.js/tools/enter-worktree.js";
import { ExitWorktreeTool } from "@yukino.js/tools/exit-worktree.js";
import { FileStateCache } from "@yukino.js/tools/file-state-cache.js";
import { ReadFileTool } from "@yukino.js/tools/read-file.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import { WriteFileTool } from "@yukino.js/tools/write-file.js";
import type { WorktreeResult } from "@yukino.js/worktree";
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
  resolveGitDir,
  type WorktreeSession,
} from "@yukino.js/worktree";

const temporaryDirectories: string[] = [];

function activeSession(checker: PermissionChecker): Readonly<WorktreeSession> {
  const session = checker.worktreeSession;
  if (!session) {
    throw new Error("Expected an active worktree session");
  }
  return session;
}

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

async function exit(repo: string, worktree: WorktreeResult, owned = true) {
  const checker = new PermissionChecker(repo);
  if (owned) {
    await checker.enterWorktree(worktree);
  }
  return new ExitWorktreeTool().execute(
    { cwd: repo, permissionChecker: checker },
    { action: "remove" },
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

    const result = await exit(repo, worktree);
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
    expect(git(repo, "branch", "--list", "worktree/ordinary/work")).toBe("");
  });

  it("reuses a residual branch without resetting its unmerged commit", async () => {
    const repo = initRepo();
    git(repo, "switch", "-c", "worktree/residual/work");
    writeFileSync(join(repo, "unique.txt"), "preserve this work\n");
    git(repo, "add", "unique.txt");
    git(repo, "commit", "-q", "-m", "unique work");
    const tip = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "main");
    git(repo, "pack-refs", "--all");

    const worktree = await createAgentWorktree("residual", repo);
    expect(worktree.headCommit).toBe(tip);
    expect(git(repo, "rev-parse", "worktree/residual/work")).toBe(tip);
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
    const result = await exit(repo, worktree, false);
    expect(result.output).toContain("No-op");
    expect(existsSync(worktree.path)).toBe(true);
    expect(git(repo, "rev-parse", worktree.branch)).toBe(worktree.headCommit);
  });

  it.each(["tracked.txt", "untracked.txt"])(
    "keeps dirty worktree containing %s",
    async (file) => {
      const repo = initRepo();
      const worktree = await createAgentWorktree("dirty", repo);
      writeFileSync(join(worktree.path, file), "unsaved work\n");

      const result = await exit(repo, worktree);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("discard_changes: true");
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
    const result = await exit(repo, worktree);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Removed worktree");
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", worktree.branch)).toBe("");
  });

  it("refuses committed changes against the recorded baseline", async () => {
    const repo = initRepo();
    const worktree = await createAgentWorktree("unmerged", repo);
    git(worktree.path, "commit", "-q", "--allow-empty", "-m", "unmerged work");
    const tip = git(worktree.path, "rev-parse", "HEAD");

    const result = await exit(repo, worktree);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("1 commits");
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
          { action: "remove", discard_changes: true },
        )
      ).isError,
    ).toBe(true);
    expect(existsSync(userTree)).toBe(true);
    const worktree = await createAgentWorktree("owned", repo);
    await checker.enterWorktree(worktree);
    const other = new PermissionChecker(repo);
    expect(
      (
        await tool.execute(
          { cwd: repo, permissionChecker: other },
          { action: "remove", discard_changes: true },
        )
      ).isError,
    ).toBe(true);
    git(worktree.path, "switch", "-c", "replacement");
    expect(
      (
        await tool.execute(
          { cwd: repo, permissionChecker: checker },
          { action: "remove", discard_changes: true },
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
    await expect(checker.enterWorktree(reused)).rejects.toThrow(
      "not created by this runtime",
    );
    expect(
      (
        await new ExitWorktreeTool().execute(
          { cwd: repo, permissionChecker: checker },
          { action: "remove" },
        )
      ).isError,
    ).toBe(true);
    expect(existsSync(original.path)).toBe(true);
    await checker.enterWorktree(original);
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
      { action: "remove" },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("discard_changes: true");
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
    const enteredPath = realpathSync(
      yukinoPath("worktrees", projectKey(repo), "entered"),
    );
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
    expect(captured[0].allowWrite).toContain(realpathSync(first.path));
    expect(captured[0].allowWrite).not.toContain(realpathSync(second.path));
    expect(captured[1].allowWrite).toContain(realpathSync(second.path));
    for (const config of captured) {
      expect(config.allowWrite).not.toContain(repo);
      expect(config.allowWrite).not.toContain(join(repo, ".git"));
      expect(config.allowWrite).not.toContain(tmpdir());
      expect(config.denyWrite).toEqual(tool.sandboxConfig.denyWrite);
    }
    expect(captured[0].allowWrite).toContain(
      join(repo, ".git", "worktrees", "first"),
    );
    expect(captured[0].allowWrite).not.toContain(
      join(repo, ".git", "worktrees", "second"),
    );
    expect(captured[0].allowWrite).toContain(
      join(repo, ".git", "refs", "heads", "worktree", "first"),
    );
    expect(captured[0].allowWrite).not.toContain(
      join(repo, ".git", "refs", "heads"),
    );
    expect(tool.sandboxConfig.allowWrite).toEqual([repo, tmpdir()]);
  });

  it.skipIf(process.platform !== "darwin")(
    "can stage and commit in a native sandbox without granting parent or sibling writes",
    async () => {
      const repo = initRepo();
      const initial = git(repo, "rev-parse", "HEAD");
      const first = await createAgentWorktree("native-first", repo);
      const second = await createAgentWorktree("native-second", repo);
      const checker = await new PermissionChecker(
        repo,
        "acceptEdits",
      ).forWorktree(first);
      const tool = new BashTool();
      tool.sandbox = new SeatbeltSandbox();
      tool.sandboxConfig = {
        allowWrite: [repo, tmpdir()],
        denyWrite: [join(first.path, "protected")],
        networkEnabled: false,
      };
      mkdirSync(join(first.path, "protected"));
      const ctx = {
        cwd: first.path,
        permissionChecker: checker,
        sessionId: "native-worktree",
      };
      const result = await tool.execute(ctx, {
        command:
          "printf 'changed\\n' > tracked.txt && git -c core.fsmonitor=false add tracked.txt && git -c commit.gpgsign=false -c gc.auto=0 commit -qm update && mktemp",
      });
      expect(result.isError, result.output).toBe(false);
      expect(result.output).toContain(checker.sandboxTempDirectory());
      expect(git(first.path, "rev-parse", "HEAD")).not.toBe(initial);
      expect(git(repo, "rev-parse", "HEAD")).toBe(initial);
      expect(git(second.path, "rev-parse", "HEAD")).toBe(initial);
      const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
      for (const path of [
        join(repo, "blocked.txt"),
        join(second.path, "blocked.txt"),
        join(first.path, "protected", "blocked.txt"),
      ]) {
        const denied = await tool.execute(ctx, {
          command: `touch ${quote(path)}`,
        });
        expect(denied.isError, denied.output).toBe(true);
        expect(existsSync(path)).toBe(false);
      }
      const mainRef = await tool.execute(ctx, {
        command: "git update-ref refs/heads/main HEAD",
      });
      expect(mainRef.isError, mainRef.output).toBe(true);
      expect(git(repo, "rev-parse", "HEAD")).toBe(initial);
    },
  );
});

describe("EnterWorktree and ExitWorktree sessions", () => {
  it("generates a slug, keeps dirty work, restores the caller's subdirectory, and permits another entry", async () => {
    const repo = initRepo();
    const nested = join(repo, "nested");
    mkdirSync(nested);
    const checker = new PermissionChecker(nested, "acceptEdits");
    const fileStateCache = new FileStateCache();
    fileStateCache.record(join(repo, "tracked.txt"), 0);
    const ctx = { cwd: nested, permissionChecker: checker, fileStateCache };
    const enter = new EnterWorktreeTool();
    expect(enter.schema().input_schema.required ?? []).not.toContain("slug");
    const entered = await enter.execute(ctx, {});
    expect(entered.isError, entered.output).toBe(false);
    const session = activeSession(checker);
    expect(session.path).not.toBe(repo);
    expect(session.branch).toMatch(/^worktree\/[a-zA-Z0-9_-]+\/work$/);
    expect(checker.cwd).toBe(session.path);
    expect(fileStateCache.has(join(repo, "tracked.txt"))).toBe(false);
    writeFileSync(join(session.path, "untracked.txt"), "keep this\n");
    fileStateCache.record(join(session.path, "tracked.txt"), 0);
    expect((await enter.execute(ctx, {})).isError).toBe(true);
    const kept = await new ExitWorktreeTool().execute(ctx, { action: "keep" });
    expect(kept.isError, kept.output).toBe(false);
    expect(checker.cwd).toBe(nested);
    expect(checker.worktreeSession).toBeUndefined();
    expect(fileStateCache.has(join(session.path, "tracked.txt"))).toBe(false);
    expect(checker.sandboxWriteRoots([nested])).not.toContain(session.path);
    expect(readFileSync(join(session.path, "untracked.txt"), "utf8")).toBe(
      "keep this\n",
    );
    expect(git(repo, "rev-parse", session.branch)).toBe(session.headCommit);
    expect((await enter.execute(ctx, { slug: "next-session" })).isError).toBe(
      false,
    );
    expect(checker.worktreeSession?.path).not.toBe(session.path);
  });

  it("refuses removal until explicitly allowed to discard both files and commits", async () => {
    const repo = initRepo();
    const checker = new PermissionChecker(repo);
    const ctx = { cwd: repo, permissionChecker: checker };
    await new EnterWorktreeTool().execute(ctx, { slug: "discard" });
    const session = activeSession(checker);
    git(session.path, "commit", "-q", "--allow-empty", "-m", "new work");
    writeFileSync(join(session.path, "tracked.txt"), "unsaved work\n");
    writeFileSync(join(session.path, "untracked.txt"), "new file\n");
    const tool = new ExitWorktreeTool();
    const refused = await tool.execute(ctx, { action: "remove" });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("2 uncommitted files and 1 commits");
    expect(checker.worktreeSession).toBe(session);
    expect(checker.cwd).toBe(session.path);
    const removed = await tool.execute(ctx, {
      action: "remove",
      discard_changes: true,
    });
    expect(removed.isError, removed.output).toBe(false);
    expect(removed.output).toContain(
      "Discarded 2 uncommitted files and 1 commits",
    );
    expect(existsSync(session.path)).toBe(false);
    expect(git(repo, "branch", "--list", session.branch)).toBe("");
    expect(checker.cwd).toBe(repo);
    expect(checker.worktreeSession).toBeUndefined();
  });

  it("fails closed on unreadable Git state and permits an explicit discard", async () => {
    const repo = initRepo();
    const checker = new PermissionChecker(repo);
    const ctx = { cwd: repo, permissionChecker: checker };
    await new EnterWorktreeTool().execute(ctx, { slug: "corrupt-index" });
    const session = activeSession(checker);
    writeFileSync(join(await resolveGitDir(session.path), "index"), "corrupt");
    const tool = new ExitWorktreeTool();
    const refused = await tool.execute(ctx, { action: "remove" });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("Could not verify worktree state");
    expect(checker.worktreeSession).toBe(session);
    expect(existsSync(session.path)).toBe(true);
    const removed = await tool.execute(ctx, {
      action: "remove",
      discard_changes: true,
    });
    expect(removed.isError, removed.output).toBe(false);
    expect(existsSync(session.path)).toBe(false);
  });

  it("keeps the session active and reports a locked worktree removal failure", async () => {
    const repo = initRepo();
    const checker = new PermissionChecker(repo);
    const ctx = { cwd: repo, permissionChecker: checker };
    await new EnterWorktreeTool().execute(ctx, { slug: "locked" });
    const session = activeSession(checker);
    git(repo, "worktree", "lock", session.path);
    const result = await new ExitWorktreeTool().execute(ctx, {
      action: "remove",
      discard_changes: true,
    });
    expect(result.isError).toBe(true);
    expect(checker.worktreeSession).toBe(session);
    expect(existsSync(session.path)).toBe(true);
    expect(git(repo, "rev-parse", session.branch)).toBe(session.headCommit);
  });

  it("preserves the original baseline when re-entering a kept worktree in the same runtime", async () => {
    const repo = initRepo();
    const checker = new PermissionChecker(repo);
    const ctx = { cwd: repo, permissionChecker: checker };
    const enter = new EnterWorktreeTool();
    const exit = new ExitWorktreeTool();
    await enter.execute(ctx, { slug: "reenter" });
    const session = activeSession(checker);
    git(
      session.path,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "preserved commit",
    );
    await exit.execute(ctx, { action: "keep" });
    const reentered = await enter.execute(ctx, { slug: "reenter" });
    expect(reentered.isError, reentered.output).toBe(false);
    expect(checker.worktreeSession?.headCommit).toBe(session.headCommit);
    const refused = await exit.execute(ctx, { action: "remove" });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("1 commits");
    expect(existsSync(session.path)).toBe(true);
  });

  it("restores the original cwd and reports a partial failure when branch deletion fails", async () => {
    const repo = initRepo();
    const checker = new PermissionChecker(repo);
    const ctx = { cwd: repo, permissionChecker: checker };
    await new EnterWorktreeTool().execute(ctx, { slug: "branch-locked" });
    const session = activeSession(checker);
    writeFileSync(
      join(repo, ".git", "refs", "heads", `${session.branch}.lock`),
      "lock",
    );
    const result = await new ExitWorktreeTool().execute(ctx, {
      action: "remove",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Session restored");
    expect(checker.cwd).toBe(repo);
    expect(checker.worktreeSession).toBeUndefined();
    expect(existsSync(session.path)).toBe(false);
    expect(git(repo, "rev-parse", session.branch)).toBe(session.headCommit);
  });

  it("isolates active sessions from children and other runtimes", async () => {
    const repo = initRepo();
    const parent = new PermissionChecker(repo);
    const ctx = { cwd: repo, permissionChecker: parent };
    await new EnterWorktreeTool().execute(ctx, { slug: "parent" });
    const session = activeSession(parent);
    for (const checker of [
      parent.forSubagent(session.path),
      new PermissionChecker(repo),
    ]) {
      const result = await new ExitWorktreeTool().execute(
        { cwd: checker.cwd, permissionChecker: checker },
        { action: "remove", discard_changes: true },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("No-op");
    }
    const other = new PermissionChecker(repo);
    const refused = await new EnterWorktreeTool().execute(
      { cwd: repo, permissionChecker: other },
      { slug: "parent" },
    );
    expect(refused.isError).toBe(true);
    expect(other.worktreeSession).toBeUndefined();
    expect(parent.worktreeSession).toBe(session);
    expect(existsSync(session.path)).toBe(true);
    const child = parent.forSubagent(repo);
    const childEntry = await new EnterWorktreeTool().execute(
      { cwd: repo, permissionChecker: child },
      { slug: "parent" },
    );
    expect(childEntry.isError).toBe(true);
    expect(child.worktreeSession).toBeUndefined();
  });

  it.each([{ slug: "" }, { slug: null }, { slug: 1 }, { slug: "../escape" }])(
    "rejects invalid EnterWorktree arguments %j",
    async (args) => {
      const repo = initRepo();
      const checker = new PermissionChecker(repo);
      const result = await new EnterWorktreeTool().execute(
        { cwd: repo, permissionChecker: checker },
        args,
      );
      expect(result.isError).toBe(true);
      expect(checker.worktreeSession).toBeUndefined();
      expect(
        git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm),
      ).toHaveLength(1);
    },
  );

  it.each([
    {},
    { action: "invalid" },
    { action: "remove", discard_changes: "true" },
    { action: "remove", path: "/forged" },
  ])("rejects invalid ExitWorktree arguments %j", async (args) => {
    const repo = initRepo();
    const checker = new PermissionChecker(repo);
    const ctx = { cwd: repo, permissionChecker: checker };
    await new EnterWorktreeTool().execute(ctx, { slug: "validate" });
    const session = activeSession(checker);
    const result = await new ExitWorktreeTool().execute(ctx, args);
    expect(result.isError).toBe(true);
    expect(checker.worktreeSession).toBe(session);
    expect(existsSync(session.path)).toBe(true);
  });

  it("switches shell execution in the same batch and across agent turns without changing the process cwd", async () => {
    const repo = initRepo();
    const processCwd = process.cwd();
    const checker = new PermissionChecker(repo, "acceptEdits");
    const registry = new ToolRegistry();
    registry.register(new EnterWorktreeTool());
    registry.register(new ExitWorktreeTool());
    registry.register(new BashTool());
    registry.register(new WriteFileTool());
    registry.register(new ReadFileTool());
    const conversation = new ConversationManager();
    const end = (stopReason: string): StreamEvent => ({
      type: "stream_end",
      stopReason,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    const call = (
      toolId: string,
      toolName: string,
      args: Record<string, unknown>,
    ): StreamEvent => ({
      type: "tool_call_complete",
      toolId,
      toolName,
      arguments: args,
    });
    const scripts: StreamEvent[][] = [
      [
        call("enter", "EnterWorktree", { slug: "agent-loop" }),
        call("write-enter", "WriteFile", {
          file_path: "only-worktree.txt",
          content: "isolated work\n",
        }),
        call("read-enter", "ReadFile", { file_path: "only-worktree.txt" }),
        call("pwd-enter", "Bash", { command: "pwd" }),
        end("tool_use"),
      ],
      [end("end_turn")],
      [
        call("pwd-turn", "Bash", { command: "pwd" }),
        call("exit", "ExitWorktree", { action: "keep" }),
        call("write-exit", "WriteFile", {
          file_path: "only-original.txt",
          content: "original project\n",
        }),
        call("pwd-exit", "Bash", { command: "pwd" }),
        end("tool_use"),
      ],
      [end("end_turn")],
    ];
    const client: LLMClient = {
      setSystemPrompt() {},
      async *stream() {
        await Promise.resolve();
        yield* scripts.shift() ?? [end("end_turn")];
      },
    };
    conversation.addUserMessage("enter worktree");
    const onPermissionRequest = async (name: string): Promise<"allow"> => {
      expect(name).toBe("Bash");
      await Promise.resolve();
      return "allow";
    };
    const first = new Agent({
      client,
      registry,
      checker,
      conversation,
      cwd: repo,
      onPermissionRequest,
    });
    const results = new Map<string, string>();
    for await (const event of first.run()) {
      if (event.type === "tool_result") {
        expect(event.isError, event.output).toBe(false);
        results.set(event.toolId, event.output);
      }
    }
    const path = activeSession(checker).path;
    expect(results.get("pwd-enter")).toContain(path);
    expect(results.get("read-enter")).toContain("isolated work");
    expect(existsSync(join(repo, "only-worktree.txt"))).toBe(false);
    expect(
      checker.check("WriteFile", "write", { file_path: "relative.txt" }).effect,
    ).toBe("allow");
    conversation.addUserMessage("exit worktree and keep it");
    const second = new Agent({
      client,
      registry,
      checker,
      conversation,
      cwd: repo,
      onPermissionRequest,
    });
    for await (const event of second.run()) {
      if (event.type === "tool_result") {
        expect(event.isError, event.output).toBe(false);
        results.set(event.toolId, event.output);
      }
    }
    expect(results.get("pwd-turn")).toContain(path);
    expect(results.get("pwd-exit")).toContain(repo);
    expect(existsSync(join(path, "only-original.txt"))).toBe(false);
    expect(readFileSync(join(repo, "only-original.txt"), "utf8")).toBe(
      "original project\n",
    );
    expect(
      conversation
        .getMessages()
        .some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(
              `<working-directory>\nThe agent's current working directory is ${repo}.`,
            ),
        ),
    ).toBe(true);
    expect(checker.cwd).toBe(repo);
    expect(process.cwd()).toBe(processCwd);
  });
});
