import { minimatch } from "minimatch";

import { FILE_TOKEN_LIMIT, MATCH_OPTS } from "@/review/constants.js";
import type { ExcludeReason, FileDecision, FileDiff } from "@/review/types.js";

/**
 * Deterministic file selection. Static credential/noise/extension gates are
 * intentionally not ported: the review input comes from the developer's own
 * repository — anything the user writes, stages, or commits is fair game.
 * The gates that remain are the ones correctness depends on: binary
 * detection, explicit user excludes, the deletion rule, and the per-file
 * size ceiling.
 */

/**
 * Rough token estimate. chars/4 is the standard
 * order-of-magnitude approximation and only feeds size gates and estimates,
 * never billing. CJK text packs more tokens per character, so chars/4
 * under-counts it.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SelectionOptions {
  /** User exclude globs from the code review form. */
  excludePatterns?: string[];
  fileTokenLimit?: number;
}

/** The path a decision is judged on: new side, falling back to old. */
export function effectivePath(d: FileDiff): string {
  if (d.newPath && d.newPath !== "/dev/null") {
    return d.newPath;
  }
  return d.oldPath;
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(path, p, MATCH_OPTS));
}

function whyExcluded(d: FileDiff, options: SelectionOptions): ExcludeReason {
  if (d.tooLarge) {
    return "too-large";
  }
  if (d.isBinary) {
    return "binary";
  }
  if (
    options.excludePatterns?.length &&
    matchesAny(effectivePath(d), options.excludePatterns)
  ) {
    return "user-rule";
  }
  return "none";
}

/**
 * The one deterministic pre-dispatch selection: binary detection, user
 * excludes, the deletion rule, and the per-file diff-size ceiling. Pure —
 * no git, no LLM.
 */
export function selectFiles(
  diffs: FileDiff[],
  options: SelectionOptions = {},
): FileDecision[] {
  const limit = options.fileTokenLimit ?? FILE_TOKEN_LIMIT;
  return diffs.map((diff) => {
    const decision: FileDecision = {
      diff,
      reason: whyExcluded(diff, options),
      diffTokens: 0,
    };
    if (decision.reason !== "none") {
      return decision;
    }
    if (diff.isDeleted) {
      // Deletions are retained for prompt context but never reviewed.
      decision.reason = "deleted";
      return decision;
    }
    if (limit > 0) {
      decision.diffTokens = estimateTokens(diff.diffText);
      if (decision.diffTokens > limit) {
        decision.reason = "too-large";
      }
    }
    return decision;
  });
}

export interface SelectionSummary {
  /** Diffs that enter the reviewed set. */
  selected: FileDiff[];
  /** Selected plus deletions — the working set the prompts show. */
  retained: FileDiff[];
  selectedCount: number;
  tooLargeCount: number;
  excluded: { path: string; reason: ExcludeReason }[];
}

export function summarizeSelection(
  decisions: FileDecision[],
): SelectionSummary {
  const selected: FileDiff[] = [];
  const retained: FileDiff[] = [];
  const excluded: { path: string; reason: ExcludeReason }[] = [];
  let tooLargeCount = 0;
  for (const dec of decisions) {
    if (dec.reason === "none" || dec.reason === "deleted") {
      retained.push(dec.diff);
    }
    if (dec.reason === "none") {
      selected.push(dec.diff);
    } else {
      if (dec.reason === "too-large") {
        tooLargeCount++;
      }
      excluded.push({ path: effectivePath(dec.diff), reason: dec.reason });
    }
  }
  return {
    selected,
    retained,
    selectedCount: selected.length,
    tooLargeCount,
    excluded,
  };
}
