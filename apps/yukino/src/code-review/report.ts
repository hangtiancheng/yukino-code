import type { CodeReviewResult, ReviewComment } from "./types.js";

/** Terminal report rendering for a finished review. */

const SEVERITY_ICON: Record<string, string> = {
  critical: "[P0]",
  high: "[P1]",
  medium: "[P2]",
  low: "[P3]",
};

function formatComment(cm: ReviewComment): string {
  const icon = SEVERITY_ICON[cm.severity] ?? "⚪";
  const location =
    cm.startLine > 0
      ? cm.endLine > cm.startLine
        ? `${cm.path}:${String(cm.startLine)}-${String(cm.endLine)}`
        : `${cm.path}:${String(cm.startLine)}`
      : `${cm.path} (line unresolved)`;
  const parts = [
    `${icon} **[${cm.severity}] ${cm.category}** — ${location}`,
    `   ${cm.content}`,
  ];
  if (cm.suggestionCode) {
    parts.push("   Suggestion:");
    parts.push(
      cm.suggestionCode
        .split("\n")
        .map((l) => `     ${l}`)
        .join("\n"),
    );
  }
  return parts.join("\n");
}

export function formatReviewReport(result: CodeReviewResult): string {
  const lines: string[] = [];
  const modeDesc =
    result.mode === "workspace"
      ? "workspace changes"
      : result.mode === "commit"
        ? "commit"
        : "branch range";

  lines.push(
    `## Code Review — ${modeDesc}`,
    "",
    `Files: ${String(result.filesChanged)} changed, ${String(result.filesReviewed)} reviewed in ${String(result.groups.length)} group(s)` +
      (result.excluded.length > 0
        ? `, ${String(result.excluded.length)} excluded`
        : "") +
      (result.filteredOut > 0
        ? `, ${String(result.filteredOut)} filtered by fact-check`
        : "") +
      (result.aborted ? " — **aborted early**" : ""),
    "",
  );

  if (result.comments.length === 0) {
    lines.push(
      result.aborted
        ? "No findings before the run was aborted."
        : "✅ No issues found.",
    );
    return lines.join("\n");
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const cm of result.comments) {
    counts[cm.severity] = (counts[cm.severity] ?? 0) + 1;
  }
  lines.push(
    `Findings: ${String(result.comments.length)} total — ` +
      `critical ${String(counts.critical)}, high ${String(counts.high)}, ` +
      `medium ${String(counts.medium)}, low ${String(counts.low)}`,
    "",
  );

  let currentPath = "";
  for (const cm of result.comments) {
    if (cm.path !== currentPath) {
      currentPath = cm.path;
      lines.push(`### ${currentPath}`);
    }
    lines.push(formatComment(cm));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
