import { execFile } from "child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
} from "fs/promises";
import { dirname, isAbsolute, join } from "path";
import { promisify } from "util";

import { createChildLogger } from "@/logger/index.js";
import { yukinoPath, projectKey } from "@/storage/paths.js";

const log = createChildLogger({ module: "worktree" });

const execFileAsync = promisify(execFile);

export interface WorktreeResult {
  path: string;
  branch: string;
  headCommit: string;
  gitRoot: string;
}

// Pure filesystem-based git HEAD reading: the helpers in this section retrieve
// the branch and SHA by directly reading files under the .git directory,
// without spawning a git subprocess — saving the ~15ms process-spawn overhead
// per call.

/**
 * Allowed character set of ref names — excludes whitespace and shell
 * metacharacters. Path traversal is ruled out together with the ".." and
 * leading-slash checks in isSafeRefName.
 */
const SAFE_REF_RE = /^[a-zA-Z0-9/._+@-]+$/;

/** Full SHA-1 (40 hex) or SHA-256 (64 hex) */
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function isSafeRefName(name: string): boolean {
  if (!name || name.startsWith("-") || name.startsWith("/")) {
    return false;
  }
  if (name.includes("..")) {
    return false;
  }
  const segments = name.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "") {
      return false;
    }
  }

  return SAFE_REF_RE.test(name);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    // ENOENT is the normal "no" answer here; error-level logs would flood on
    // every healthy probe.
    log.debug({ err }, "worktree path probe failed");
    return false;
  }
}

/**
 * Resolves the .git directory: handles scenarios where .git is a file instead of a directory
 * (e.g., in worktrees or submodules).
 * Returns an empty string to indicate it is not a git repository
 */
export async function resolveGitDir(root: string): Promise<string> {
  const gitPath = join(root, ".git");
  if (!(await pathExists(gitPath))) {
    return "";
  }
  const stats = await stat(gitPath);
  if (stats.isDirectory()) {
    return gitPath;
  }

  // Worktree / submodule: .git is a file containing `gitdir: <path>`
  const raw = (await readFile(gitPath, "utf-8")).trim();
  if (!raw.startsWith("gitdir:")) {
    return "";
  }
  const rel = raw.slice("gitdir:".length).trim();
  return isAbsolute(rel) ? rel : join(root, rel);
}

/**
 * Read the commondir file in the worktree gitDir to locate the shared git directory
 */
async function getCommonDir(gitDir: string): Promise<string> {
  try {
    const commonDir = join(gitDir, "commondir");
    const raw = (await readFile(commonDir, "utf-8")).trim();
    return isAbsolute(raw) ? raw : join(gitDir, raw);
  } catch (err) {
    // The main repo has no commondir — expected, not a failure.
    log.debug({ err }, "worktree commondir probe failed");
    return "";
  }
}

interface GitHead {
  branch?: string; // Non-empty indicates on a branch
  sha?: string; // Non-empty indicates detached HEAD or a resolved non-branch symref
}

/**
 * Parse the <gitDir>/HEAD file to get the current branch or detached SHA.
 * Returns null if the file does not exist, has an invalid format, references
 * an unsafe ref name, or the symref cannot be resolved to a SHA.
 */

async function readGitHead(gitDir: string): Promise<GitHead | null> {
  let raw: string;
  try {
    raw = (await readFile(join(gitDir, "HEAD"), "utf-8")).trim();
  } catch (err) {
    log.error({ err }, "worktree operation failed");
    return null;
  }

  if (raw.startsWith("ref:")) {
    const ref = raw.slice("ref:".length).trim();
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (!isSafeRefName(name)) {
        return null;
      }

      return { branch: name };
    }

    // HEAD is a symref to a ref outside refs/heads/ — resolve it to a SHA
    if (!isSafeRefName(ref)) {
      return null;
    }

    const sha = await resolveRef(gitDir, ref);
    return sha ? { sha } : null;
  }

  // Bare SHA (detached HEAD)
  if (SHA_RE.test(raw)) {
    return { sha: raw };
  }

  return null;
}

