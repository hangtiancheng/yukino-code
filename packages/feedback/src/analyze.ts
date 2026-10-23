import type { Message } from "@yukino.js/conversation";
import { z } from "zod";

import { MAX_ISSUES } from "./constants.js";
import {
  ANALYSIS_INSTRUCTIONS,
  buildAnalysisPrompt,
  buildAnalysisRetryPrompt,
} from "./prompts.js";
import {
  IssueDraftSchema,
  type FiledIssueRecord,
  type IssueDraft,
} from "./types.js";

const AnalysisSchema = z.object({
  issues: z.array(IssueDraftSchema).max(MAX_ISSUES),
});

export interface AnalyzeInput {
  runAgent: (prompt: string) => Promise<string>;
  messages: Message[];
  logContent: string | null;
  description: string;
  filedIssues: FiledIssueRecord[];
  contextWindow: number;
  maxOutputTokens?: number;
  abortSignal: AbortSignal;
}

function parseAnalysis(text: string): IssueDraft[] | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(stripped.slice(start, end + 1));
    const parsed = AnalysisSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.issues;
  } catch {
    return null;
  }
}

/** Single issue carrying the user's own words when analysis yields nothing. */
export function descriptionFallbackDraft(description: string): IssueDraft {
  const firstLine = description.trim().split("\n")[0] ?? "";
  const title =
    firstLine.length > 5 && firstLine.length <= 80
      ? firstLine
      : `${firstLine.slice(0, 77).trimEnd()}...`;
  return {
    title: `[feedback] ${title}`,
    body: [
      "## What happened",
      description.trim(),
      "",
      "_User-submitted feedback; no automatic analysis results are included._",
    ].join("\n"),
  };
}

/** Ask a foreground worker to identify yukino harness defects in this session. */
export async function analyzeHarnessAnomalies(
  input: AnalyzeInput,
): Promise<IssueDraft[]> {
  input.abortSignal.throwIfAborted();
  const prompt = `${ANALYSIS_INSTRUCTIONS}\n\n${buildAnalysisPrompt(input)}`;
  const first = await input.runAgent(prompt);
  input.abortSignal.throwIfAborted();
  const drafts = parseAnalysis(first);
  if (drafts) {
    return drafts;
  }

  const retry = await input.runAgent(
    `${prompt}\n\n${buildAnalysisRetryPrompt()}`,
  );
  input.abortSignal.throwIfAborted();
  const retried = parseAnalysis(retry);
  if (retried) {
    return retried;
  }
  throw new Error(
    "Feedback analysis did not return valid issue JSON after retry",
  );
}
