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
import { dirname, isAbsolute, join, resolve } from "path";
import { promisify } from "util";

import { createChildLogger } from "@/logger/index.js";
import { yukinoPath, projectKey } from "@/storage/index.js";
import { canonicalPath } from "@/utils/paths.js";
import {
  SAFE_REF_RE,
  SHA_RE,
  SHARED_AGENTS_ENTRIES,
  WORKTREE_SLUG_PATTERN,
} from "@/worktree/constants.js";

export * as Constants from "@/worktree/constants.js";
export * as Prompts from "@/worktree/prompts.js";

const log = createChildLogger({ module: "worktree" });

const execFileAsync = promisify(execFile);

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

// Pure filesystem-based git HEAD reading: the helpers in this section retrieve
// the branch and SHA by directly reading files under the .git directory,
// without spawning a git subprocess — saving the ~15ms process-spawn overhead
// per call.

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
  if (!WORKTREE_SLUG_PATTERN.test(slug)) {
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
  const branch = `worktree/${slug}/work`;

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
      return {
        path: worktreeDir,
        branch,
        headCommit: head,
        gitRoot: root,
        created: false,
      };
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
      created: false,
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
    return {
      path: worktreeDir,
      branch,
      headCommit: head,
      gitRoot: root,
      created: true,
    };
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
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: path },
    );
    const commonDir = canonicalPath(resolve(path, stdout.trim()));
    const branchDirectory = dirname(worktree.branch);
    if (!isSafeRefName(worktree.branch) || branchDirectory === ".") {
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
    const { stdout: common } = await execFileAsync(
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
    const { stdout: repositoryCommon } = await execFileAsync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: record.gitRoot },
    );
    if (
      canonicalPath(resolve(record.gitDir, backlink)) !==
        canonicalPath(join(path, ".git")) ||
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
        throw new Error(
          'Could not verify worktree state. Refusing to remove. Confirm with the user, then retry with discard_changes: true, or use action: "keep".',
        );
      }
      if (
        changes.changedFiles > 0 ||
        changes.commits > 0 ||
        (await hasWorktreeChanges(path, record.headCommit))
      ) {
        throw new Error(
          `Worktree has ${changes.changedFiles} uncommitted files and ${changes.commits} commits. Confirm with the user, then retry with discard_changes: true, or use action: "keep".`,
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
  await execFileAsync(
    "git",
    ["worktree", "remove", ...(discardChanges ? ["--force"] : []), "--", path],
    {
      cwd: gitRoot,
    },
  );
  await execFileAsync(
    "git",
    ["branch", discardChanges ? "-D" : "-d", "--", branch],
    { cwd: gitRoot },
  );
}

export async function countWorktreeChanges(
  path: string,
  headCommit: string,
): Promise<WorktreeChanges | null> {
  try {
    const [{ stdout: status }, { stdout: count }] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: path,
      }),
      execFileAsync("git", ["rev-list", "--count", `${headCommit}..HEAD`], {
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
