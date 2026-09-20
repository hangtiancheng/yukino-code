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

import {
  buildCompactionSummaryMessage,
  buildSummaryInstructions,
  buildSummaryPrompt,
} from "./prompts.js";
import type { RecoveryState } from "./recovery.js";

import { ConversationManager } from "@/conversation/index.js";
import type { Message } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError } from "@/llm/errors.js";
import {
  type CompactBoundaryPayload,
  toolUsesToRecords,
  toolResultsToRecords,
} from "@/session/index.js";
import type {
  ProviderToolSchema,
  ToolResultContentBlock,
} from "@/tools/types.js";
import { asErrorString, contentToText, strArg } from "@/utils/index.js";

// Structured outcome of a compaction. When `compacted` is true, `boundary`
// carries the summary plus the verbatim kept tail (including tool blocks) so
// the caller that owns the sessionId can persist a compact_boundary record —
// exactly what resume needs to replay.
export interface CompactResult {
  compacted: boolean;
  message: string;
  boundary?: CompactBoundaryPayload;
}

// Legacy ratio threshold, kept for reference. The live judgment below uses a
// token-budget formula: reserve room for the summary output in the next
// response turn, then leave a safety margin before the window fills.
// const AUTO_COMPACT_THRESHOLD = 0.8;

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PTL_RETRIES = 3;
const PTL_RETRY_MARKER =
  "[earlier conversation truncated for compaction retry]";
const CHARS_PER_TOKEN = 3.5;

// Recent-history retention budget for compaction. When we compact we keep the tail of
// the transcript verbatim instead of collapsing everything into a summary, so
// the model still sees the literal recent exchange (not just a paraphrase).
//   KEEP_RECENT_TOKENS — lower bound: walk back from the tail until the kept
//     tail reaches at least this many tokens (one of two "good enough" stops).
//   MIN_KEEP_MESSAGES — floor: keep at least this many recent messages even if
//     they are short (the other "good enough" stop).
//   KEEP_MAX_TOKENS — upper bound: never let the kept tail exceed this; stop
//     walking back once adding the next message would cross it.
const KEEP_RECENT_TOKENS = 10000;
const MIN_KEEP_MESSAGES = 5;
const KEEP_MAX_TOKENS = 40000;

// If fewer than this many messages would be summarized (everything else is in
// the kept tail), skip compaction entirely — the savings aren't worth the
// summary round-trip and the lost cache. Degenerate-case guard.
const MIN_COMPACT_PREFIX = 2;

const SUMMARY_OUTPUT_RESERVE = 20000;
const AUTO_COMPACT_SAFETY_MARGIN = 13000;
const MANUAL_COMPACT_SAFETY_MARGIN = 3000;

// effectiveWindow = contextWindow − min(model maxOutput, SUMMARY_OUTPUT_RESERVE).
// Auto-compact triggers at effectiveWindow − AUTO margin; once token usage crosses
// effectiveWindow − MANUAL margin (the hard block line) we must force a compaction.
export function computeCompactThreshold(
  contextWindow: number,
  maxOutput: number,
  manual = false,
): number {
  const effective = contextWindow - Math.min(maxOutput, SUMMARY_OUTPUT_RESERVE);
  const margin = manual
    ? MANUAL_COMPACT_SAFETY_MARGIN
    : AUTO_COMPACT_SAFETY_MARGIN;
  return effective - margin;
}

export class AutoCompactTrackingState {
  consecutiveFailures = 0;
}

// Real-token anchor captured after each stream ends. Instead of re-estimating
// the whole transcript from characters every turn, we pin the last API-reported context size
// (input + cache_read + cache_creation + output) and the message count at that
// moment, then only character-estimate the messages appended afterwards.
export interface UsageAnchor {
  // input + cache_read + cache_creation + output from the last real API usage.
  baselineTokens: number;
  // conversation.len() at the moment the anchor was recorded; only messages
  // beyond this index are estimated incrementally.
  anchorCount: number;
}

// Each image block counts as a fixed char-equivalent (~2000 tokens at
// CHARS_PER_TOKEN, the order of magnitude of Anthropic's per-image token
// cost). Without this, image-heavy conversations systematically
// under-estimate and compaction fires too late.
const IMAGE_CHAR_EQUIV = 7000;

