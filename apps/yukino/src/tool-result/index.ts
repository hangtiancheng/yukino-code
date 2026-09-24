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

import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ToolResultBlock } from "@/conversation/index.js";
import { createChildLogger } from "@/logger/index.js";
import { isObject } from "@/utils/index.js";

// Aggregate cap across all tool results within a single message. The size of
// an individual result is gated by MAX_OUTPUT_CHARS in the agent; what we
// manage here is the aggregate. When a turn fans out to several tools in
// parallel, each result can stay under the per-result threshold while their
// sum still blows up the context — a case the per-result threshold cannot
// catch.
const log = createChildLogger({ module: "tool-result" });
const MESSAGE_AGGREGATE_LIMIT = 200000;
export const TOOL_RESULT_PREVIEW_CHARS = 2000;

export function spillDir(workDir: string, sessionId: string): string {
  const id = sessionId || "default";
  return join(workDir, ".yukino", "sessions", id, "tool-results");
}

// Persist the full text of a tool result to disk. tool_use_id is unique per
// invocation and its content is deterministic, so when the file already
// exists we reuse it instead of writing again.
function writeSpill(
  workDir: string,
  sessionId: string,
  toolUseId: string,
  content: string,
): string {
  const dir = spillDir(workDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, toolUseId + ".txt");
  try {
    writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
  } catch (err: unknown) {
    log.error({ err }, "tool-result operation failed");
    if (isObject(err) && "code" in err && err.code !== "EEXIST") {
      throw err;
    }
  }
  return path;
}

export function toDisplayPreview(content: string): string {
  if (content.length <= TOOL_RESULT_PREVIEW_CHARS) {
    return content;
  }
  return (
    content.slice(0, TOOL_RESULT_PREVIEW_CHARS) +
    `\n… ${String(content.length - TOOL_RESULT_PREVIEW_CHARS)} chars omitted from transcript`
  );
}

export function replaceToolResultContent(
  result: ToolResultBlock,
  content: string,
): void {
  result.content = content;
  if (result.contentBlocks?.length) {
    result.contentBlocks = [
      { type: "text", text: content },
      ...result.contentBlocks.filter((block) => block.type !== "text"),
    ];
  }
}

/**
 * The `<persisted-output>` wrapper text. buildSpillPreview derives the inputs
 * from an in-memory string; tool-level producers (e.g. a backgrounded Bash
 * command's live output file) build the same wrapper from a stat + partial
 * read without ever loading the full content into JS.
 */
export function buildPersistedOutputPreview(
  totalChars: number,
  preview: string,
  spillPath: string,
): string {
  const sizeKB = Math.floor(totalChars / 1024);
  let msg = `<persisted-output>\n`;
  msg += `Output too large (${String(sizeKB)}KB). Full content saved to:\n${spillPath}\n\n`;
  msg += `Preview (first 2KB):\n${preview}`;
  if (totalChars > TOOL_RESULT_PREVIEW_CHARS) {
    msg += "\n...";
  }
  msg += "\n</persisted-output>";
  return msg;
}

// Build the on-disk replacement text, including a 2000-char preview. Identical
// input yields a byte-for-byte identical string; once the replacement enters
// the conversation history it is never modified again.
function buildSpillPreview(content: string, spillPath: string): string {
  return buildPersistedOutputPreview(
    content.length,
    content.slice(0, TOOL_RESULT_PREVIEW_CHARS),
    spillPath,
  );
}

/**
 * Determine whether a tool call is reading back a file under the spill
 * directory. Such results are not spilled: writing the model's freshly-read
 * content back to disk and swapping it for a preview would mean the model
 * never sees the full text, and it would loop between "read back" and
 * "spill".
 */
export function isSpillReadback(
  toolName: string,
  args: Record<string, unknown> | undefined,
  workDir: string,
  sessionId: string,
): boolean {
  if (toolName !== "ReadFile" || !args) {
    return false;
  }
  const raw = args.file_path;
  if (typeof raw !== "string" || !raw) {
    return false;
  }
  return resolve(raw).startsWith(resolve(spillDir(workDir, sessionId)));
}
/**
 * applyBudget runs the aggregate budget before a turn's tool results enter
 * the conversation history: when the total character count of the batch
 * exceeds MESSAGE_AGGREGATE_LIMIT, it spills results to disk one by one
 * starting from the largest, replacing each in place with a preview, until
 * the total is back within the limit. Processing finishes before the message
 * enters history, so historical content is never modified afterwards and the
 * Prompt Cache prefix stays naturally stable.
 *
 * tool_use_ids in exemptIds do not participate in spilling: read-back results
 * of spilled files (re-spilling would mean the model never sees the full
 * text), and results already spilled individually this turn. When everything
 * is exempt, the overage is accepted.
 */
export function applyBudget(
  toolResults: ToolResultBlock[],
  workDir: string,
  sessionId: string,
  exemptIds?: Set<string>,
): void {
  let total = toolResults.reduce(
    (sum, result) => sum + result.content.length,
    0,
  );
  if (total <= MESSAGE_AGGREGATE_LIMIT) {
    return;
  }

  // Select in descending order of content length: spilling the largest first
  // minimizes the number of entries we need to touch to get back under the limit.
  const sorted = toolResults.toSorted(
    (a, b) => b.content.length - a.content.length,
  );
  for (const r of sorted) {
    if (total <= MESSAGE_AGGREGATE_LIMIT) {
      break;
    }
    if (exemptIds?.has(r.toolUseId)) {
      continue;
    }
    const content = r.content;
    if (content.length <= TOOL_RESULT_PREVIEW_CHARS) {
      // A result shorter than the preview gains no space from spilling
      continue;
    }
    let spillPath: string;
    try {
      spillPath = writeSpill(workDir, sessionId, r.toolUseId, content);
    } catch {
      // On write failure, keep the original text. The message is finalized
      // into history right after, so there will be no retry
      continue;
    }
    const replacement = buildSpillPreview(content, spillPath);
    total -= content.length - replacement.length;
    replaceToolResultContent(r, replacement);
  }
}

/**
 * Spill an oversized tool output to disk and return the preview text. On
 * write failure the content is returned unchanged. Called from agent/index.ts
 * when tool results enter the conversation history, in place of direct
 * truncation.
 */
export function persistLargeResult(
  workDir: string,
  sessionId: string,
  toolUseId: string,
  content: string,
): string {
  let path: string;
  try {
    path = writeSpill(workDir, sessionId, toolUseId, content);
  } catch {
    return content;
  }
  return buildSpillPreview(content, path);
}
