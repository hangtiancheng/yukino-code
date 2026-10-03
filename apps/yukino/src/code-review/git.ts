import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

import { parseDiffText } from "./diff-parser.js";
import type { FileDiff, ReviewMode } from "./types.js";

const execFileAsync = promisify(execFile);

/** Context lines per hunk. */
const DIFF_CONTEXT_LINES = 3;
/** Untracked files above this size are reported as binary. */
const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024;
/** Leading bytes sniffed for NUL to decide binary-ness, matching git's heuristic. */
const BINARY_SNIFF_WINDOW = 8000;

const DIFF_FLAGS = [
  "-c",
  "core.quotepath=false",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-color",
  `-U${String(DIFF_CONTEXT_LINES)}`,
];

async function runGit(
  workDir: string,
  args: string[],
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd: workDir,
    maxBuffer: 256 * 1024 * 1024,
    signal: abortSignal,
  });
}

async function tryGit(
  workDir: string,
  args: string[],
  abortSignal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(workDir, args, abortSignal);
    return stdout;
  } catch {
    return null;
  }
}

function looksBinary(content: Buffer): boolean {
  const window = content.subarray(0, BINARY_SNIFF_WINDOW);
  return window.includes(0);
}

function quoteDiffPath(prefix: "a" | "b", path: string): string {
  const value = `${prefix}/${path}`;
  return /[\s"\\]/u.test(value) ? JSON.stringify(value) : value;
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
  workDir: string,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  // -z delimits records with NUL: filenames may contain newlines, and
  // whitespace is a legal filename byte — splitting on "\n" or trimming
  // silently drops files.
  const list = await tryGit(
    workDir,
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
    let content: Buffer;
    try {
      content = await readFile(join(workDir, f));
    } catch {
      continue;
    }
    if (content.length > MAX_UNTRACKED_FILE_SIZE || looksBinary(content)) {
      results.push(untrackedBinaryDiff(f));
      continue;
    }
    results.push(untrackedFileDiff(f, content));
  }
  return results;
}

export interface CollectDiffsOptions {
  workDir: string;
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
  const { workDir, mode, abortSignal } = options;
  options.abortSignal?.throwIfAborted();

  let combined = "";
  /** Ref used to read new-side file content via `git show ref:path`. */
  let ref = "";

  if (mode === "range") {
    const from = options.from ?? "";
    const to = options.to ?? "";
    const base = await tryGit(workDir, ["merge-base", from, to], abortSignal);
    if (!base?.trim()) {
      throw new Error(`Cannot find merge-base between ${from} and ${to}`);
    }
    const { stdout } = await runGit(
      workDir,
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
      workDir,
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
      workDir,
      [...DIFF_FLAGS, "--end-of-options", "HEAD", "--"],
      abortSignal,
    );
    if (tracked === null) {
      const staged = await runGit(
        workDir,
        [...DIFF_FLAGS, "--staged", "--"],
        abortSignal,
      );
      tracked = staged.stdout;
    }
    combined = tracked;
    const untracked = await untrackedFileDiffs(workDir, abortSignal);
    for (const ud of untracked) {
      combined += `${ud}\n`;
    }
  }

  options.abortSignal?.throwIfAborted();

  return parseDiffText(combined, {
    readNewFileContent: async (newPath: string) => {
      if (ref) {
        const out = await tryGit(workDir, [
          "-c",
          "core.quotepath=false",
          "show",
          "--end-of-options",
          `${ref}:${newPath}`,
        ]);
        return out ?? undefined;
      }
      try {
        return await readFile(join(workDir, newPath), "utf8");
      } catch {
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
