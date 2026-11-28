import { randomUUID } from "node:crypto";

import { ConversationManager } from "@/conversation/index.js";
import { withExecutionContext } from "@/cost/context.js";
import type { ExecutionLedger } from "@/cost/ledger.js";
import type { LLMClient } from "@/llm/client.js";
import {
  BRANCH_SUMMARY_EMPTY,
  BRANCH_SUMMARY_INCOMPLETE,
  BRANCH_SUMMARY_MAX_DESCRIPTION_CHARS,
  BRANCH_SUMMARY_MAX_ENTRIES,
  BRANCH_SUMMARY_MAX_ENTRY_CHARS,
  BRANCH_SUMMARY_MAX_INPUT_CHARS,
  BRANCH_SUMMARY_MAX_OUTPUT_CHARS,
  BRANCH_SUMMARY_MAX_OUTPUT_TOKENS,
  BRANCH_SUMMARY_MAX_STREAM_CHARS,
  BRANCH_SUMMARY_TIMEOUT_MS,
  BRANCH_SUMMARY_TOO_LARGE,
  BRANCH_SUMMARY_TOOLS,
  UNSAFE_TOOL_BOUNDARY,
} from "@/session/constants.js";
import {
  collectFileOperations,
  type FileOperations,
} from "@/session/file-operations.js";
import type { SessionManager } from "@/session/manager.js";
import {
  BRANCH_SUMMARY_SYSTEM_PROMPT,
  buildBranchSummaryPrompt,
} from "@/session/prompts.js";
import {
  BranchSummaryPayloadSchema,
  type BranchSummaryPayload,
  type SessionEntry,
} from "@/session/records.js";
import { cancelOnSignal } from "@/utils/cancel.js";

export interface BranchSummaryPlan {
  revision: number;
  navigation: { leafId: string | null; input?: string };
  provenance: Omit<BranchSummaryPayload, "summary" | "description">;
  history: string;
  fileOperations: FileOperations;
}

function entryText(entry: SessionEntry): string {
  const message = entry.message;
  const limit = BRANCH_SUMMARY_MAX_ENTRY_CHARS;
  const text =
    typeof message.content === "string"
      ? message.content.slice(0, limit)
      : message.content
          .slice(0, 16)
          .flatMap((block) =>
            typeof block.text === "string" ? [block.text.slice(0, limit)] : [],
          )
          .join("\n")
          .slice(0, limit);
  return [
    text,
    ...(message.tool_uses ?? [])
      .slice(0, 16)
      .map(
        (tool) => `Historical tool request: ${tool.tool_name.slice(0, 256)}`,
      ),
    ...(message.tool_results ?? [])
      .slice(0, 16)
      .map(
        (result) =>
          `Historical tool result (${result.is_error ? "error" : "reported result"}): ${result.content.slice(0, limit)}`,
      ),
  ]
    .join("\n")
    .slice(0, limit);
}

/** Pure preflight: selects no leaf, writes no records and makes no provider requests. */
export function prepareBranchSummary(
  manager: SessionManager,
  entryId: string | null,
): BranchSummaryPlan {
  const navigation = manager.resolveNavigation(entryId);
  const entries = new Map(
    manager.getEntries().map((entry) => [entry.entryId, entry]),
  );
  const path = (leafId: string | null): SessionEntry[] => {
    const result: SessionEntry[] = [];
    for (let id = leafId; id !== null;) {
      const entry = entries.get(id);
      if (!entry) {
        throw new Error(BRANCH_SUMMARY_INCOMPLETE);
      }
      result.push(entry);
      id = entry.parentId;
    }
    return result.reverse();
  };
  const source = path(manager.leafId);
  const target = path(navigation.leafId);
  let common = 0;
  while (
    common < source.length &&
    common < target.length &&
    source[common].entryId === target[common].entryId
  ) {
    common++;
  }
  const commonAncestorId = source[common - 1]?.entryId ?? null;
  const ancestor = manager.resolveNavigation(commonAncestorId);
  if (ancestor.input === undefined && ancestor.leafId !== commonAncestorId) {
    throw new Error(UNSAFE_TOOL_BOUNDARY);
  }
  const divergent = source.slice(common);
  const candidates = divergent
    .filter(
      (entry) =>
        entry.message.role !== "system" &&
        !entry.message.user_bash?.excludeFromContext,
    )
    .slice(-BRANCH_SUMMARY_MAX_ENTRIES);
  const lines: string[] = [];
  let remaining =
    BRANCH_SUMMARY_MAX_INPUT_CHARS -
    BRANCH_SUMMARY_SYSTEM_PROMPT.length -
    BRANCH_SUMMARY_MAX_DESCRIPTION_CHARS * 6 -
    1_024;
  for (const entry of candidates.toReversed()) {
    const text = entryText(entry);
    if (!text.trim()) {
      continue;
    }
    const line = JSON.stringify({
      entryId: entry.entryId,
      role: entry.message.role,
      text,
    })
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026");
    if (line.length + 1 > remaining) {
      break;
    }
    lines.unshift(line);
    remaining -= line.length + 1;
  }
  return {
    revision: manager.revision,
    navigation,
    provenance: {
      sourceSessionId: manager.id,
      fromEntryId: manager.leafId,
      commonAncestorId,
      targetEntryId: entryId,
      targetLeafId: navigation.leafId,
      sourcePathEntryIds: divergent.map((entry) => entry.entryId),
      targetPathEntryIds: target.map((entry) => entry.entryId),
    },
    history: lines.join("\n"),
    fileOperations: collectFileOperations(manager.getMessages()),
  };
}

