import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
} from "fs/promises";
import { dirname, join, resolve } from "path";

import { execa } from "execa";

import { createChildLogger } from "@/logger/index.js";
import { SKILLS_AGENTS_DIR_NAME } from "@/skills/constants.js";
import { yukinoPath, projectKey } from "@/storage/index.js";
import { canonicalPath } from "@/utils/paths.js";
import {
  REFS_HEADS_PREFIX,
  GIT_QUERY_TIMEOUT_MS,
  GIT_DIR_NAME,
  SHARED_AGENTS_ENTRIES,
  WORKTREE_SLUG_PATTERN,
  WORKTREES_DIR_NAME,
} from "@/worktree/constants.js";
import {
  buildWorktreeChangesGuidance,
  WORKTREE_STATE_UNVERIFIED_GUIDANCE,
} from "@/worktree/prompts.js";

export * from "@/worktree/constants.js";
export * from "@/worktree/prompts.js";

const log = createChildLogger({ module: "worktree" });

export interface WorktreeResult {
  created: boolean;
  path: string;
  branch: string;
  headCommit: string;
  gitRoot: string;
}

export interface WorktreeSession extends WorktreeResult {
  originalCwd: string;
}

export interface WorktreeChanges {
  changedFiles: number;
  commits: number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execa("git", args, {
      cwd,
      timeout: GIT_QUERY_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (err) {
    log.debug({ err, cwd, args }, "Git query failed");
    return "";
  }
}

export async function resolveGitDir(root: string): Promise<string> {
  return gitOutput(root, ["rev-parse", "--absolute-git-dir"]);
}

export async function readWorktreeHeadSha(
  worktreePath: string,
): Promise<string> {
  return gitOutput(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const ref = await gitOutput(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  return ref.startsWith(REFS_HEADS_PREFIX)
    ? ref.slice(REFS_HEADS_PREFIX.length)
    : "";
}

export async function createAgentWorktree(
  slug: string,
  gitRoot?: string,
  cwd = process.cwd(),
): Promise<WorktreeResult> {
  if (!WORKTREE_SLUG_PATTERN.test(slug)) {
    throw new Error(
      "Invalid worktree slug: use only alphanumeric, hyphen, underscore",
    );
  }
  const root =
    gitRoot ??
    (
      await execa("git", ["rev-parse", "--show-toplevel"], {
        cwd: cwd,
      })
    ).stdout.trim();

  const worktreeDir = yukinoPath(WORKTREES_DIR_NAME, projectKey(root), slug);
  const branch = `worktree/${slug}/work`;

  // Validate that an existing directory is really a worktree root before reusing
  // it: git otherwise searches parent directories and would report the main
  // repository's HEAD as this worktree's commit.
  if (await pathExists(worktreeDir)) {
    let topLevel: string;
    try {
      topLevel = (
        await execa("git", ["rev-parse", "--show-toplevel"], {
          cwd: worktreeDir,
        })
      ).stdout;
    } catch (cause) {
      throw new Error(
        `Existing directory is not a worktree root: ${worktreeDir}`,
        { cause },
      );
    }
    if ((await realpath(topLevel.trim())) !== (await realpath(worktreeDir))) {
      throw new Error(
        `Existing directory is not a worktree root: ${worktreeDir}`,
      );
    }
    const head = await readWorktreeHeadSha(worktreeDir);
    if (head) {
      return {
        path: worktreeDir,
        branch,
        headCommit: head,
        gitRoot: root,
        created: false,
      };
    }
    // Fallback to git subprocess if filesystem read fails
    const { stdout: headFallback } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: worktreeDir,
    });
    return {
      path: worktreeDir,
      branch,
      headCommit: headFallback.trim(),
      gitRoot: root,
      created: false,
    };
  }

  // Reattach residual branches at their existing tip. Creating with -b also
  // refuses a branch created concurrently instead of resetting its commits.
  const { stdout: existingBranch } = await execa(
    "git",
    ["branch", "--list", "--format=%(refname)", "--", branch],
    { cwd: root },
  );
  const addArgs = existingBranch.trim()
    ? ["worktree", "add", "--", worktreeDir, branch]
    : ["worktree", "add", "-b", branch, "--", worktreeDir];
  await execa("git", addArgs, {
    cwd: root,
  });

  await performPostCreationSetup(root, worktreeDir);

  // Prefer filesystem read for HEAD in newly created worktrees
  const head = await readWorktreeHeadSha(worktreeDir);
  if (head) {
    return {
      path: worktreeDir,
      branch,
      headCommit: head,
      gitRoot: root,
      created: true,
    };
  }
  // Fallback to subprocess
  const { stdout: headFallback } = await execa("git", ["rev-parse", "HEAD"], {
    cwd: worktreeDir,
  });

  return {
    path: worktreeDir,
    branch,
    headCommit: headFallback.trim(),
    gitRoot: root,
    created: true,
  };
}

interface OwnedWorktree extends WorktreeResult {
  gitDir: string;
  commonDir: string;
  writeRoots: readonly string[];
  tempDir: string;
}

export class OwnedWorktrees {
  private records = new Map<string, Readonly<OwnedWorktree>>();

  get(path: string): Readonly<WorktreeResult> | undefined {
    return this.records.get(canonicalPath(path));
  }

  async register(worktree: WorktreeResult): Promise<boolean> {
    const path = canonicalPath(worktree.path);
    if (this.records.has(path)) {
      return true;
    }
    if (!worktree.created) {
      return false;
    }
    const gitDir = canonicalPath(await resolveGitDir(path));
    const { stdout } = await execa("git", ["rev-parse", "--git-common-dir"], {
      cwd: path,
    });
    const commonDir = canonicalPath(resolve(path, stdout.trim()));
    const branchDirectory = dirname(worktree.branch);
    if (
      !(await gitOutput(path, [
        "check-ref-format",
        "--branch",
        worktree.branch,
      ])) ||
      branchDirectory === "."
    ) {
      throw new Error("Worktree branch requires an isolated ref directory");
    }
    const refDir = join(commonDir, "refs", "heads", branchDirectory);
    const logDir = join(commonDir, "logs", "refs", "heads", branchDirectory);
    const tempDir = join(gitDir, "yukino-tmp");
    await mkdir(refDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    this.records.set(
      path,
      Object.freeze({
        ...worktree,
        path,
        gitRoot: canonicalPath(worktree.gitRoot),
        gitDir,
        commonDir,
        // Git needs its per-tree index, shared object store and this tree's
        // ref locks. Never grant the common Git directory or sibling refs.
        writeRoots: Object.freeze([
          gitDir,
          canonicalPath(join(commonDir, "objects")),
          canonicalPath(refDir),
          canonicalPath(logDir),
        ]),
        tempDir,
      }),
    );
    return true;
  }

  sandboxWriteRoots(): string[] {
    return [...this.records.values()].flatMap((record) => [
      ...record.writeRoots,
    ]);
  }

  tempDirectory(path: string): string | undefined {
    return this.records.get(canonicalPath(path))?.tempDir;
  }

  async remove(
    requested: string,
    discardChanges: boolean,
  ): Promise<WorktreeChanges | null> {
    const path = canonicalPath(requested);
    const record = this.records.get(path);
    if (!record) {
      throw new Error(
        `Worktree is not owned by this runtime; kept at: ${path}`,
      );
    }
    const { stdout: common } = await execa(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: path },
    );
    if (
      canonicalPath(await resolveGitDir(path)) !== record.gitDir ||
      canonicalPath(resolve(path, common.trim())) !== record.commonDir
    ) {
      throw new Error("Worktree Git identity changed; refusing cleanup");
    }
    const backlink = (
      await readFile(join(record.gitDir, "gitdir"), "utf8")
    ).trim();
    const { stdout: repositoryCommon } = await execa(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: record.gitRoot },
    );
    if (
      canonicalPath(resolve(record.gitDir, backlink)) !==
        canonicalPath(join(path, GIT_DIR_NAME)) ||
      canonicalPath(resolve(record.gitRoot, repositoryCommon.trim())) !==
        record.commonDir ||
      (await getCurrentBranch(path)) !== record.branch
    ) {
      throw new Error(
        "Worktree registration or branch changed; refusing cleanup",
      );
    }
    const changes = await countWorktreeChanges(path, record.headCommit);
    if (!discardChanges) {
      if (!changes) {
        throw new Error(WORKTREE_STATE_UNVERIFIED_GUIDANCE);
      }
      if (
        changes.changedFiles > 0 ||
        changes.commits > 0 ||
        (await hasWorktreeChanges(path, record.headCommit))
      ) {
        throw new Error(
          buildWorktreeChangesGuidance(changes.changedFiles, changes.commits),
        );
      }
    }
    await removeAgentWorktree(
      path,
      record.branch,
      record.gitRoot,
      discardChanges,
    );
    this.records.delete(path);
    return changes;
  }
}

export async function removeAgentWorktree(
  path: string,
  branch: string,
  gitRoot: string,
  discardChanges = false,
): Promise<void> {
  // Without explicit discard permission, Git rechecks dirty/locked worktrees
  // and preserves unmerged branches even if they changed after inspection.
  await execa(
    "git",
    ["worktree", "remove", ...(discardChanges ? ["--force"] : []), "--", path],
    {
      cwd: gitRoot,
    },
  );
  await execa("git", ["branch", discardChanges ? "-D" : "-d", "--", branch], {
    cwd: gitRoot,
  });
}

export async function countWorktreeChanges(
  path: string,
  headCommit: string,
): Promise<WorktreeChanges | null> {
  try {
    const [{ stdout: status }, { stdout: count }] = await Promise.all([
      execa("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: path,
      }),
      execa("git", ["rev-list", "--count", `${headCommit}..HEAD`], {
        cwd: path,
      }),
    ]);
    const commits = Number(count.trim());
    if (!Number.isSafeInteger(commits) || commits < 0) {
      return null;
    }
    return {
      changedFiles: status.split("\n").filter((line) => line.trim()).length,
      commits,
    };
  } catch (err) {
    log.error({ err }, "failed to inspect worktree changes");
    return null;
  }
}

