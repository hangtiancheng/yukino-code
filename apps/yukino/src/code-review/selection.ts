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

import { minimatch } from "minimatch";

import type { ExcludeReason, FileDecision, FileDiff } from "./types.js";

/**
 * Deterministic file selection. Static
 * credential/noise/extension gates are intentionally not ported: the review
 * input is the developer's own working tree, and anything the user stages or
 * commits is fair game. The gates that remain are the ones correctness
 * depends on: binary detection, explicit user excludes, the deletion rule,
 * and the per-file size ceiling.
 */

/**
 * Rough token estimate. chars/4 is the standard
 * order-of-magnitude approximation and only feeds size gates and estimates,
 * never billing.
 * TODO: How about CJK?
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Fallback per-file diff size ceiling when the caller does not derive one
 * from the provider context window.
 */
export const FILE_TOKEN_LIMIT = 160_000;

/**
 * Fraction of the context window a single review prompt may occupy.
 * Feeds both the per-file gate and the group token budget.
 */
export const PROMPT_TOKEN_RATIO = 0.8;

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

const MATCH_OPTS = { dot: true, nocase: false };

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(path, p, MATCH_OPTS));
}

function whyExcluded(d: FileDiff, options: SelectionOptions): ExcludeReason {
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
 * The one deterministic pre-dispatch selection: user
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
  /** Decisions that enter the reviewed set. */
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
