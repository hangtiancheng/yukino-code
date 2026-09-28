import { randomUUID } from "node:crypto";

import { CommentCollector, CodeCommentTool } from "./comment-tool.js";
import { FileReadDiffTool } from "./file-read-diff.js";
import { filterComments } from "./filter.js";
import {
  buildChangeFilesExceptGroup,
  buildConcatenatedDiffs,
  buildConfirmedCommentsBlock,
  buildMainTaskMessage,
  CONFIRMED_CAP,
} from "./format.js";
import { collectDiffs, deriveReviewMode } from "./git.js";
import { groupDiffs } from "./grouping.js";
import { callOnce } from "./llm-call.js";
import {
  MAIN_SYSTEM,
  NO_TOOL_USE_NUDGE,
  PLAN_SYSTEM,
  PLAN_USER,
  renderTemplate,
} from "./prompts.js";
import { relocateWithLlm } from "./relocate.js";
import { relocateAcrossFiles, resolveComment } from "./resolve.js";
import {
  PROMPT_TOKEN_RATIO,
  selectFiles,
  summarizeSelection,
} from "./selection.js";
import type {
  CodeReviewOptions,
  CodeReviewResult,
  FileDiff,
  FileGroup,
  ReviewComment,
  ReviewMode,
  ReviewToolEvent,
} from "./types.js";

import { Agent } from "@/agent/index.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  type ProviderConfig,
} from "@/config/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { createClient, type LLMClient } from "@/llm/client.js";
import { PermissionChecker } from "@/permissions/index.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { GlobTool } from "@/tools/glob.js";
import { GrepTool } from "@/tools/grep.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { ToolRegistry } from "@/tools/registry.js";

/**
 * The review orchestrator, ported from OCR internal/agent/agent.go.
 * Deterministic engineering (selection, grouping limits, positioning,
 * filtering) wraps a yukino Agent per file group: each group runs as an
 * isolated subagent with its own conversation, registry, and permission
 * scope, reusing yukino's tool loop and auto-compaction.
 */

const UTIL_SYSTEM_PROMPT =
  "You are a precise assistant. Follow the instructions exactly and output only what is requested.";

/** Plan phase thresholds (OCR PLAN_MODE_LINE_THRESHOLD / GROUP_LINE_THRESHOLD). */
const PLAN_MODE_LINE_THRESHOLD = 50;
const PLAN_MODE_GROUP_LINE_THRESHOLD = 100;
/** Per-group agent turn cap (OCR MAX_TOOL_REQUEST_TIMES, scaled down). */
const MAX_AGENT_ITERATIONS = 50;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ROUNDS = 2;

export interface RunCodeReviewDeps {
  provider: ProviderConfig;
}

export interface ParsedReviewArgs {
  from?: string;
  to?: string;
  commit?: string;
  excludePatterns: string[];
  background: string;
}

function tokenizeReviewArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  for (const char of args) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (escaped) {
    throw new Error("Invalid /review arguments: trailing escape character");
  }
  if (quote) {
    throw new Error("Invalid /review arguments: unterminated quote");
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** Parse `/review` args: `--from X --to Y`, `--commit X`, repeatable
 * `--exclude GLOB`; everything else is the focus/background text. */
export function parseReviewArgs(args: string): ParsedReviewArgs {
  const tokens = tokenizeReviewArgs(args);
  let from: string | undefined;
  let to: string | undefined;
  let commit: string | undefined;
  const excludePatterns: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();

  const setSingleValue = (name: string, value: string): void => {
    if (!value) {
      throw new Error(`Option "--${name}" requires a value`);
    }
    if (seen.has(name)) {
      throw new Error(`Option "--${name}" may only be specified once`);
    }
    seen.add(name);
    if (name === "from") {
      from = value;
    } else if (name === "to") {
      to = value;
    } else {
      commit = value;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      rest.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const name = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (name === "exlcude") {
      throw new Error('Unknown option "--exlcude"; did you mean "--exclude"?');
    }
    if (!new Set(["from", "to", "commit", "exclude"]).has(name)) {
      throw new Error(`Unknown option "--${name}"`);
    }

    let value: string;
    if (equalsIndex === -1) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Option "--${name}" requires a value`);
      }
      value = next;
      i++;
    } else {
      value = token.slice(equalsIndex + 1);
      if (!value) {
        throw new Error(`Option "--${name}" requires a value`);
      }
    }

    if (name === "exclude") {
      excludePatterns.push(value);
    } else {
      setSingleValue(name, value);
    }
  }

  validateReviewInput(from, to, commit);
  return { from, to, commit, excludePatterns, background: rest.join(" ") };
}

/** Ref combination rules (OCR shared_flags.go): range and commit modes are
 * mutually exclusive, a range needs both ends, and no ref may look like a flag. */
export function validateReviewInput(
  from?: string,
  to?: string,
  commit?: string,
): void {
  if (commit && (from || to)) {
    throw new Error("--commit cannot be combined with --from/--to");
  }
  if ((from && !to) || (!from && to)) {
    throw new Error("--from and --to must be used together");
  }
  for (const ref of [from, to, commit]) {
    if (ref?.startsWith("-")) {
      throw new Error(`invalid ref "${ref}": refs must not start with "-"`);
    }
  }
}

function diffsChurn(diffs: FileDiff[]): { total: number; maxFile: number } {
  let total = 0;
  let maxFile = 0;
  for (const d of diffs) {
    const churn = d.insertions + d.deletions;
    total += churn;
    if (churn > maxFile) {
      maxFile = churn;
    }
  }
  return { total, maxFile };
}

interface GroupOutcome {
  label: string;
  files: string[];
  completed: boolean;
  comments: ReviewComment[];
  error?: string;
}

function noopProgress(): void {
  // Default sink when the caller does not track progress.
}

export async function runCodeReview(
  options: CodeReviewOptions,
  deps: RunCodeReviewDeps,
): Promise<CodeReviewResult> {
  const { workDir, abortSignal } = options;
  const progress = options.onProgress ?? noopProgress;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_CONCURRENCY;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const background = options.background ?? "";

  validateReviewInput(options.from, options.to, options.commit);
  const parsed = {
    from: options.from,
    to: options.to,
    commit: options.commit,
  };
  const mode: ReviewMode = deriveReviewMode(parsed);

  const result: CodeReviewResult = {
    mode,
    comments: [],
    filesReviewed: 0,
    filesChanged: 0,
    groups: [],
    excluded: [],
    filteredOut: 0,
    aborted: false,
  };

  // Step 1: collect and parse diffs.
  progress({ phase: "diff", message: "Collecting git diffs…" });
  const diffs = await collectDiffs({
    workDir,
    mode,
    from: options.from,
    to: options.to,
    commit: options.commit,
    abortSignal,
  });
  result.filesChanged = diffs.length;
  if (diffs.length === 0) {
    progress({ phase: "done", message: "No changes found.", progress: 1 });
    return result;
  }

  // Step 2: deterministic selection. The per-file ceiling derives from the
  // provider's declared context window (OCR PromptTokenLimit = 80%), so a
  // small-window provider cannot be fed a diff it cannot hold.
  const contextWindow = getContextWindow(deps.provider);
  const maxOutput = getMaxOutputTokens(deps.provider);
  const fileTokenLimit = Math.floor(contextWindow * PROMPT_TOKEN_RATIO);
  const decisions = selectFiles(diffs, {
    excludePatterns: options.excludePatterns,
    fileTokenLimit,
  });
  const summary = summarizeSelection(decisions);
  result.excluded = summary.excluded;
  if (summary.selectedCount === 0) {
    progress({
      phase: "done",
      message:
        summary.tooLargeCount > 0
          ? `${String(summary.tooLargeCount)} file(s) exceeded the size limit; nothing left to review.`
          : "No reviewable files changed. Skipping review.",
      progress: 1,
    });
    return result;
  }
  const selectedCount = summary.selectedCount;
  progress({
    phase: "selection",
    message: `${String(diffs.length)} file(s) changed, reviewing ${String(selectedCount)}`,
  });

  // Step 3: LLM clients. One neutral client for the one-shot utility calls
  // (grouping, plan, filter, re-location) that inline their own instructions;
  // each group gets its own persona-bound client so the loop's max-output
  // escalation mutates no shared state.
  const utilClient = await createClient(
    { ...deps.provider, thinking: "off" },
    UTIL_SYSTEM_PROMPT,
  );

  // Step 4: semantic grouping over the reviewable set (deletions stay in the
  // retained set for prompt context but are never dispatched).
  progress({ phase: "grouping", message: "Grouping files…" });
  const groups = await groupDiffs(summary.selected, {
    client: utilClient,
    abortSignal,
    tokenBudget: fileTokenLimit,
    onFallback: (reason) => {
      progress({
        phase: "grouping",
        message: `Grouping fell back to deterministic chunking (${reason})`,
      });
    },
  });
  result.groups = groups.map((g) => ({
    label: g.label,
    files: g.diffs.map((d) => d.newPath),
  }));

  const diffByPath = new Map<string, FileDiff>();
  for (const d of summary.retained) {
    if (d.newPath && d.newPath !== "/dev/null") {
      diffByPath.set(d.newPath, d);
    }
    if (d.oldPath && d.oldPath !== "/dev/null") {
      diffByPath.set(d.oldPath, d);
    }
  }
  const allDiffs = (): FileDiff[] => summary.retained;
  const currentDate = new Date().toISOString().slice(0, 16).replace("T", " ");

  // Step 5: concurrent per-group subagents. Each group owns its collector:
  // the filter's index arithmetic is only valid against indices nothing else
  // mutates, so a shared collector would let one group's removals corrupt
  // another group's baselines (and let its filter delete foreign findings).
  const outcomes: GroupOutcome[] = [];
  let completedGroups = 0;
  let filteredOut = 0;

  const executeGroup = async (g: FileGroup): Promise<void> => {
    const label = g.label;
    const outcome: GroupOutcome = {
      label,
      files: g.diffs.map((d) => d.newPath),
      completed: false,
      comments: [],
    };
    const collector = new CommentCollector();
    try {
      await executeGroupSubtask(g, {
        workDir,
        provider: deps.provider,
        utilClient,
        collector,
        diffByPath,
        allDiffs,
        currentDate,
        background,
        maxRounds,
        skipFilter: options.skipFilter ?? false,
        abortSignal,
        contextWindow,
        maxOutput,
        onPhase: (phase, message) => {
          progress({ phase, message: `[${label}] ${message}` });
        },
        onFiltered: (n) => {
          filteredOut += n;
        },
        onToolEvent: options.onToolEvent,
      });
      outcome.completed = true;
    } catch (err) {
      if (!abortSignal?.aborted) {
        outcome.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      // Comments produced before a failure (or an interrupt) are kept.
      outcome.comments = collector.all();
      completedGroups++;
      progress({
        phase: "review",
        message: `Group ${String(completedGroups)}/${String(groups.length)} done (${label})`,
        progress: completedGroups / groups.length,
      });
    }
    outcomes.push(outcome);
  };

  // Semaphore pool: bounded concurrency keeps provider rate limits and the
  // terminal output readable; in-flight groups always run to completion.
  const queue = [...groups];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(maxConcurrency, queue.length); i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const g = queue.shift();
          if (!g) {
            return;
          }
          abortSignal?.throwIfAborted();
          await executeGroup(g);
        }
      })(),
    );
  }
  await Promise.all(workers);

  if (abortSignal?.aborted) {
    result.aborted = true;
  }
  result.comments = finalizeComments(outcomes.flatMap((o) => o.comments));
  result.filteredOut = filteredOut;
  result.filesReviewed = outcomes
    .filter((o) => o.completed)
    .reduce((n, o) => n + o.files.length, 0);
  progress({
    phase: "done",
    message: result.aborted
      ? `Review aborted: ${String(result.comments.length)} finding(s) collected before the interrupt`
      : `Review complete: ${String(result.comments.length)} finding(s) across ${String(groups.length)} group(s)`,
    progress: 1,
  });
  return result;
}

interface GroupSubtaskDeps {
  workDir: string;
  provider: ProviderConfig;
  utilClient: LLMClient;
  collector: CommentCollector;
  diffByPath: Map<string, FileDiff>;
  allDiffs: () => FileDiff[];
  currentDate: string;
  background: string;
  maxRounds: number;
  skipFilter: boolean;
  abortSignal?: AbortSignal;
  contextWindow: number;
  maxOutput: number;
  onPhase: (phase: "plan" | "review" | "filter", message: string) => void;
  onFiltered: (removed: number) => void;
  onToolEvent?: (event: ReviewToolEvent) => void;
}

/**
 * Two-phase review of one file group (OCR executeGroupSubtask): an optional
 * plan pass for large changes, then up to maxRounds main-loop rounds with
 * confirmed-findings feedback and a reflection filter after each round.
 */
async function executeGroupSubtask(
  g: FileGroup,
  deps: GroupSubtaskDeps,
): Promise<void> {
  const { abortSignal } = deps;
  const concatenatedDiffs = buildConcatenatedDiffs(g.diffs);
  const changeFiles = buildChangeFilesExceptGroup(deps.allDiffs(), g.diffs);
  const { total, maxFile } = diffsChurn(g.diffs);

  // Per-group persona-bound client: the agent loop's max-output escalation
  // calls client.setMaxOutputTokens, which must not leak across groups.
  const agentClient = await createClient({ ...deps.provider }, MAIN_SYSTEM);

  // Phase 1: plan — only worth its tokens above the churn thresholds
  // (OCR PlanRequired: any file >= 50 lines, or >= 2 files totaling >= 100).
  let planResult = "";
  const planRequired =
    maxFile >= PLAN_MODE_LINE_THRESHOLD ||
    (g.diffs.length >= 2 && total >= PLAN_MODE_GROUP_LINE_THRESHOLD);
  if (planRequired) {
    deps.onPhase("plan", "Planning review…");
    try {
      const prompt = `${PLAN_SYSTEM}\n\n${renderTemplate(PLAN_USER, {
        change_files: changeFiles,
        diffs: concatenatedDiffs,
        current_system_date_time: deps.currentDate,
        requirement_background: deps.background,
      })}`;
      planResult = await callOnce(deps.utilClient, prompt, abortSignal);
    } catch (err) {
      if (abortSignal?.aborted) {
        throw err;
      }
      // A failed plan degrades to planless review, never aborts the group.
      planResult = "";
    }
  }

  // Per-path baselines for round-delta computation. The collector is
  // group-local, so the absolute indices the filter removes by are stable.
  const confirmed: ReviewComment[] = [];

  for (let round = 1; round <= deps.maxRounds; round++) {
    abortSignal?.throwIfAborted();

    // Round 2+ strips the plan to avoid it acting as a coverage ceiling.
    const roundPlan = round > 1 ? "" : planResult;
    const baseline = deps.collector.snapshot();

    deps.onPhase(
      "review",
      `Review round ${String(round)}/${String(deps.maxRounds)}…`,
    );
    const message = buildMainTaskMessage({
      changeFiles,
      diffs: concatenatedDiffs,
      currentDateTime: deps.currentDate,
      background: deps.background,
      planGuidance: roundPlan,
      confirmedComments: buildConfirmedCommentsBlock(confirmed),
    });
    let madeToolCalls = await runGroupAgent(g, deps, { message, agentClient });
    let newComments = deps.collector.since(baseline);
    if (!madeToolCalls && newComments.length === 0) {
      // The loop ends on a tool-free turn; without a nudge a distracted
      // first response would silently complete an empty review (OCR nudges
      // no-tool-call rounds for the same reason).
      deps.onPhase("review", "No review activity; retrying with a nudge…");
      madeToolCalls = await runGroupAgent(g, deps, {
        message: message + NO_TOOL_USE_NUDGE,
        agentClient,
      });
      newComments = deps.collector.since(baseline);
    }

    // Reflection: strip comments this round's diff proves wrong.
    let kept = newComments;
    if (!deps.skipFilter && newComments.length > 0) {
      deps.onPhase(
        "filter",
        `Fact-checking ${String(newComments.length)} finding(s)…`,
      );
      const removeIdx = await filterComments(g.diffs, newComments, {
        client: deps.utilClient,
        abortSignal,
      });
      if (removeIdx.size > 0) {
        deps.collector.removeAt([...removeIdx].map((i) => baseline + i));
        deps.onFiltered(removeIdx.size);
        kept = newComments.filter((_, i) => !removeIdx.has(i));
      }
    }
    confirmed.push(...kept);

    if (kept.length === 0) {
      // No new confirmed findings: another round would repeat itself.
      break;
    }
    if (confirmed.length >= CONFIRMED_CAP) {
      break;
    }
  }
}

interface RunGroupAgentOptions {
  message: string;
  agentClient: LLMClient;
}

/**
 * Run one main-task agent loop for a group on top of yukino's Agent: the
 * loop's auto-compaction covers long tool-heavy conversations, and the
 * turn ends when the model stops calling tools (the adapted prompt says so).
 * Returns whether the model used any tools at all.
 */
async function runGroupAgent(
  g: FileGroup,
  deps: GroupSubtaskDeps,
  opts: RunGroupAgentOptions,
): Promise<boolean> {
  const registry = new ToolRegistry();
  registry.register(
    new CodeCommentTool({
      collector: deps.collector,
      groupDiffs: g.diffs,
      allDiffs: deps.allDiffs,
      groupLabel: g.label,
      resolve: async (comments) => {
        for (const cm of comments) {
          const d = deps.diffByPath.get(cm.path);
          let located = d ? resolveComment(cm, d) : false;
          // Cross-file search precedes the LLM step because it needs the
          // model's original existing_code, which re-location overwrites.
          if (!located) {
            located = relocateAcrossFiles(cm, deps.allDiffs()) !== null;
          }
          if (!located && d) {
            await relocateWithLlm(deps.utilClient, cm, d, deps.abortSignal);
          }
        }
      },
    }),
  );
  registry.register(new FileReadDiffTool(deps.diffByPath));
  registry.register(new ReadFileTool());
  registry.register(new GrepTool());
  registry.register(new GlobTool());

  const conversation = new ConversationManager();
  conversation.addUserMessage(opts.message);

  const agent = new Agent({
    client: opts.agentClient,
    registry,
    // All review tools are category "read", so "default" mode auto-allows
    // everything an unattended review can do while write/command attempts
    // (which have no permission handler here) are simply not executed.
    checker: new PermissionChecker(deps.workDir, "default"),
    conversation,
    workDir: deps.workDir,
    maxIterations: MAX_AGENT_ITERATIONS,
    abortSignal: deps.abortSignal,
    fileStateCache: new FileStateCache(),
    contextWindow: deps.contextWindow,
    maxOutput: deps.maxOutput,
  });

  const toolIdPrefix = `review:${randomUUID()}:`;
  const pendingTools = new Map<
    string,
    { toolName: string; startedAt: number }
  >();
  let madeToolCalls = false;
  try {
    for await (const event of agent.run()) {
      if (event.type === "tool_use") {
        madeToolCalls = true;
        pendingTools.set(event.toolId, {
          toolName: event.toolName,
          startedAt: Date.now(),
        });
        deps.onToolEvent?.({
          ...event,
          toolId: toolIdPrefix + event.toolId,
        });
      }
      if (event.type === "tool_result") {
        pendingTools.delete(event.toolId);
        deps.onToolEvent?.({
          ...event,
          toolId: toolIdPrefix + event.toolId,
        });
      }
      if (event.type === "error") {
        throw event.error;
      }
      if (
        event.type === "loop_complete" &&
        event.stopReason === "interrupted"
      ) {
        deps.abortSignal?.throwIfAborted();
      }
    }
  } finally {
    const now = Date.now();
    for (const [toolId, pending] of pendingTools) {
      deps.onToolEvent?.({
        type: "tool_result",
        toolName: pending.toolName,
        toolId: toolIdPrefix + toolId,
        output: deps.abortSignal?.aborted
          ? "Review tool call interrupted."
          : "Review tool call did not complete.",
        isError: true,
        elapsed: (now - pending.startedAt) / 1000,
      });
    }
  }
  return madeToolCalls;
}

/** Sort by path then line, and drop exact duplicates. */
export function finalizeComments(comments: ReviewComment[]): ReviewComment[] {
  const seen = new Set<string>();
  const deduped: ReviewComment[] = [];
  for (const cm of comments) {
    const key = `${cm.path}:${String(cm.startLine)}:${cm.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(cm);
  }
  const severityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  return deduped.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    if (a.startLine !== b.startLine) {
      return a.startLine - b.startLine;
    }
    return (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
  });
}
