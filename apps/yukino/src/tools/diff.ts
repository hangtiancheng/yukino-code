const CONTEXT_LINES = 3;
// Prevent excessively large diffs from overwhelming UI rendering and context window usage
const MAX_DIFF_LINES = 200;

export interface DiffResult {
  /**
   * Line-numbered diff with unified-style prefixes: " " for unchanged context,
   * "-" for removals, "+" for additions. Each line is prefix, space, 1-based
   * line number right-aligned in 4 columns, two spaces, then the content.
   * Removed lines carry old-file numbers; added lines and context lines carry
   * new-file numbers — the model locates follow-up edits in the NEW file, so
   * context numbered off the old file would be off by (additions − removals)
   * whenever the edit changes the line count. A trailing notice marks
   * truncation at MAX_DIFF_LINES.
   */
  text: string;
  additions: number;
  removals: number;
}

/**
 * Compares file content before and after editing, generating a line-numbered diff.
 * Leverages the property that edits typically modify only a small middle section
 * by finding common prefix and suffix lines from both ends, avoiding the overhead
 * of general LCS/Myers diff algorithms (faster for large files and simpler to implement).
 */
export function buildDiff(oldContent: string, newContent: string): DiffResult {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let prefixLen = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefixLen < maxPrefix && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const maxSuffix = maxPrefix - prefixLen;
  while (
    suffixLen < maxSuffix &&
    oldLines[oldLines.length - 1 - suffixLen] ===
      newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const removedLines = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const addedLines = newLines.slice(prefixLen, newLines.length - suffixLen);

  const contextStart = Math.max(0, prefixLen - CONTEXT_LINES);
  const contextBefore = oldLines.slice(contextStart, prefixLen);
  const contextEnd = Math.min(
    oldLines.length,
    oldLines.length - suffixLen + CONTEXT_LINES,
  );
  const contextAfter = oldLines.slice(oldLines.length - suffixLen, contextEnd);

  const out: string[] = [];
  let oldLineNo = contextStart + 1;
  let newLineNo = contextStart + 1;
  let truncated = false;

  const push = (prefix: string, lineNo: number, content: string) => {
    if (out.length >= MAX_DIFF_LINES) {
      truncated = true;
      return;
    }
    out.push(`${prefix} ${String(lineNo).padStart(4)}  ${content}`);
  };

  for (const l of contextBefore) {
    push(" ", oldLineNo, l);
    oldLineNo++;
    newLineNo++;
  }
  for (const l of removedLines) {
    push("-", oldLineNo, l);
    oldLineNo++;
  }
  for (const l of addedLines) {
    push("+", newLineNo, l);
    newLineNo++;
  }
  for (const l of contextAfter) {
    // Trailing context exists in both files; number it by its new-file
    // position (newLineNo already accounts for the edit's size change) so
    // the model can locate these lines in the current file.
    push(" ", newLineNo, l);
    newLineNo++;
    oldLineNo++;
  }

  if (truncated) {
    out.push(`  ... (diff truncated at ${String(MAX_DIFF_LINES)} lines)`);
  }

  return {
    text: out.join("\n"),
    additions: addedLines.length,
    removals: removedLines.length,
  };
}
