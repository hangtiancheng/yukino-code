import type { FileDiff, Hunk, ReviewComment } from "./types.js";

/**
 * Comment positioning. The external positioning module: deterministic
 * matching first, cross-file search second, LLM re-location last (see
 * runner).
 */

interface IndexedLine {
  lineNum: number;
  content: string;
}

/** Trim whitespace and strip a leading '+'/'-' diff marker. */
export function normalizeLine(s: string): string {
  let out = s.trim();
  if (out.startsWith("+") || out.startsWith("-")) {
    out = out.slice(1);
  }
  return out.trim();
}

/** Split code into normalized non-empty lines. */
export function splitAndNormalize(code: string): string[] {
  return code
    .split("\n")
    .map(normalizeLine)
    .filter((l) => l.length > 0);
}

/**
 * Extract one side of a hunk. newSide=true → context+added lines with
 * new-file line numbers; false → context+deleted with old-file numbers.
 */
export function extractSideLines(hunk: Hunk, newSide: boolean): IndexedLine[] {
  const result: IndexedLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const l of hunk.lines) {
    switch (l.type) {
      case "context":
        result.push({
          lineNum: newSide ? newLine : oldLine,
          content: normalizeLine(l.content),
        });
        oldLine++;
        newLine++;
        break;
      case "added":
        if (newSide) {
          result.push({ lineNum: newLine, content: normalizeLine(l.content) });
        }
        newLine++;
        break;
      case "deleted":
        if (!newSide) {
          result.push({ lineNum: oldLine, content: normalizeLine(l.content) });
        }
        oldLine++;
        break;
    }
  }
  return result;
}

/** Scan sideLines for a consecutive run matching all targetLines. */
export function matchConsecutive(
  sideLines: IndexedLine[],
  targetLines: string[],
): { startLine: number; endLine: number } | null {
  if (targetLines.length === 0 || sideLines.length < targetLines.length) {
    return null;
  }
  for (let i = 0; i <= sideLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (sideLines[i + j].content !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return {
        startLine: sideLines[i].lineNum,
        endLine: sideLines[i + targetLines.length - 1].lineNum,
      };
    }
  }
  return null;
}

/** Match existing_code against hunk lines: new side first, then old side. */
export function resolveFromHunk(d: FileDiff, cm: ReviewComment): boolean {
  if (d.hunks.length === 0) {
    return false;
  }
  const targetLines = splitAndNormalize(cm.existingCode);
  if (targetLines.length === 0) {
    return false;
  }
  for (const hunk of d.hunks) {
    const hit = matchConsecutive(extractSideLines(hunk, true), targetLines);
    if (hit) {
      cm.startLine = hit.startLine;
      cm.endLine = hit.endLine;
      cm.resolution = "hunk";
      return true;
    }
  }
  for (const hunk of d.hunks) {
    const hit = matchConsecutive(extractSideLines(hunk, false), targetLines);
    if (hit) {
      cm.startLine = hit.startLine;
      cm.endLine = hit.endLine;
      cm.resolution = "hunk";
      return true;
    }
  }
  return false;
}

/**
 * Scan the new file content for consecutive matches. "Consecutive" means
 * adjacent non-blank lines, so blank lines in the source do not break the
 * sliding-window match.
 */
export function resolveFromFileContent(
  d: FileDiff,
  cm: ReviewComment,
): boolean {
  if (!d.newFileContent) {
    return false;
  }
  const targetLines = splitAndNormalize(cm.existingCode);
  if (targetLines.length === 0) {
    return false;
  }
  const normalized: string[] = [];
  const lineNums: number[] = [];
  const fileLines = d.newFileContent.split("\n");
  for (let i = 0; i < fileLines.length; i++) {
    const n = normalizeLine((fileLines[i] ?? "").replace(/\r$/, ""));
    if (n === "") {
      continue;
    }
    normalized.push(n);
    lineNums.push(i + 1);
  }
  const hit = matchConsecutive(
    normalized.map((content, i) => ({ content, lineNum: lineNums[i] })),
    targetLines,
  );
  if (!hit) {
    return false;
  }
  cm.startLine = hit.startLine;
  cm.endLine = hit.endLine;
  cm.resolution = "file-content";
  return true;
}

/**
 * Resolve start/end line for one comment: hunks first, full-file content
 * second. Returns true when the comment is located.
 */
export function resolveComment(cm: ReviewComment, d: FileDiff): boolean {
  if (cm.startLine > 0 || cm.endLine > 0) {
    return true;
  }
  if (!cm.existingCode) {
    return false;
  }
  if (resolveFromHunk(d, cm)) {
    return true;
  }
  return resolveFromFileContent(d, cm);
}

/**
 * Re-file a comment whose existing_code belongs to a different file than the
 * one it was filed against. ExistingCode is a verbatim excerpt, so finding
 * its true home is plain string matching over the diffs already in memory.
 * Zero hits and multiple hits both decline: the same boilerplate can
 * legitimately appear in several files, and guessing between them would
 * trade one wrong location for another.
 */
export function relocateAcrossFiles(
  cm: ReviewComment,
  diffs: FileDiff[],
): string | null {
  if (!cm.existingCode || diffs.length === 0) {
    return null;
  }
  const hits: { path: string; startLine: number; endLine: number }[] = [];
  for (const d of diffs) {
    if (d.isBinary || d.isDeleted) {
      // Deleted code is reference-only (the review prompt says to avoid
      // commenting on it), and re-filing there would produce a "/dev/null" path.
      continue;
    }
    if (d.newPath === cm.path || d.oldPath === cm.path) {
      continue;
    }
    // Probe on a copy so a failed candidate cannot leave line numbers behind.
    const probe: ReviewComment = { ...cm, startLine: 0, endLine: 0 };
    if (!resolveComment(probe, d)) {
      continue;
    }
    hits.push({
      path: d.newPath || d.oldPath,
      startLine: probe.startLine,
      endLine: probe.endLine,
    });
    if (hits.length > 1) {
      return null;
    }
  }
  if (hits.length !== 1) {
    return null;
  }
  const hit = hits[0];
  cm.path = hit.path;
  cm.startLine = hit.startLine;
  cm.endLine = hit.endLine;
  cm.resolution = "cross-file";
  return hit.path;
}