function contentChars(content: string | Record<string, unknown>[]): number {
  if (typeof content === "string") {
    return content.length;
  }
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") {
      chars += strArg(block, "text").length;
    } else if (block.type === "image") {
      chars += IMAGE_CHAR_EQUIV;
    }
  }
  return chars;
}

function toolResultBlocksChars(blocks: ToolResultContentBlock[]): {
  textChars: number;
  richChars: number;
} {
  let textChars = 0;
  let richChars = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        textChars += block.text.length;
        break;
      }
      case "image": {
        richChars += IMAGE_CHAR_EQUIV;
        break;
      }
      case "tool_reference": {
        richChars += block.tool_name.length;
        break;
      }
      case "search_result": {
        richChars += block.source.length + block.title.length;
        richChars += block.content.reduce(
          (sum, content) => sum + content.text.length,
          0,
        );
        break;
      }
      case "document": {
        switch (block.source.type) {
          case "base64": {
            richChars += IMAGE_CHAR_EQUIV;
            break;
          }
          case "url": {
            richChars += block.source.url.length;
            break;
          }
          case "text": {
            richChars += block.source.data.length;
            break;
          }
          case "content": {
            if (typeof block.source.content === "string") {
              richChars += block.source.content.length;
              break;
            }
            for (const content of block.source.content) {
              richChars +=
                content.type === "text"
                  ? content.text.length
                  : IMAGE_CHAR_EQUIV;
            }
            break;
          }
        }
        break;
      }
    }
  }
  return { textChars, richChars };
}

// Rough character-based token estimate over an explicit message slice. Used both
// for the cold-start whole-transcript fallback and the post-anchor increment.
export function estimateMessages(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += contentChars(msg.content);
    if (msg.toolUses) {
      totalChars += JSON.stringify(msg.toolUses).length;
    }
    if (msg.toolResults) {
      for (const tr of msg.toolResults) {
        if (tr.contentBlocks?.length) {
          const blockChars = toolResultBlocksChars(tr.contentBlocks);
          totalChars +=
            Math.max(tr.content.length, blockChars.textChars) +
            blockChars.richChars;
        } else {
          totalChars += tr.content.length;
        }
      }
    }
    if (msg.thinkingBlocks) {
      for (const tb of msg.thinkingBlocks) {
        totalChars += tb.thinking.length;
      }
    }
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

export function estimateTokens(conv: ConversationManager): number {
  return estimateMessages(conv.getMessages());
}

// Single-message token estimate, reusing the same char/3.5 heuristic as the
// slice estimator so the keep-walk and the context judgment agree.
function estimateOne(msg: Message): number {
  return estimateMessages([msg]);
}

// A user message carrying tool_result blocks is the second half of a
// tool_use↔tool_result pair; its partner tool_use lives on a preceding
// assistant message. We must never keep such a message without its tool_use.
function hasToolResult(msg: Message): boolean {
  return msg.role === "user" && !!msg.toolResults && msg.toolResults.length > 0;
}

// Choose where the kept (verbatim) tail begins. Walk backward from the end
// accumulating per-message tokens until we hit a "good enough" stop — either
// the kept tail reached KEEP_RECENT_TOKENS or we've kept MIN_KEEP_MESSAGES
// messages (whichever comes first is fine, each is a floor) — but never let the
// tail exceed KEEP_MAX_TOKENS (stop before crossing it). Returns the index of
// the first kept message (everything before it gets summarized).
export function computeKeepStartIndex(messages: Message[]): number {
  let keepTokens = 0;
  let keepCount = 0;
  let keepStart = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateOne(messages[i]);
    // Upper bound: adding this message would overflow the kept tail. Stop and
    // leave it out (it belongs to the summarized prefix instead).
    if (keepCount > 0 && keepTokens + t > KEEP_MAX_TOKENS) {
      break;
    }
    keepStart = i;
    keepTokens += t;
    keepCount++;
    // Lower bounds: either floor satisfied → we've kept enough recent context.
    if (keepTokens >= KEEP_RECENT_TOKENS || keepCount >= MIN_KEEP_MESSAGES) {
      break;
    }
  }

  // Don't split a tool_use↔tool_result pair: if the boundary lands on a
  // tool_result user message, move it back past the matching tool_use assistant
  // message so the pair stays whole (better to keep one extra pair than to
  // leave an orphaned tool_result with no originating tool_use).
  keepStart = backUpPastToolUse(messages, keepStart);
  return keepStart;
}

