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

import { buildConcatenatedDiffs } from "./format.js";
import { callOnce } from "./llm-call.js";
import {
  FILTER_SYSTEM,
  FILTER_USER,
  renderTemplate,
  stripMarkdownFences,
} from "./prompts.js";
import type { FileDiff, ReviewComment } from "./types.js";

import type { LLMClient } from "@/llm/client.js";
import { safeJSONParse } from "@/utils/index.js";

/**
 * The external reflection module. An
 * independent fact-checker pass over freshly produced comments: it may only
 * remove comments the diff *proves* wrong (Ground A / Ground B), with
 * protected-subject and value vetoes. Its default answer is approve.
 *
 * The decision contract is expressed as strict JSON, with the analysis field
 * ordered before remove_ids so the model reasons before it commits (the
 * field order is load-bearing).
 */

export function buildFilterCommentsJSON(comments: ReviewComment[]): string {
  return JSON.stringify(
    comments.map((cm, i) => ({
      id: `c-${String(i)}`,
      path: cm.path,
      content: cm.content,
      ...(cm.existingCode ? { existing_code: cm.existingCode } : {}),
    })),
  );
}

const FilterResponseSchema = z.object({
  analysis: z.array(z.string()).optional(),
  remove_ids: z.array(z.string()).optional(),
});

/**
 * Parse the filter response into the set of candidate indices to remove.
 * Any parse failure means "approve all" — a filter that cannot be understood
 * must never silently destroy findings.
 */
export function parseFilterResponse(
  content: string,
  total: number,
): Set<number> {
  const removed = new Set<number>();
  const raw: unknown = safeJSONParse(stripMarkdownFences(content));
  const parsed = safeParse(FilterResponseSchema, raw);
  if (!parsed.success) {
    return removed;
  }
  for (const id of parsed.data.remove_ids ?? []) {
    const m = /^c-(\d+)$/.exec(id);
    if (!m?.[1]) {
      continue;
    }
    const idx = Number.parseInt(m[1], 10);
    if (idx >= 0 && idx < total) {
      removed.add(idx);
    }
  }
  return removed;
}

export interface FilterOptions {
  client: LLMClient;
  abortSignal?: AbortSignal;
}

/**
 * Run the filter over one group's candidate comments. Returns the indices
 * (into the candidates array) that must be removed. Never throws: a failed
 * filter call approves everything.
 */
export async function filterComments(
  groupDiffs: FileDiff[],
  candidates: ReviewComment[],
  options: FilterOptions,
): Promise<Set<number>> {
  if (candidates.length === 0) {
    return new Set<number>();
  }
  const prompt = `${FILTER_SYSTEM}\n\n${renderTemplate(FILTER_USER, {
    diff: buildConcatenatedDiffs(groupDiffs),
    comments: buildFilterCommentsJSON(candidates),
  })}`;
  try {
    const content = await callOnce(options.client, prompt, options.abortSignal);
    return parseFilterResponse(content, candidates.length);
  } catch (err) {
    if (options.abortSignal?.aborted) {
      throw err;
    }
    return new Set<number>();
  }
}
