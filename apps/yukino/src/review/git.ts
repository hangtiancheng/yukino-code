import { execFile } from "child_process";
import { constants } from "fs";
import { lstat, open, readlink } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

import {
  BINARY_SNIFF_WINDOW,
  DIFF_CONTEXT_LINES,
  DIFF_FLAGS,
  MAX_UNTRACKED_FILE_SIZE,
  OPEN_NOFOLLOW,
} from "@/review/constants.js";
import { parseDiffText, quoteGitPath } from "@/review/diff-parser.js";
import type { FileDiff, ReviewMode } from "@/review/types.js";

const execFileAsync = promisify(execFile);

async function runGit(
  cwd: string,
  args: string[],
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd: cwd,
    maxBuffer: 256 * 1024 * 1024,
    signal: abortSignal,
  });
}

async function tryGit(
  cwd: string,
  args: string[],
  abortSignal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, args, abortSignal);
    return stdout;
  } catch (err) {
    // A cancellation must propagate as such. Swallowing it here would make the
    // caller treat an aborted `git` as a plain failure and either fall back to
    // another Git path or report a bogus "no merge-base" error.
    if (abortSignal?.aborted) {
      abortSignal.throwIfAborted();
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    return null;
  }
}

function looksBinary(content: Buffer): boolean {
  const window = content.subarray(0, BINARY_SNIFF_WINDOW);
  return window.includes(0);
}

function quoteDiffPath(prefix: "a" | "b", path: string): string {
  return quoteGitPath(`${prefix}/${path}`);
}

function untrackedBinaryDiff(path: string): string {
  const oldPath = quoteDiffPath("a", path);
  const newPath = quoteDiffPath("b", path);
  return (
    `diff --git ${oldPath} ${newPath}\n` +
    `new file mode 100644\n` +
    `Binary files /dev/null and ${newPath} differ\n`
  );
}

// Git stores a symlink as mode 120000 whose blob is the target path. Emit
// exactly that so the parser/comment tooling see a link and never the (possibly
// external, possibly secret) target's contents.
function untrackedSymlinkDiff(relPath: string, target: string): string {
  const diff = untrackedFileDiff(relPath, Buffer.from(target));
  const headerEnd = diff.indexOf("\n");
  return `${diff.slice(0, headerEnd)}\nnew file mode 120000${diff.slice(headerEnd)}`;
}

// Over-limit files get their own status rather than being disguised as binary.
function untrackedTooLargeDiff(relPath: string, size: number): string {
  const oldPath = quoteDiffPath("a", relPath);
  const newPath = quoteDiffPath("b", relPath);
  return (
    `diff --git ${oldPath} ${newPath}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ ${newPath}\n` +
    `yukino skipped too-large (${String(size)} bytes)\n`
  );
}

/** Synthesize a new-file diff for one untracked workspace file. */
function untrackedFileDiff(relPath: string, content: Buffer): string {
  const oldPath = quoteDiffPath("a", relPath);
  const newPath = quoteDiffPath("b", relPath);
  const parts: string[] = [
    `diff --git ${oldPath} ${newPath}`,
    "--- /dev/null",
    `+++ ${newPath}`,
  ];
  let text = content.toString("utf8");
  let lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  parts.push(`@@ -0,0 +1,${String(lines.length)} @@`);
  for (const line of lines) {
    parts.push(`+${line}`);
  }
  text = parts.join("\n");
  return `${text}\n`;
}

