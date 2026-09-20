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

const log = createChildLogger({ module: "worktree" });

const execFileAsync = promisify(execFile);

export interface WorktreeResult {
  path: string;
  branch: string;
  headCommit: string;
  gitRoot: string;
}

// Pure filesystem-based git HEAD reading
// The following functions retrieve the branch and SHA by directly reading files
// under the .git directory, without spawning a git subprocess.

// This saves ~15ms of process startup overhead in large repositories (with millions of objects)

/** Allowed character set of ref names - prevents path traversal and shell injection */
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

/** Helper to check if a path exists */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    log.error({ err }, "worktree operation failed");
    return false;
  }
}

/**
 * Resolves the .git directory: handles scenarios where .git is a file instead of a directory
 * (e.g., in worktrees or submodules).
 * Returns an empty string to indicate it not a git repository
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
    log.error({ err }, "worktree operation failed");
    return "";
  }
}

interface GitHead {
  branch?: string; // Non-empty indicates on a branch
  sha?: string; // Non-empty indicates detached HEAD
}

/**
 * Parse the <gitDir>/HEAD file to get the current branch or detached SHA
 * Returns null if the file does not exist or has an invalid format
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

    // Non-standard symref (e.g., bisect) -- resolve to SHA
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
async function resolveRefInDir(dir: string, ref: string): Promise<string> {
  // Check loose ref file first
  try {
    const content = (await readFile(join(dir, ref), "utf-8")).trim();
    if (content.startsWith("ref:")) {
      const target = content.slice("ref:".length).trim();
      if (!isSafeRefName(target)) {
        return "";
      }
      return await resolveRef(dir, target);
    }
    if (SHA_RE.test(content)) {
      return content;
    }
    return "";
  } catch (err) {
    log.error({ err }, "worktree operation failed");
    // Loose file does not exist, try packed-refs
  }

  // Check packed-refs
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
    log.error({ err }, "worktree operation failed");
    // packed-refs does not exist
  }

  return "";
}

/** Resolves a git ref — checks the worktree gitDir first, then falls back to commonDir */
async function resolveRef(gitDir: string, ref: string): Promise<string> {
  const sha = await resolveRefInDir(gitDir, ref);
  if (sha) {
    return sha;
  }

  const commonDir = await getCommonDir(gitDir);
  if (commonDir && commonDir !== gitDir) {
    return resolveRefInDir(commonDir, ref);
  }
  return "";
}

/**
 * Pure filesystem read of a worktree's HEAD SHA. Directly reads the <worktreePath>/.git
 * pointer file, bypassing the upward traversal logic of resolveGitDir.
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
    log.error({ err }, "worktree operation failed");
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

// ── Worktree Management ──────────────────────────────────────────────

export async function createAgentWorktree(
  slug: string,
  gitRoot?: string,
): Promise<WorktreeResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(
      "Invalid worktree slug: use only alphanumeric, hyphen, underscore",
    );
  }
  const root =
    gitRoot ??
    (
      await execFileAsync("git", ["rev-parse", "--show-toplevel"])
    ).stdout.trim();

  const worktreeDir = join(root, ".yukino", "worktrees", slug);
  const branch = `worktree-${slug}`;

  // Validate the existing root before restoration: git otherwise searches parent
  // directories and could report the main repository's HEAD as an isolated worktree.
  if (await pathExists(worktreeDir)) {
    const { stdout: topLevel } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: worktreeDir,
      },
    );
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
  await copyYukinoSettings(repoRoot, wtPath);
  await copyAgentsSettings(repoRoot, wtPath);
  await configureHooksPath(repoRoot, wtPath);
  await symlinkNodeModules(repoRoot, wtPath);
  await copyWorktreeIncludeFiles(repoRoot, wtPath);
}

/**
 * Shared settings entries under .yukino/ that are propagated to worktrees.
 * Runtime state (sessions, file-history, plans, logs, teams) is excluded, and
 * worktrees/ must never be included: worktrees live inside .yukino itself, so
 * copying the whole directory targets a subdirectory of its own source and
 * Node's cp rejects that with EINVAL.
 */
const SHARED_YUKINO_ENTRIES = ["permissions.yaml", "agents", "memory"];
const SHARED_AGENTS_ENTRIES = ["AGENTS.md", "skills"];

/** Copy shared .yukino/ settings from the main repo to the worktree. */
async function copyYukinoSettings(
  repoRoot: string,
  wtPath: string,
): Promise<void> {
  const yukinoDir = join(repoRoot, ".yukino");
  if (!(await pathExists(yukinoDir))) {
    return;
  }
  const dstRoot = join(wtPath, ".yukino");
  try {
    await mkdir(dstRoot, { recursive: true });
  } catch (err) {
    log.error({ err }, "failed to create .yukino/ in worktree");
    return;
  }
  for (const entry of SHARED_YUKINO_ENTRIES) {
    const src = join(yukinoDir, entry);
    if (!(await pathExists(src))) {
      continue;
    }
    try {
      await cp(src, join(dstRoot, entry), { recursive: true });
    } catch (err) {
      log.error({ err, entry }, "failed to copy .yukino/ entry to worktree");
    }
  }
}

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
 * Set core.hooksPath in the worktree so git hooks from the main repo are
 * shared. Prioritizes .husky/ over .git/hooks/.
 */
async function configureHooksPath(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    const candidates = [
      join(repoRoot, ".husky"),
      join(repoRoot, ".git", "hooks"),
    ];
    let hooksPath: string | undefined;
    for (const c of candidates) {
      try {
        const info = await stat(c);
        if (info.isDirectory()) {
          hooksPath = c;
          break;
        }
      } catch (err) {
        log.error({ err }, "worktree operation failed");
        // candidate doesn't exist, try next
      }
    }
    if (!hooksPath) {
      return;
    }

    await execFileAsync("git", ["config", "core.hooksPath", hooksPath], {
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