// If messages[keepStart] is a tool_result user message, walk back to include
// the assistant tool_use message that produced its tool_use_id(s). Keeps the
// pair intact; idempotent when the boundary is already clean.
function backUpPastToolUse(messages: Message[], keepStart: number): number {
  if (keepStart <= 0 || keepStart >= messages.length) {
    return keepStart;
  }
  if (!hasToolResult(messages[keepStart])) {
    return keepStart;
  }

  const ids = new Set(
    (messages[keepStart].toolResults ?? []).map((tr) => tr.toolUseId),
  );
  for (let i = keepStart - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === "assistant" &&
      m.toolUses?.some((tu) => ids.has(tu.toolUseId))
    ) {
      return i;
    }
  }
  // No matching tool_use found (shouldn't happen for well-formed transcripts);
  // leave keepStart unchanged rather than dropping the whole prefix.
  return keepStart;
}

// Current context size used for the compact judgment. With a real usage anchor
// we trust the last API-reported token count and only character-estimate the
// messages appended after it (baseline + increment). On a cold start (no anchor
// yet) we fall back to estimating the entire transcript so the very first turn
// still works. Extended with cache tokens for a more accurate baseline.
export function currentContextTokens(
  conv: ConversationManager,
  anchor?: UsageAnchor,
): number {
  const a = anchor ?? conv.usageAnchorState();
  if (!a) {
    return estimateTokens(conv);
  }
  const messages = conv.getMessages();
  const start = Math.min(a.anchorCount, messages.length);
  return a.baselineTokens + estimateMessages(messages.slice(start));
}

export async function manageContext(
  conv: ConversationManager,
  client: LLMClient,
  contextWindow: number,
  maxOutput: number,
  trackingState: AutoCompactTrackingState,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  toolSchemas: ProviderToolSchema[],
  sessionFilePath = "",
  abortSignal?: AbortSignal,
): Promise<CompactResult> {
  // Tool results are already budget-processed at the time they enter history,
  // so tokens can be estimated directly from the conversation messages.
  const tokens = currentContextTokens(conv);
  const autoThreshold = computeCompactThreshold(contextWindow, maxOutput);
  const hardBlock = computeCompactThreshold(contextWindow, maxOutput, true);

  if (tokens < autoThreshold) {
    return { compacted: false, message: "" };
  }

  // Past the hard-block line we must compact even if the circuit breaker tripped.
  const forced = tokens >= hardBlock;
  if (
    !forced &&
    trackingState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
  ) {
    return {
      compacted: false,
      message: `Auto-compact circuit breaker: ${String(MAX_CONSECUTIVE_FAILURES)} consecutive failures`,
    };
  }

  try {
    const result = await doCompact(
      conv,
      client,
      recoveryState,
      toolSchemaNames,
      toolSchemas,
      sessionFilePath,
      abortSignal,
    );
    trackingState.consecutiveFailures = 0;
    return result;
  } catch (err) {
    trackingState.consecutiveFailures++;
    return {
      compacted: false,
      message: `Auto-compact failed: ${asErrorString(err)}`,
    };
  }
}

export async function forceCompact(
  conv: ConversationManager,
  client: LLMClient,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  toolSchemas: ProviderToolSchema[],
  sessionFilePath = "",
  abortSignal?: AbortSignal,
  customInstructions = "",
): Promise<CompactResult> {
  return doCompact(
    conv,
    client,
    recoveryState,
    toolSchemaNames,
    toolSchemas,
    sessionFilePath,
    abortSignal,
    customInstructions,
  );
}

/** Group messages by API round: each new assistant reply starts a new group */
function groupMessagesByAPIRound(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  let hasAssistant = false;

  for (const m of messages) {
    if (m.role === "assistant" && hasAssistant) {
      groups.push(current);
      current = [];
      hasAssistant = false;
    }
    current.push(m);
    hasAssistant ||= m.role === "assistant";
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/** Drop the oldest API round groups until enough tokens are freed */
function truncateHeadForPTL(
  prefix: Message[],
  tokenGap: number,
): Message[] | null {
  const groups = groupMessagesByAPIRound(prefix);
  if (groups.length < 2) {
    return null;
  }

  let dropCount: number;
  if (tokenGap > 0) {
    let acc = 0;
    dropCount = 0;
    for (const g of groups) {
      acc += g.reduce((sum, m) => sum + estimateOne(m), 0);
      dropCount++;
      if (acc >= tokenGap) {
        break;
      }
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length / 5));
  }

  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) {
    return null;
  }

  const result = groups.slice(dropCount).flat();
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: PTL_RETRY_MARKER });
  }
  return result;
}

