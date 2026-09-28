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

import { safeParse, z } from "zod";

import { callOnce } from "./llm-call.js";
import {
  GROUPING_SYSTEM,
  GROUPING_USER,
  renderTemplate,
  stripMarkdownFences,
} from "./prompts.js";
import { estimateTokens } from "./selection.js";
import type { FileDiff, FileGroup } from "./types.js";

import type { LLMClient } from "@/llm/client.js";
import { safeJSONParse } from "@/utils/index.js";

/**
 * Smart file bundling, ported from OCR internal/agent/grouping.go. Related
 * files are grouped into a single review unit; each group runs as a subagent
 * with isolated context — divide-and-conquer that stays stable on large
 * changesets and naturally supports concurrent review.
 */

/** Below this file count, grouping adds no value (OCR GROUPING_MIN_FILES). */
export const GROUPING_MIN_FILES = 4;
/** Hard cap per group (OCR maxFilesPerGroup). */
export const MAX_FILES_PER_GROUP = 10;
/**
 * Fallback combined diff token budget per group when the caller does not
 * derive one from the provider context window.
 */
export const GROUP_TOKEN_BUDGET = 60_000;

/** Render one changed file as `STATUS   path (+N/-M)`, the shared prompt shape. */
export function formatDiffEntry(d: FileDiff): string {
  const status = d.isNew
    ? "ADDED"
    : d.isDeleted
      ? "DELETED"
      : d.isRenamed
        ? "RENAMED"
        : "MODIFIED";
  const path = d.newPath !== "/dev/null" ? d.newPath : d.oldPath;
  return `${status}   ${path} (+${String(d.insertions)}/-${String(d.deletions)})`;
}

export function buildFileList(diffs: FileDiff[]): string {
  return diffs.map((d, i) => `[${String(i)}] ${formatDiffEntry(d)}`).join("\n");
}

const GroupingItemSchema = z.object({
  label: z.string().optional(),
  files: z.array(z.number().int()).optional(),
});
const GroupingResponseSchema = z.array(GroupingItemSchema);

/** Parse the grouping JSON; uncovered files get their own single-file group. */
export function parseGroupingResponse(
  content: string,
  diffs: FileDiff[],
  tokenBudget: number = GROUP_TOKEN_BUDGET,
): FileGroup[] {
  const stripped = stripMarkdownFences(content);
  const raw: unknown = safeJSONParse(stripped);
  const parsed = safeParse(GroupingResponseSchema, raw);
  if (!parsed.success) {
    // A parse failure (including a truncated response) falls back to
    // deterministic chunking in the caller.
    throw new Error("parse grouping JSON failed");
  }

  const seen = new Array<boolean>(diffs.length).fill(false);
  const groups: FileGroup[] = [];
  for (const g of parsed.data) {
    const gDiffs: FileDiff[] = [];
    for (const idx of g.files ?? []) {
      if (idx < 0 || idx >= diffs.length) {
        continue;
      }
      if (seen[idx]) {
        continue;
      }
      const d = diffs[idx];
      if (!d) {
        continue;
      }
      seen[idx] = true;
      gDiffs.push(d);
    }
    const first = gDiffs[0];
    if (first) {
      groups.push({ label: g.label?.trim() || first.newPath, diffs: gDiffs });
    }
  }
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    if (!seen[i] && d) {
      groups.push({ label: d.newPath, diffs: [d] });
    }
  }
  return enforceGroupLimits(groups, tokenBudget);
}

/** Split groups over the per-group file cap into smaller chunks. */
export function enforceMaxFilesPerGroup(groups: FileGroup[]): FileGroup[] {
  const result: FileGroup[] = [];
  for (const g of groups) {
    if (g.diffs.length <= MAX_FILES_PER_GROUP) {
      result.push(g);
      continue;
    }
    for (let i = 0; i < g.diffs.length; i += MAX_FILES_PER_GROUP) {
      result.push({
        label: g.label,
        diffs: g.diffs.slice(i, i + MAX_FILES_PER_GROUP),
      });
    }
  }
  return result;
}

/** Split groups whose combined diff tokens exceed the budget. */
export function enforceGroupTokenBudget(
  groups: FileGroup[],
  tokenLimit: number,
): FileGroup[] {
  if (tokenLimit <= 0) {
    return groups;
  }
  const result: FileGroup[] = [];
  for (const g of groups) {
    let current: FileDiff[] = [];
    let currentTokens = 0;
    for (const d of g.diffs) {
      const t = estimateTokens(d.diffText);
      if (current.length > 0 && currentTokens + t > tokenLimit) {
        result.push({ label: g.label, diffs: current });
        current = [];
        currentTokens = 0;
      }
      current.push(d);
      currentTokens += t;
    }
    if (current.length > 0) {
      result.push({ label: g.label, diffs: current });
    }
  }
  return result;
}

export function enforceGroupLimits(
  groups: FileGroup[],
  tokenBudget: number = GROUP_TOKEN_BUDGET,
): FileGroup[] {
  return enforceGroupTokenBudget(enforceMaxFilesPerGroup(groups), tokenBudget);
}

/** Deterministic fallback: chunk files in diff order. */
export function chunkGroups(
  diffs: FileDiff[],
  tokenBudget: number = GROUP_TOKEN_BUDGET,
): FileGroup[] {
  const groups: FileGroup[] = [];
  for (let i = 0; i < diffs.length; i += MAX_FILES_PER_GROUP) {
    const chunk = diffs.slice(i, i + MAX_FILES_PER_GROUP);
    const label =
      chunk.length === 1
        ? chunk[0].newPath
        : `${chunk[0].newPath} (+${String(chunk.length - 1)} more)`;
    groups.push({ label, diffs: chunk });
  }
  return enforceGroupLimits(groups, tokenBudget);
}

export interface GroupDiffsOptions {
  client: LLMClient;
  abortSignal?: AbortSignal;
  onFallback?: (reason: string) => void;
  /** Combined diff token budget per group (derived from the provider window). */
  tokenBudget?: number;
}

/**
 * Group files semantically via LLM, with a deterministic fallback so a
 * grouping failure degrades to chunked review instead of aborting the run.
 */
export async function groupDiffs(
  diffs: FileDiff[],
  options: GroupDiffsOptions,
): Promise<FileGroup[]> {
  if (diffs.length === 0) {
    return [];
  }
  if (diffs.length < GROUPING_MIN_FILES) {
    return [{ label: diffs[0].newPath, diffs }];
  }
  const prompt = `${GROUPING_SYSTEM}\n\n${renderTemplate(GROUPING_USER, {
    file_list: buildFileList(diffs),
  })}`;
  try {
    const content = await callOnce(options.client, prompt, options.abortSignal);
    return parseGroupingResponse(content, diffs, options.tokenBudget);
  } catch (err) {
    if (options.abortSignal?.aborted) {
      throw err;
    }
    options.onFallback?.(err instanceof Error ? err.message : String(err));
    return chunkGroups(diffs, options.tokenBudget);
  }
}
