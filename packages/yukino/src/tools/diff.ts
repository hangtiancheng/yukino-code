import { structuredPatch } from "diff";

import {
  CONTEXT_LINES,
  DIFF_TIMEOUT_MS,
  DIFF_BUDGET_EXCEEDED,
  MAX_DIFF_LINES,
} from "@/tools/constants.js";

export interface DiffResult {
  /** Removed lines use old-file numbers; additions and context use new-file numbers. */
  text: string;
  additions: number | null;
  removals: number | null;
}

export interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

export function buildEditDiff(
  content: string,
  replacements: TextReplacement[],
): DiffResult {
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    parts.push(content.slice(cursor, replacement.start), replacement.text);
    cursor = replacement.end;
  }
  parts.push(content.slice(cursor));
  return buildDiff(content, parts.join(""));
}

export function buildDiff(oldContent: string, newContent: string): DiffResult {
  const patch = structuredPatch(
    "",
    "",
    oldContent,
    newContent,
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  if (!patch) {
    return { text: DIFF_BUDGET_EXCEEDED, additions: null, removals: null };
  }
  const output: string[] = [];
  let additions = 0;
  let removals = 0;
  let truncated = false;
  const push = (line: string) => {
    if (output.length < MAX_DIFF_LINES) {
      output.push(line);
    } else {
      truncated = true;
    }
  };
  for (const [index, hunk] of patch.hunks.entries()) {
    if (index > 0) {
      push("  ...");
    }
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      if (prefix !== "-" && prefix !== "+" && prefix !== " ") {
        continue;
      }
      push(
        `${prefix} ${String(prefix === "-" ? oldLine : newLine).padStart(4)}  ${line.slice(1)}`,
      );
      if (prefix === "-") {
        removals++;
        oldLine++;
      } else if (prefix === "+") {
        additions++;
        newLine++;
      } else {
        oldLine++;
        newLine++;
      }
    }
  }
  if (truncated) {
    output.push(`  ... (diff truncated at ${String(MAX_DIFF_LINES)} lines)`);
  }
  return { text: output.join("\n"), additions, removals };
}