/** Serialize prefix messages to text */
function serializePrefixText(messages: Message[]): string {
  return messages
    .map((m) => {
      // The summarizer (possibly a text-only model) never sees base64 —
      // image blocks flatten to short placeholders.
      let text = `[${m.role}]: ${contentToText(m.content)}`;
      if (m.toolUses) {
        text += `\n[tool calls]\n${m.toolUses.map((t) => `${t.toolUseId} ${t.toolName} ${JSON.stringify(t.arguments)}`).join("\n")}`;
      }
      if (m.toolResults) {
        text += `\n[tool results]\n${m.toolResults.map((result) => `${result.toolUseId}${result.isError ? " (error)" : ""}: ${result.content}`).join("\n")}`;
      }
      return text;
    })
    .join("\n\n");
}

// Extract the <summary> block from the model's two-phase reply. <analysis> is a
// scratch area; only <summary> is kept as the final summary. Falls back to the
// raw text when the model does not follow the format.
function formatCompactSummary(raw: string): string {
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(raw);
  if (summaryMatch) {
    return summaryMatch[1].trim();
  }
  // No <summary> tag: strip the <analysis> block and return the remainder
  const analysisMatch = /<analysis>[\s\S]*?<\/analysis>/.exec(raw);
  if (analysisMatch) {
    return raw.replace(analysisMatch[0], "").trim();
  }
  return raw.trim();
}

// Cache-sharing summary: keep the original message list without serializing it,
// and append the summary instruction as a trailing user message to the LLM. The
// message prefix matches the main conversation's last API call, so it hits the
// Prompt Cache (Anthropic 90% discount, OpenAI 50%, DeepSeek ~90%).
async function callSummaryWithCacheSharing(
  client: LLMClient,
  messages: Message[],
  toolSchemas: ProviderToolSchema[],
  abortSignal?: AbortSignal,
  customInstructions = "",
): Promise<string> {
  const summaryConv = new ConversationManager();
  summaryConv.appendMessages(messages);
  summaryConv.addUserMessage(buildSummaryInstructions(customInstructions));
  return collectSummary(client, summaryConv, toolSchemas, abortSignal);
}

async function collectSummary(
  client: LLMClient,
  conv: ConversationManager,
  tools: ProviderToolSchema[],
  abortSignal?: AbortSignal,
): Promise<string> {
  abortSignal?.throwIfAborted();
  let text = "";
  for await (const event of client.stream(conv, tools, abortSignal)) {
    abortSignal?.throwIfAborted();
    if (
      event.type === "tool_call_start" ||
      event.type === "tool_call_complete"
    ) {
      throw new Error("Compaction requested a tool instead of a summary");
    }
    if (event.type === "text_delta") {
      text += event.text;
    }
    if (
      event.type === "stream_end" &&
      event.stopReason !== "end_turn" &&
      event.stopReason !== "stop"
    ) {
      throw new Error(`Compaction summary did not finish: ${event.stopReason}`);
    }
  }
  abortSignal?.throwIfAborted();
  const summary = formatCompactSummary(text);
  if (
    !summary ||
    (text.includes("<summary>") && !text.includes("</summary>")) ||
    (text.includes("<analysis>") && !text.includes("</analysis>"))
  ) {
    throw new Error("Compaction returned an empty or incomplete summary");
  }
  return summary;
}