/** Uses the runtime's measured client and root ledger; never invokes an Agent or tools. */
export async function generateBranchSummary(
  plan: BranchSummaryPlan,
  client: LLMClient,
  options: {
    ledger: ExecutionLedger;
    description?: string;
    signal?: AbortSignal;
  },
): Promise<BranchSummaryPayload | undefined> {
  options.signal?.throwIfAborted();
  const description = options.description ?? "";
  BranchSummaryPayloadSchema.shape.description.parse(description);
  if (!plan.history) {
    return undefined;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(BRANCH_SUMMARY_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  const conversation = new ConversationManager();
  conversation.addUserMessage(
    buildBranchSummaryPrompt(plan.history, description),
  );
  const work = () =>
    withExecutionContext(
      {
        sessionId: plan.provenance.sourceSessionId,
        runId: randomUUID(),
        agentId: "main",
        purpose: "branch_summary",
        ledger: options.ledger,
      },
      async () => {
        let text = "";
        let streamChars = 0;
        let tools = false;
        let completed = false;
        try {
          for await (const event of client.stream(conversation, [], signal, {
            systemPrompt: BRANCH_SUMMARY_SYSTEM_PROMPT,
            maxOutputTokens: BRANCH_SUMMARY_MAX_OUTPUT_TOKENS,
            answerReserveTokens: BRANCH_SUMMARY_MAX_OUTPUT_TOKENS,
            maxRetries: 0,
            cacheMode: "off",
          })) {
            signal.throwIfAborted();
            switch (event.type) {
              case "text_delta":
                text += event.text;
                streamChars += event.text.length;
                break;
              case "thinking_delta":
              case "tool_call_delta":
                streamChars += event.text.length;
                break;
              case "thinking_complete":
                streamChars += event.thinking.length;
                break;
              case "redacted_thinking_complete":
                streamChars += event.data.length;
                break;
              case "stream_end":
                completed =
                  event.stopReason === "end_turn" ||
                  event.stopReason === "stop" ||
                  event.stopReason === "stop_sequence";
                break;
            }
            if (
              event.type === "tool_call_start" ||
              event.type === "tool_call_delta" ||
              event.type === "tool_call_complete"
            ) {
              tools = true;
            }
            if (
              text.length > BRANCH_SUMMARY_MAX_OUTPUT_CHARS ||
              streamChars > BRANCH_SUMMARY_MAX_STREAM_CHARS
            ) {
              controller.abort(new Error(BRANCH_SUMMARY_TOO_LARGE));
              throw new Error(BRANCH_SUMMARY_TOO_LARGE);
            }
          }
          signal.throwIfAborted();
          if (tools) {
            throw new Error(BRANCH_SUMMARY_TOOLS);
          }
          if (!completed) {
            throw new Error(BRANCH_SUMMARY_INCOMPLETE);
          }
          if (!text.trim()) {
            throw new Error(BRANCH_SUMMARY_EMPTY);
          }
          return BranchSummaryPayloadSchema.parse({
            ...plan.provenance,
            summary: text.trim(),
            details: plan.fileOperations,
            ...(description ? { description } : {}),
          });
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      },
    );
  try {
    return await cancelOnSignal(work, signal);
  } finally {
    controller.abort();
  }
}
