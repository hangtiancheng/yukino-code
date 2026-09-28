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

import { callOnce } from "./llm-call.js";
import {
  RELOCATION_SYSTEM,
  RELOCATION_USER,
  renderTemplate,
} from "./prompts.js";
import { resolveComment } from "./resolve.js";
import type { FileDiff, ReviewComment } from "./types.js";

import type { LLMClient } from "@/llm/client.js";

/**
 * LLM re-location, ported from OCR internal/diff/relocation.go. The last
 * positioning resort: when deterministic matching failed, an independent
 * call extracts the verbatim snippet the comment actually targets, then the
 * deterministic resolver runs again on the corrected snippet.
 */

/** Extract the first fenced code block from a response. */
export function extractCodeBlock(text: string): string {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(text);
  return (m ? (m[1] ?? "") : text).trim();
}

/**
 * Attempt LLM re-location for one unresolved comment. Mutates and returns
 * true when the corrected snippet resolves to line numbers.
 */
export async function relocateWithLlm(
  client: LLMClient,
  cm: ReviewComment,
  d: FileDiff,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const prompt = `${RELOCATION_SYSTEM}\n\n${renderTemplate(RELOCATION_USER, {
    diff: d.diffText,
    existing_code: cm.existingCode,
    comment: cm.content,
  })}`;
  let content: string;
  try {
    content = await callOnce(client, prompt, abortSignal);
  } catch (err) {
    if (abortSignal?.aborted) {
      throw err;
    }
    return false;
  }
  const corrected = extractCodeBlock(content);
  if (!corrected || corrected === cm.existingCode) {
    return false;
  }
  // OCR relocation.go restores the original snippet when the corrected one
  // fails to resolve: existing_code is the evidence the filter judges later,
  // and an unmatched rewrite would poison that judgment.
  const original = cm.existingCode;
  cm.existingCode = corrected;
  if (resolveComment(cm, d)) {
    cm.resolution = "llm";
    return true;
  }
  cm.existingCode = original;
  return false;
}