/** Summary generation with PTL retry */
async function requestSummaryWithPTLRetry(
  client: LLMClient,
  prefix: Message[],
  toolSchemas: ProviderToolSchema[],
  abortSignal?: AbortSignal,
  customInstructions = "",
): Promise<string> {
  let currentPrefix = prefix;
  for (let attempt = 0; ; attempt++) {
    const text = serializePrefixText(currentPrefix);
    const summaryConv = new ConversationManager();
    summaryConv.addUserMessage(buildSummaryPrompt(text, customInstructions));

    try {
      return await collectSummary(
        client,
        summaryConv,
        toolSchemas,
        abortSignal,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.toLowerCase() : "";
      const isPTL =
        e instanceof ContextTooLongError ||
        (msg.includes("prompt") && msg.includes("long")) ||
        msg.includes("too many") ||
        msg.includes("context_length");
      if (!isPTL || attempt >= MAX_PTL_RETRIES) {
        throw e;
      }
      const tokenGap =
        currentPrefix.reduce((sum, m) => sum + estimateOne(m), 0) / 5;
      const truncated = truncateHeadForPTL(currentPrefix, tokenGap);
      if (!truncated) {
        throw e;
      }
      currentPrefix = truncated;
    }
  }
}

async function doCompact(
  conv: ConversationManager,
  client: LLMClient,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  toolSchemas: ProviderToolSchema[],
  sessionFilePath = "",
  abortSignal?: AbortSignal,
  customInstructions = "",
): Promise<CompactResult> {
  abortSignal?.throwIfAborted();
  // Tool results in the transcript were already budget-processed to their final
  // form at insertion time; the conversation's own messages represent the actual
  // payload, so estimate tokens and determine the retention boundary directly
  // from them.
  const estimationMessages = conv.getMessages();

  // Decide how much recent history to keep verbatim. Only messages[:keepStart]
  // get summarized; messages[keepStart:] are carried over untouched so the
  // model still sees the literal recent exchange.
  const keepStart = computeKeepStartIndex(estimationMessages);

  // Degenerate cases: if (almost) everything is already inside the kept tail,
  // compacting would only summarize a tiny prefix — "compacted nothing meaningful". Skip it and
  // keep the conversation verbatim rather than churn for no real token savings.
  if (keepStart <= 0 || keepStart < MIN_COMPACT_PREFIX) {
    return {
      compacted: false,
      message: `Compaction skipped: only ${String(keepStart)} message(s) to summarize, kept verbatim`,
    };
  }

  const toSummarize = estimationMessages.slice(0, keepStart);
  const toKeep = estimationMessages.slice(keepStart);

  // Summarize only the prefix; the retained tail must not appear twice in context.
  let summary: string;
  try {
    summary = await callSummaryWithCacheSharing(
      client,
      toSummarize,
      toolSchemas,
      abortSignal,
      customInstructions,
    );
  } catch (err) {
    if (!(err instanceof ContextTooLongError)) {
      throw err;
    }
    summary = await requestSummaryWithPTLRetry(
      client,
      toSummarize,
      toolSchemas,
      abortSignal,
      customInstructions,
    );
  }

  abortSignal?.throwIfAborted();
  const currentMessages = conv.getMessages();
  if (
    currentMessages.length !== estimationMessages.length ||
    currentMessages.some(
      (message, index) => message !== estimationMessages[index],
    )
  ) {
    throw new Error(
      "Conversation changed during compaction; keeping the current history",
    );
  }

  const recoveryAttachment = recoveryState
    ? recoveryState.buildRecoveryAttachment(toolSchemaNames)
    : "";

  let summaryContent = buildCompactionSummaryMessage(
    summary,
    toKeep.length > 0,
  );
  if (sessionFilePath) {
    summaryContent += `\n\nIf you need specific details from before compaction (code snippets, error messages, etc.), use ReadFile to read the full session transcript: ${sessionFilePath}`;
  }
  if (recoveryAttachment) {
    summaryContent += `\n\n---\n\n${recoveryAttachment}`;
  }
  conv.replaceWithCompacted(summaryContent, toKeep);

  // Build the boundary payload the session owner will persist. The kept tail
  // must be persisted together with its tool blocks so that the full call
  // chain is available when the session is restored; messages with neither
  // text nor tool blocks are dropped. The summary here is the bare summary
  // (no recovery attachment): recovery context is rebuilt fresh per process, so
  // baking it into the persisted boundary would be stale on the next resume.
  const keep = toKeep
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        (m.content ||
          (m.toolUses?.length ?? 0) ||
          (m.toolResults?.length ?? 0)),
    )
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolUses?.length
        ? { tool_uses: toolUsesToRecords(m.toolUses) }
        : {}),
      ...(m.toolResults?.length
        ? {
            tool_results: toolResultsToRecords(m.toolResults),
          }
        : {}),
    }));

  return {
    compacted: true,
    message: `Compacted ${String(toSummarize.length)} messages into summary (${String(summary.length)} chars), kept ${String(toKeep.length)} recent messages verbatim`,
    boundary: { summary, keep },
  };
}