/**
 * Resolves a ref within a single git directory (checks loose files first, then packed-refs)
 */
async function resolveRefInDir(
  dir: string,
  ref: string,
  seen: Set<string>,
): Promise<string> {
  const key = `${dir}\0${ref}`;
  if (seen.size >= 64 || seen.has(key)) {
    return "";
  }
  seen.add(key);
  try {
    const content = (await readFile(join(dir, ref), "utf-8")).trim();
    if (content.startsWith("ref:")) {
      const target = content.slice("ref:".length).trim();
      if (!isSafeRefName(target)) {
        return "";
      }
      return await resolveRef(dir, target, seen);
    }
    if (SHA_RE.test(content)) {
      return content;
    }
    return "";
  } catch (err) {
    // Loose ref missing is normal (packed refs); the packed-refs fallback
    // below is the real lookup for healthy worktrees.
    log.debug({ err }, "loose ref probe failed");
  }

  try {
    const packed = await readFile(join(dir, "packed-refs"), "utf-8");
    for (const line of packed.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) {
        continue;
      }
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) {
        continue;
      }
      if (line.slice(spaceIdx + 1) === ref) {
        const sha = line.slice(0, spaceIdx);
        if (SHA_RE.test(sha)) {
          return sha;
        }
        return "";
      }
    }
  } catch (err) {
    // No packed-refs file is normal for repos with only loose refs.
    log.debug({ err }, "packed-refs probe failed");
  }

  return "";
}

/** Resolves a git ref — checks the worktree gitDir first, then falls back to commonDir */
async function resolveRef(
  gitDir: string,
  ref: string,
  seen = new Set<string>(),
): Promise<string> {
  const sha = await resolveRefInDir(gitDir, ref, seen);
  if (sha) {
    return sha;
  }

  const commonDir = await getCommonDir(gitDir);
  if (commonDir && commonDir !== gitDir) {
    return resolveRefInDir(commonDir, ref, seen);
  }
  return "";
}

/**
 * Pure filesystem read of a worktree's HEAD SHA. Directly reads the <worktreePath>/.git
 * pointer file without going through resolveGitDir.
 * Returns an empty string if it is not a valid worktree.
 *
 * Performance target: ≤10ms (pure file IO, no subprocesses).
 */
export async function readWorktreeHeadSha(
  worktreePath: string,
): Promise<string> {
  let raw: string;
  try {
    raw = (await readFile(join(worktreePath, ".git"), "utf-8")).trim();
  } catch (err) {
    // Candidates that are not worktrees fail here — that is the probe's
    // "no" answer, not an error.
    log.debug({ err }, "worktree .git probe failed");
    return "";
  }
  if (!raw.startsWith("gitdir:")) {
    return "";
  }

  const rel = raw.slice("gitdir:".length).trim();
  const gitDir = isAbsolute(rel) ? rel : join(worktreePath, rel);

  const head = await readGitHead(gitDir);
  if (!head) {
    return "";
  }

  if (head.branch) {
    return resolveRef(gitDir, "refs/heads/" + head.branch);
  }
  return head.sha ?? "";
}

/**
 * Gets the current branch name (pure filesystem read).
 * Returns an empty string if detached HEAD or not a git repository.
 */
export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const gitDir = await resolveGitDir(repoRoot);
  if (!gitDir) {
    return "";
  }
  const head = await readGitHead(gitDir);
  if (!head) {
    return "";
  }
  return head.branch ?? "";
}