async function untrackedFileDiffs(
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  // -z delimits records with NUL: filenames may contain newlines, and
  // whitespace is a legal filename byte — splitting on "\n" or trimming
  // silently drops files.
  const list = await tryGit(
    cwd,
    [
      "-c",
      "core.quotepath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    abortSignal,
  );
  if (!list) {
    return [];
  }
  const files = list.split("\0").filter((f) => f.length > 0);
  const results: string[] = [];
  for (const f of files) {
    abortSignal?.throwIfAborted();
    const fullPath = join(cwd, f);
    let st;
    try {
      st = await lstat(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      // Represent the link itself; never dereference it (the target may point
      // outside the repo at a secret).
      try {
        results.push(untrackedSymlinkDiff(f, await readlink(fullPath)));
      } catch {
        // unreadable link → skip
      }
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    // Gate on metadata before allocating: never buffer a file just to discover
    // it is over the limit.
    if (st.size > MAX_UNTRACKED_FILE_SIZE) {
      results.push(untrackedTooLargeDiff(f, st.size));
      continue;
    }
    let content: Buffer | null = null;
    let tooLarge = 0;
    try {
      const fh = await open(
        fullPath,
        constants.O_RDONLY | OPEN_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
      );
      try {
        // fstat on the open handle reflects the real size even if the file
        // grew after the lstat, so the bounded read cannot be bypassed.
        const fst = await fh.stat();
        if (!fst.isFile()) {
          continue;
        }
        if (fst.size > MAX_UNTRACKED_FILE_SIZE) {
          tooLarge = fst.size;
        } else {
          const buf = Buffer.alloc(fst.size);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          content = buf.subarray(0, bytesRead);
        }
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    if (tooLarge > 0) {
      results.push(untrackedTooLargeDiff(f, tooLarge));
      continue;
    }
    if (content === null) {
      continue;
    }
    if (looksBinary(content)) {
      results.push(untrackedBinaryDiff(f));
      continue;
    }
    results.push(untrackedFileDiff(f, content));
  }
  return results;
}

export interface CollectDiffsOptions {
  cwd: string;
  mode: ReviewMode;
  from?: string;
  to?: string;
  commit?: string;
  abortSignal?: AbortSignal;
}

/**
 * Collect structured per-file diffs for the requested review input:
 * workspace = tracked changes vs HEAD plus synthesized untracked diffs;
 * range = merge-base(from,to)..to; commit = first-parent show.
 */
export async function collectDiffs(
  options: CollectDiffsOptions,
): Promise<FileDiff[]> {
  const { cwd, mode, abortSignal } = options;
  options.abortSignal?.throwIfAborted();

  let combined = "";
  /** Ref used to read new-side file content via `git show ref:path`. */
  let ref = "";

  if (mode === "range") {
    const from = options.from ?? "";
    const to = options.to ?? "";
    const base = await tryGit(cwd, ["merge-base", from, to], abortSignal);
    if (!base?.trim()) {
      throw new Error(`Cannot find merge-base between ${from} and ${to}`);
    }
    const { stdout } = await runGit(
      cwd,
      [...DIFF_FLAGS, "--end-of-options", base.trim(), to, "--"],
      abortSignal,
    );
    combined = stdout;
    ref = to;
  } else if (mode === "commit") {
    const commit = options.commit ?? "";
    // --diff-merges=first-parent: plain `git show` emits a combined diff
    // ("diff --cc") for merge commits, which the parser cannot read.
    const { stdout } = await runGit(
      cwd,
      [
        "-c",
        "core.quotepath=false",
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--no-color",
        "--diff-merges=first-parent",
        `-U${String(DIFF_CONTEXT_LINES)}`,
        "--end-of-options",
        commit,
      ],
      abortSignal,
    );
    combined = stdout;
    ref = commit;
  } else {
    // Workspace: `git diff HEAD` covers staged + unstaged. In a repo with no
    // commits HEAD fails, so fall back to the staged diff against the empty
    // tree — the only way to review a workspace before its first commit.
    let tracked = await tryGit(
      cwd,
      [...DIFF_FLAGS, "--end-of-options", "HEAD", "--"],
      abortSignal,
    );
    if (tracked === null) {
      const staged = await runGit(
        cwd,
        [...DIFF_FLAGS, "--staged", "--"],
        abortSignal,
      );
      tracked = staged.stdout;
    }
    combined = tracked;
    const untracked = await untrackedFileDiffs(cwd, abortSignal);
    for (const ud of untracked) {
      combined += `${ud}\n`;
    }
  }

  options.abortSignal?.throwIfAborted();

  return parseDiffText(combined, {
    readNewFileContent: async (newPath: string) => {
      if (ref) {
        const out = await tryGit(
          cwd,
          [
            "-c",
            "core.quotepath=false",
            "show",
            "--end-of-options",
            `${ref}:${newPath}`,
          ],
          abortSignal,
        );
        return out ?? undefined;
      }
      try {
        const fullPath = join(cwd, newPath);
        // lstat (not stat): never follow a symlink. A tracked symlink's content
        // is its target path, which the diff already carries; its target may sit
        // outside the repo or be a FIFO/device whose read would hang or exhaust
        // memory. Skip anything that is not a regular file.
        const st = await lstat(fullPath);
        if (!st.isFile()) {
          return undefined;
        }
        // Bound the read: check size first, then read through O_NOFOLLOW so a
        // path swapped for a symlink between lstat and open is not dereferenced.
        if (st.size > MAX_UNTRACKED_FILE_SIZE) {
          return undefined;
        }
        const fh = await open(
          fullPath,
          constants.O_RDONLY | OPEN_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
        );
        try {
          const fst = await fh.stat();
          if (!fst.isFile() || fst.size > MAX_UNTRACKED_FILE_SIZE) {
            return undefined;
          }
          const buf = Buffer.alloc(fst.size);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          return buf.subarray(0, bytesRead).toString("utf8");
        } finally {
          await fh.close();
        }
      } catch (err) {
        if (abortSignal?.aborted) {
          abortSignal.throwIfAborted();
        }
        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }
        return undefined;
      }
    },
  });
}

/** Derive the review mode from CLI-style flags: commit wins, then range, else workspace. */
export function deriveReviewMode(args: {
  from?: string;
  to?: string;
  commit?: string;
}): ReviewMode {
  if (args.commit) {
    return "commit";
  }
  if (args.from && args.to) {
    return "range";
  }
  return "workspace";
}
