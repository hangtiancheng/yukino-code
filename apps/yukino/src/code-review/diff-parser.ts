import type { FileDiff, Hunk, HunkLine } from "./types.js";

/**
 * Unified-diff parsing. Deterministic engineering: everything downstream (selection,
 * grouping, line resolution) consumes these structures instead of re-reading
 * raw diff text.
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Split diff text on "\n" and drop the "\r" CRLF conversion leaves behind. */
function splitDiffLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/, ""));
}

/**
 * Undo git's C-style path quoting (`"a b\tc"` → `a b<TAB>c`). Git quotes
 * paths containing control characters or non-ASCII bytes; core.quotepath=false
 * (set on every path-emitting invocation in git.ts) suppresses only the
 * non-ASCII quoting.
 */
export function unquoteGitPath(raw: string): string {
  const s = raw.trim();
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) {
    return s;
  }
  const inner = s.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = inner[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      default:
        // Octal escape (\NNN) — decode byte-wise, one char per octal byte; a
        // multi-byte UTF-8 sequence stays split into its byte chars, which
        // only affects display of exotic paths.
        if (next !== undefined && next >= "0" && next <= "7") {
          let oct = next;
          while (
            oct.length < 3 &&
            i + 1 < inner.length &&
            inner[i + 1] >= "0" &&
            inner[i + 1] <= "7"
          ) {
            oct += inner[++i];
          }
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          out += next ?? "";
        }
    }
  }
  return out;
}

function readQuotedPath(raw: string): { path: string; rest: string } | null {
  for (let end = 1; end < raw.length; end++) {
    if (raw[end] === "\\") {
      end++;
    } else if (raw[end] === '"') {
      return {
        path: unquoteGitPath(raw.slice(0, end + 1)),
        rest: raw.slice(end + 1),
      };
    }
  }
  return null;
}

function parseDiffHeaderLine(
  line: string,
): { oldPath: string; newPath: string } | null {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) {
    return null;
  }

  const body = line.slice(prefix.length);
  const quote = body.indexOf('"');
  if (quote >= 0) {
    let oldPath: string;
    let newRaw: string;
    if (quote === 0) {
      const first = readQuotedPath(body);
      if (!first?.rest.startsWith(" ")) {
        return null;
      }
      oldPath = first.path;
      newRaw = first.rest.slice(1);
    } else {
      if (body[quote - 1] !== " ") {
        return null;
      }
      oldPath = body.slice(0, quote - 1);
      newRaw = body.slice(quote);
    }
    let newPath = newRaw;
    if (newRaw.startsWith('"')) {
      const second = readQuotedPath(newRaw);
      if (!second || second.rest) {
        return null;
      }
      newPath = second.path;
    }
    if (!oldPath.startsWith("a/") || !newPath.startsWith("b/")) {
      return null;
    }
    return { oldPath: oldPath.slice(2), newPath: newPath.slice(2) };
  }

  if (!body.startsWith("a/")) {
    return null;
  }
  const paths = body.slice(2);
  const delimiter = " b/";
  const candidates: number[] = [];
  for (
    let index = paths.indexOf(delimiter);
    index >= 0;
    index = paths.indexOf(delimiter, index + delimiter.length)
  ) {
    candidates.push(index);
  }
  const split =
    candidates.find(
      (index) =>
        paths.slice(0, index) === paths.slice(index + delimiter.length),
    ) ?? candidates.at(-1);
  if (split === undefined) {
    return null;
  }
  return {
    oldPath: paths.slice(0, split),
    newPath: paths.slice(split + delimiter.length),
  };
}

/** Parse the `@@ ... @@` blocks of one file's diff text. */
export function parseHunks(rawDiffText: string): Hunk[] {
  const lines = splitDiffLines(rawDiffText);
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      if (current) {
        hunks.push(current);
      }
      current = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }
    if (line.startsWith("diff --git ")) {
      break;
    }
    let hunkLine: HunkLine | null = null;
    if (line.startsWith("+")) {
      hunkLine = { type: "added", content: line.slice(1) };
    } else if (line.startsWith("-")) {
      hunkLine = { type: "deleted", content: line.slice(1) };
    } else if (line.startsWith(" ") || line === "") {
      hunkLine = { type: "context", content: line.slice(1) };
    }
    if (hunkLine) {
      current.lines.push(hunkLine);
    }
  }
  if (current) {
    hunks.push(current);
  }
  return hunks;
}

export interface ParseOptions {
  /**
   * Called for every non-deleted, non-binary file to fetch its new-side
   * content (from the working tree or `git show ref:path`). Async because the
   * ref path spawns git; failures must resolve to undefined, not throw — a
   * missing content fallback only weakens line resolution.
   */
  readNewFileContent?: (newPath: string) => Promise<string | undefined>;
}

/** Split full `git diff` output into per-file FileDiff structures. */
export async function parseDiffText(
  diffText: string,
  options: ParseOptions = {},
): Promise<FileDiff[]> {
  const lines = splitDiffLines(diffText);
  const diffs: FileDiff[] = [];
  let current: FileDiff | null = null;
  let buf: string[] = [];
  // Only hunk content lines carry a "+"/"-"/" " marker; outside a hunk,
  // "--- a/x" / "+++ b/x" are headers and "+++"-prefixed text is not an
  // insertion.
  let inHunk = false;

  const flush = async (): Promise<void> => {
    if (!current) {
      return;
    }
    current.diffText = buf.join("\n").replace(/\n$/, "");
    current.hunks = parseHunks(current.diffText);
    if (!current.isDeleted && !current.isBinary && current.newPath) {
      current.newFileContent = await options.readNewFileContent?.(
        current.newPath,
      );
    }
    diffs.push(current);
    buf = [];
  };

  for (const line of lines) {
    const header = parseDiffHeaderLine(line);
    if (header) {
      await flush();
      current = {
        oldPath: header.oldPath,
        newPath: header.newPath,
        diffText: "",
        hunks: [],
        isBinary: false,
        isDeleted: false,
        isNew: false,
        isRenamed: false,
        insertions: 0,
        deletions: 0,
      };
      inHunk = false;
    }
    if (!current) {
      continue;
    }

    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (!inHunk && line.startsWith("index ")) {
      // Object IDs/mode are not useful review context; drop the line.
      continue;
    } else if (!inHunk && line.startsWith("Binary files ")) {
      current.isBinary = true;
    } else if (line.startsWith("new file mode ")) {
      current.isNew = true;
    } else if (line.startsWith("deleted file mode ")) {
      current.isDeleted = true;
    } else if (line.startsWith("rename from ")) {
      // Authoritative old path for renames; more reliable than the header
      // when paths contain spaces.
      current.oldPath = unquoteGitPath(line.slice("rename from ".length));
      current.isRenamed = true;
    } else if (line.startsWith("rename to ")) {
      current.newPath = unquoteGitPath(line.slice("rename to ".length));
      current.isRenamed = true;
    } else if (!inHunk && line === "--- /dev/null") {
      current.isNew = true;
    } else if (!inHunk && line === "+++ /dev/null") {
      current.isDeleted = true;
    } else if (inHunk && line.startsWith("+")) {
      current.insertions++;
    } else if (inHunk && line.startsWith("-")) {
      current.deletions++;
    }
    buf.push(line);
  }
  await flush();

  for (const d of diffs) {
    if (d.isDeleted) {
      d.newPath = "/dev/null";
    }
  }
  return diffs;
}