export async function createAgentWorktree(
  slug: string,
  gitRoot?: string,
  cwd = process.cwd(),
): Promise<WorktreeResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(
      "Invalid worktree slug: use only alphanumeric, hyphen, underscore",
    );
  }
  const root =
    gitRoot ??
    (
      await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: cwd,
      })
    ).stdout.trim();

  const worktreeDir = yukinoPath("worktrees", projectKey(root), slug);
  const branch = `worktree-${slug}`;

  // Validate that an existing directory is really a worktree root before reusing
  // it: git otherwise searches parent directories and would report the main
  // repository's HEAD as this worktree's commit.
  if (await pathExists(worktreeDir)) {
    let topLevel: string;
    try {
      topLevel = (
        await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
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
      return { path: worktreeDir, branch, headCommit: head, gitRoot: root };
    }
    // Fallback to git subprocess if filesystem read fails
    const { stdout: headFallback } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      {
        cwd: worktreeDir,
      },
    );
    return {
      path: worktreeDir,
      branch,
      headCommit: headFallback.trim(),
      gitRoot: root,
    };
  }

  // Reattach residual branches at their existing tip. Creating with -b also
  // refuses a branch created concurrently instead of resetting its commits.
  const { stdout: existingBranch } = await execFileAsync(
    "git",
    ["branch", "--list", "--format=%(refname)", "--", branch],
    { cwd: root },
  );
  const addArgs = existingBranch.trim()
    ? ["worktree", "add", "--", worktreeDir, branch]
    : ["worktree", "add", "-b", branch, "--", worktreeDir];
  await execFileAsync("git", addArgs, {
    cwd: root,
  });

  await performPostCreationSetup(root, worktreeDir);

  // Prefer filesystem read for HEAD in newly created worktrees
  const head = await readWorktreeHeadSha(worktreeDir);
  if (head) {
    return { path: worktreeDir, branch, headCommit: head, gitRoot: root };
  }
  // Fallback to subprocess
  const { stdout: headFallback } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    {
      cwd: worktreeDir,
    },
  );

  return {
    path: worktreeDir,
    branch,
    headCommit: headFallback.trim(),
    gitRoot: root,
  };
}

export async function removeAgentWorktree(
  path: string,
  branch: string,
  gitRoot: string,
): Promise<void> {
  // Git rechecks for dirty/locked worktrees at removal time. If removal fails,
  // stop here; if the branch has unmerged commits, -d leaves its tip intact.
  await execFileAsync("git", ["worktree", "remove", "--", path], {
    cwd: gitRoot,
  });
  await execFileAsync("git", ["branch", "-d", "--", branch], { cwd: gitRoot });
}

export async function hasWorktreeChanges(
  path: string,
  headCommit: string,
): Promise<boolean> {
  try {
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      {
        cwd: path,
      },
    );

    if (status.trim()) {
      return true;
    }

    // Compare HEAD SHA: prefer pure filesystem read
    const currentHead =
      (await readWorktreeHeadSha(path)) ||
      (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: path })
      ).stdout.trim();

    return currentHead !== headCommit;
  } catch (err) {
    log.error({ err }, "worktree operation failed");
    return true; // Conservative handling on failure: assume there are changes
  }
}

export function buildWorktreeNotice(parentCwd: string, wtPath: string): string {
  return (
    `You are working in a git worktree at: ${wtPath}\n` +
    `The parent project is at: ${parentCwd}\n` +
    `Changes made here are isolated from the parent working tree.`
  );
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

const SHARED_AGENTS_ENTRIES = ["AGENTS.md", "skills"];

async function copyAgentsSettings(
  repoRoot: string,
  wtPath: string,
): Promise<void> {
  const agentsDir = join(repoRoot, ".agents");
  if (!(await pathExists(agentsDir))) {
    return;
  }
  const dstRoot = join(wtPath, ".agents");
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
    const existing = await execFileAsync(
      "git",
      ["config", "--get", "core.hooksPath"],
      { cwd: worktreePath },
    )
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

    await execFileAsync(
      "git",
      ["config", "extensions.worktreeConfig", "true"],
      { cwd: worktreePath },
    );
    await execFileAsync(
      "git",
      ["config", "--worktree", "core.hooksPath", hooksPath],
      { cwd: worktreePath },
    );
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
