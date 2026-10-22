import { join, resolve, sep } from "node:path";

import type { ToolResultBlock } from "@/conversation/index.js";
import { createChildLogger } from "@/logger/index.js";
import { getSessionArtifactsDir } from "@/session/index.js";
import {
  writePrivateFileSync as writeFileSync,
  mkdirPrivateSync as mkdirSync,
  protectPrivateFileSync,
} from "@/storage/private.js";
import {
  MESSAGE_AGGREGATE_LIMIT,
  SPILL_DIR_NAME,
  SPILL_FILE_EXTENSION,
  TOOL_RESULT_PREVIEW_CHARS,
} from "@/tool-result/constants.js";
import { buildSpillPreview } from "@/tool-result/prompts.js";
import { isObject } from "@/utils/index.js";
import { resolveToolPath } from "@/utils/paths.js";

const log = createChildLogger({ module: "tool-result" });

export * as Constants from "@/tool-result/constants.js";
export * as Prompts from "@/tool-result/prompts.js";

export function spillDir(sessionId: string): string {
  if (!sessionId) {
    throw new Error("Tool-result spilling requires a session ID");
  }
  return join(getSessionArtifactsDir(sessionId), SPILL_DIR_NAME);
}

function resultPath(sessionId: string, toolUseId: string): string {
  // Provider call IDs are opaque data, never filesystem paths.
  return join(
    spillDir(sessionId),
    `${encodeURIComponent(toolUseId).replaceAll("*", "%2A")}${SPILL_FILE_EXTENSION}`,
  );
}

// Persist the full text of a tool result to disk. tool_use_id is unique per
// invocation and its content is deterministic, so when the file already
// exists we reuse it instead of writing again.
function writeSpill(
  sessionId: string,
  toolUseId: string,
  content: string,
): string {
  const dir = spillDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const path = resultPath(sessionId, toolUseId);
  try {
    writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
  } catch (err: unknown) {
    log.error({ err }, "tool-result operation failed");
    if (isObject(err) && "code" in err && err.code === "EEXIST") {
      protectPrivateFileSync(path);
      return path;
    }
    throw err;
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
 * Determine whether a tool call is reading back a file under the spill
 * directory. Such results are not spilled: writing the model's freshly-read
 * content back to disk and swapping it for a preview would mean the model
 * never sees the full text, and it would loop between "read back" and
 * "spill".
 */
export function isSpillReadback(
  toolName: string,
  args: Record<string, unknown> | undefined,
  cwd: string,
  sessionId: string,
): boolean {
  if (toolName !== "ReadFile" || !args) {
    return false;
  }
  const raw = args.file_path;
  if (typeof raw !== "string" || !raw) {
    return false;
  }
  if (!sessionId) {
    return false;
  }
  // Resolve against cwd like ReadFileTool does — under remote/teammate
  // process.cwd() differs — and match on a path-segment boundary so a
  // sibling directory like "<spillDir>-extra" never counts as the spill dir.
  const target = resolveToolPath(cwd, raw);
  const spill = resolve(spillDir(sessionId));
  return target === spill || target.startsWith(spill + sep);
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
      // A result no longer than the preview gains no space from spilling —
      // the wrapper text would only enlarge it
      continue;
    }
    // Measure the replacement under the real wrapper + path overhead before
    // touching disk. Spilling only pays off when the preview is strictly
    // smaller than the original; otherwise the swap enlarges the message and
    // pushes total further past the limit.
    let spillPath: string;
    try {
      spillPath = resultPath(sessionId, r.toolUseId);
    } catch {
      // No session id means there is nowhere to spill.
      continue;
    }
    const replacement = buildSpillPreview(content, spillPath);
    if (replacement.length >= content.length) {
      continue;
    }
    try {
      writeSpill(sessionId, r.toolUseId, content);
    } catch {
      // On write failure, keep the original text. The message is finalized
      // into history right after, so there will be no retry
      continue;
    }
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
  sessionId: string,
  toolUseId: string,
  content: string,
): string {
  let path: string;
  try {
    path = writeSpill(sessionId, toolUseId, content);
  } catch {
    return content;
  }
  return buildSpillPreview(content, path);
}
