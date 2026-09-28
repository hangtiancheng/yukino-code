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

import type { AgentEvent } from "@/agent/events.js";

/** How the review input is resolved from git. */
export type ReviewMode = "workspace" | "range" | "commit";

export type ReviewToolEvent = Extract<
  AgentEvent,
  { type: "tool_use" | "tool_result" }
>;

export type HunkLineType = "context" | "added" | "deleted";

export interface HunkLine {
  type: HunkLineType;
  /** Line content without the leading ' ' / '+' / '-' marker. */
  content: string;
}

/** One `@@ ... @@` block of a unified diff. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

/** A single changed file. */
export interface FileDiff {
  oldPath: string;
  newPath: string;
  /** Raw unified diff text for this file. */
  diffText: string;
  hunks: Hunk[];
  /** New-side file content, used as the fallback line-resolution source. */
  newFileContent?: string;
  isBinary: boolean;
  isDeleted: boolean;
  isNew: boolean;
  isRenamed: boolean;
  insertions: number;
  deletions: number;
}

export type CommentCategory =
  | "bug"
  | "security"
  | "performance"
  | "maintainability"
  | "test"
  | "style"
  | "documentation"
  | "other";

export type CommentSeverity = "critical" | "high" | "medium" | "low";

/** How a comment got its line numbers. */
export type ResolutionMethod =
  "hunk" | "file-content" | "cross-file" | "llm" | "unresolved";

/** A review finding. */
export interface ReviewComment {
  path: string;
  content: string;
  suggestionCode?: string;
  /** Verbatim code snippet the model used to anchor the comment. */
  existingCode: string;
  startLine: number;
  endLine: number;
  category: CommentCategory;
  severity: CommentSeverity;
  resolution: ResolutionMethod;
  /** Group label of the subagent that produced this comment. */
  groupLabel?: string;
}

/** A semantically related cluster of files reviewed by one subagent. */
export interface FileGroup {
  label: string;
  diffs: FileDiff[];
}

export type ExcludeReason =
  "none" | "binary" | "user-rule" | "deleted" | "too-large";

export interface FileDecision {
  diff: FileDiff;
  reason: ExcludeReason;
  diffTokens: number;
}

/** Progress notification surfaced to the UI while a review runs. */
export interface ReviewProgressEvent {
  phase:
    "diff" | "selection" | "grouping" | "plan" | "review" | "filter" | "done";
  message: string;
  /** 0..1 overall completion estimate, when known. */
  progress?: number;
}

export interface CodeReviewOptions {
  workDir: string;
  /** Free-form focus/background text from the code review form. */
  background?: string;
  from?: string;
  to?: string;
  commit?: string;
  /** User exclude globs; matching paths are skipped entirely. */
  excludePatterns?: string[];
  abortSignal?: AbortSignal;
  onProgress?: (event: ReviewProgressEvent) => void;
  onToolEvent?: (event: ReviewToolEvent) => void;
  /** Concurrent per-group subagents. Defaults to 3. */
  maxConcurrency?: number;
  /** Max review rounds per group. Defaults to 2. */
  maxRounds?: number;
  /** Skip the review-filter reflection step. */
  skipFilter?: boolean;
}

export interface CodeReviewResult {
  mode: ReviewMode;
  comments: ReviewComment[];
  /** Files that entered the reviewed set. */
  filesReviewed: number;
  filesChanged: number;
  groups: { label: string; files: string[] }[];
  excluded: { path: string; reason: ExcludeReason }[];
  filteredOut: number;
  aborted: boolean;
}