export async function hasWorktreeChanges(
  path: string,
  headCommit: string,
): Promise<boolean> {
  try {
    const { stdout: status } = await execa("git", ["status", "--porcelain"], {
      cwd: path,
    });

    if (status.trim()) {
      return true;
    }

    // Compare HEAD SHA: prefer pure filesystem read
    const currentHead =
      (await readWorktreeHeadSha(path)) ||
      (await execa("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();

    return currentHead !== headCommit;
  } catch (err) {
    log.error({ err }, "worktree operation failed");
    return true; // Conservative handling on failure: assume there are changes
  }
}

/**
 * Propagates settings, hooks, symlinks, and .worktreeinclude files from the
 * main repo into a newly created worktree. Failures are logged but never
 * propagated — they must not break worktree creation.
 */
async function performPostCreationSetup(
  repoRoot: string,
  wtPath: string,
): Promise<void> {
  await copyAgentsSettings(repoRoot, wtPath);
  await configureHooksPath(repoRoot, wtPath);
  await symlinkNodeModules(repoRoot, wtPath);
  await copyWorktreeIncludeFiles(repoRoot, wtPath);
}

async function copyAgentsSettings(
  repoRoot: string,
  wtPath: string,
): Promise<void> {
  const agentsDir = join(repoRoot, SKILLS_AGENTS_DIR_NAME);
  if (!(await pathExists(agentsDir))) {
    return;
  }
  const dstRoot = join(wtPath, SKILLS_AGENTS_DIR_NAME);
  try {
    await mkdir(dstRoot, { recursive: true });
  } catch (err) {
    log.error({ err }, "failed to create .agents in worktree");
    return;
  }
  for (const entry of SHARED_AGENTS_ENTRIES) {
    const src = join(agentsDir, entry);
    if (!(await pathExists(src))) {
      continue;
    }
    try {
      await cp(src, join(dstRoot, entry), { recursive: true });
    } catch (err) {
      log.error({ err, entry }, "failed to copy .agents/ entry to worktree");
    }
  }
}

/**
 * Gives a worktree its own absolute Husky hooks path without changing the
 * shared core.hooksPath. Git's default common .git/hooks directory needs no
 * configuration. Existing user configuration always takes precedence.
 */
async function configureHooksPath(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    const existing = await execa("git", ["config", "--get", "core.hooksPath"], {
      cwd: worktreePath,
    })
      .then((result) => result.stdout.trim())
      .catch(() => "");
    if (existing) {
      return;
    }

    const hooksPath = join(repoRoot, ".husky");
    try {
      const info = await stat(hooksPath);
      if (!info.isDirectory()) {
        return;
      }
    } catch (err) {
      // No Husky directory means Git's shared default hooks remain in effect.
      log.debug({ err }, "husky hooks path probe failed");
      return;
    }

    await execa("git", ["config", "extensions.worktreeConfig", "true"], {
      cwd: worktreePath,
    });
    await execa("git", ["config", "--worktree", "core.hooksPath", hooksPath], {
      cwd: worktreePath,
    });
  } catch (err) {
    log.error({ err }, "failed to configure hooks path in worktree");
  }
}

/**
 * If node_modules exists in the source repo, create a symlink in the worktree
 * pointing to it so dependencies don't need to be re-installed.
 */
async function symlinkNodeModules(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    const src = join(repoRoot, "node_modules");
    if (!(await pathExists(src))) {
      return;
    }
    const dst = join(worktreePath, "node_modules");
    if (await pathExists(dst)) {
      return;
    } // already present
    await symlink(src, dst);
  } catch (err) {
    log.warn({ err }, "failed to symlink node_modules in worktree");
  }
}

/**
 * If .worktreeinclude exists in the source root, read it (one path per line,
 * blank lines and #-comments skipped) and copy each listed file/directory into
 * the worktree.
 */
async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    const includeFile = join(repoRoot, ".worktreeinclude");
    if (!(await pathExists(includeFile))) {
      return;
    }

    const content = await readFile(includeFile, "utf-8");
    const paths = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    for (const relPath of paths) {
      // Guard against path traversal.
      if (relPath.includes("..")) {
        continue;
      }

      try {
        const src = join(repoRoot, relPath);
        if (!(await pathExists(src))) {
          continue;
        }

        const dst = join(worktreePath, relPath);
        await mkdir(dirname(dst), { recursive: true });

        const info = await stat(src);
        if (info.isDirectory()) {
          await cp(src, dst, { recursive: true });
        } else {
          await cp(src, dst);
        }
      } catch (err) {
        log.error({ err }, "worktree operation failed");
        // best-effort per file — skip failures
      }
    }
  } catch (err) {
    log.error({ err }, "failed to process .worktreeinclude");
  }
}
