import { formatDiffEntry } from "./grouping.js";
import {
  MAIN_USER,
  renderTemplate,
  stripEmptyConfirmedBlock,
  stripEmptyPlanBlock,
} from "./prompts.js";
import type { FileDiff, ReviewComment } from "./types.js";

/** Prompt assembly helpers. */

/** Escape text used inside a double-quoted XML attribute. */
function escapeXmlAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render group diffs as per-file XML elements. */
export function buildConcatenatedDiffs(diffs: FileDiff[]): string {
  return diffs
    .map((d) => {
      // Renames: the comment may cite either side of the rename, so both
      // paths must be discoverable on the element.
      const renameAttr =
        d.oldPath !== d.newPath
          ? ` old_path="${escapeXmlAttr(d.oldPath)}"`
          : "";
      return `<file path="${escapeXmlAttr(d.newPath)}"${renameAttr}>\n${d.diffText}\n</file>`;
    })
    .join("\n\n");
}

/**
 * The changed-files list excluding all group members — context about the
 * rest of the changeset without inviting comments on it.
 */
export function buildChangeFilesExceptGroup(
  allDiffs: FileDiff[],
  groupDiffs: FileDiff[],
): string {
  const exclude = new Set<string>();
  for (const d of groupDiffs) {
    exclude.add(d.newPath);
    exclude.add(d.oldPath);
  }
  const lines: string[] = [];
  for (const d of allDiffs) {
    if (d.isBinary || exclude.has(d.newPath) || exclude.has(d.oldPath)) {
      continue;
    }
    lines.push(formatDiffEntry(d));
  }
  return lines.join("\n");
}

const CONFIRMED_MAX_EXISTING_CODE = 200;
const CONFIRMED_MAX_CONTENT = 300;
/** Cap on confirmed findings: the round loop stops once this many accumulate. */
export const CONFIRMED_CAP = 30;

function flattenOneLine(s: string): string {
  return s.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ").trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Render confirmed findings from prior rounds into a compact block for the
 * next round's prompt. Returns "" for an empty list, which triggers
 * stripEmptyConfirmedBlock.
 */
export function buildConfirmedCommentsBlock(comments: ReviewComment[]): string {
  if (comments.length === 0) {
    return "";
  }
  const parts: string[] = [
    "The following issues were already identified and confirmed in a prior review pass. " +
      "Do not repeat them. " +
      "Continue reviewing all files in <review_files> and report any other real issues you find.",
    "",
    "<confirmed_findings>",
  ];
  comments.forEach((cm, i) => {
    parts.push(`${String(i + 1)}. ${cm.path}`);
    if (cm.existingCode) {
      parts.push(
        `   code: ${truncate(flattenOneLine(cm.existingCode), CONFIRMED_MAX_EXISTING_CODE)}`,
      );
    }
    parts.push(
      `   issue: ${truncate(flattenOneLine(cm.content), CONFIRMED_MAX_CONTENT)}`,
    );
  });
  parts.push("</confirmed_findings>");
  return parts.join("\n");
}

export interface MainTaskVars {
  changeFiles: string;
  diffs: string;
  currentDateTime: string;
  background: string;
  planGuidance: string;
  confirmedComments: string;
}

/**
 * Build the main-task user message. Empty optional sections are stripped
 * whole (header + placeholder) before substitution via stripEmptyPlanBlock /
 * stripEmptyConfirmedBlock.
 */
export function buildMainTaskMessage(vars: MainTaskVars): string {
  let content = MAIN_USER;
  if (!vars.planGuidance) {
    content = stripEmptyPlanBlock(content);
  }
  if (!vars.confirmedComments) {
    content = stripEmptyConfirmedBlock(content);
  }
  return renderTemplate(content, {
    change_files: vars.changeFiles,
    diffs: vars.diffs,
    current_system_date_time: vars.currentDateTime,
    requirement_background: vars.background,
    plan_guidance: vars.planGuidance,
    confirmed_comments: vars.confirmedComments,
  });
}
