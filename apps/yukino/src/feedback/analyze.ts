import { z } from "zod";

import { ConversationManager, type Message } from "@/conversation/index.js";
import { ANSWER_RESERVE_TOKENS, MAX_ISSUES } from "@/feedback/constants.js";
import {
  analysisOutputTokens,
  buildAnalysisPrompt,
} from "@/feedback/prompts.js";
import type { FiledIssueRecord, IssueDraft } from "@/feedback/types.js";
import type { LLMClient } from "@/llm/client.js";

const AnalysisSchema = z.object({
  issues: z
    .array(z.object({ title: z.string().min(1), body: z.string() }))
    .max(MAX_ISSUES),
});

export interface AnalyzeInput {
  client: LLMClient;
  messages: Message[];
  logContent: string | null;
  description: string;
  filedIssues: FiledIssueRecord[];
  contextWindow: number;
  maxOutputTokens?: number;
  abortSignal: AbortSignal;
}

async function collectAnalysisText(
  client: LLMClient,
  conv: ConversationManager,
  abortSignal: AbortSignal,
  outputTokens: number,
): Promise<{ text: string; truncated: boolean }> {
  let text = "";
  let completed = false;
  let truncated = false;
  for await (const event of client.stream(conv, [], abortSignal, {
    maxOutputTokens: outputTokens,
    answerReserveTokens: ANSWER_RESERVE_TOKENS,
  })) {
    abortSignal.throwIfAborted();
    if (event.type === "tool_call_start") {
      throw new Error("Feedback analysis attempted a tool call");
    }
    if (event.type === "text_delta") {
      text += event.text;
    }
    if (event.type === "stream_end") {
      completed = true;
      if (event.stopReason === "max_tokens") {
        // The answer was cut off; salvage what arrived and let the caller retry.
        truncated = true;
      } else if (
        event.stopReason !== "end_turn" &&
        event.stopReason !== "stop"
      ) {
        throw new Error(
          `Feedback analysis did not finish: ${event.stopReason}`,
        );
      }
    }
  }
  abortSignal.throwIfAborted();
  if (!completed) {
    throw new Error("Feedback analysis stream ended before completion");
  }
  return { text, truncated };
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
    return parsed.data.issues.map((issue) => ({
      title: issue.title.trim().slice(0, 120),
      body: issue.body,
    }));
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

/** Ask the session model to identify yukino harness defects in this session. */
export async function analyzeHarnessAnomalies(
  input: AnalyzeInput,
): Promise<IssueDraft[]> {
  const outputTokens = analysisOutputTokens(input);
  const conv = new ConversationManager();
  conv.addUserMessage(buildAnalysisPrompt(input));
  const first = await collectAnalysisText(
    input.client,
    conv,
    input.abortSignal,
    outputTokens,
  );
  const drafts = parseAnalysis(first.text);
  if (drafts) {
    return drafts;
  }

  // The stream does not append the assistant reply to conv, so quote the bad
  // response in the retry nudge.
  conv.addUserMessage(
    first.truncated
      ? [
          "Your previous reply hit the output token limit and was cut off before it finished.",
          "Respond again far more concisely: at most 3 issues, each body under 600 characters, omit unknown sections.",
          'Respond with ONLY the JSON object {"issues":[{"title":"...","body":"..."}]}, no prose, no code fences.',
        ].join("\n")
      : [
          "Your previous reply was not valid JSON:",
          first.text.slice(0, 2000),
          "",
          'Respond with ONLY the JSON object {"issues":[{"title":"...","body":"..."}]}, no prose, no code fences.',
        ].join("\n"),
  );
  const retry = await collectAnalysisText(
    input.client,
    conv,
    input.abortSignal,
    outputTokens,
  );
  const retried = parseAnalysis(retry.text);
  if (retried) {
    return retried;
  }
  if (input.description.trim()) {
    return [descriptionFallbackDraft(input.description)];
  }
  throw new Error(
    retry.truncated
      ? "Feedback analysis did not finish: max_tokens after retry"
      : "Feedback analysis did not return valid issue JSON after retry",
  );
}
