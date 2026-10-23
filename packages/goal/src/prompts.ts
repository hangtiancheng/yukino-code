import { PERSISTENT_GOAL_MARKER } from "@yukino.js/agent/constants.js";
import {
  MAX_BLOCKED_ATTEMPTS,
  MAX_GOAL_TURNS,
  NO_GOAL_MESSAGE,
} from "./constants.js";
import type { GoalState } from "./index.js";

export const CONTINUATION_INSTRUCTION =
  "Preserve the full objective and do not narrow success to completed work. Before using Goal to mark complete, derive all requirements and verify each with authoritative evidence; check that tests cover those requirements and treat uncertainty as unfinished work. If the same blocker persists, record it once per continuation turn; three consecutive turns stop continuation. Difficulty, slowness, and partial progress are not blockers. Honor user steering, current permissions, and pending approvals. Do not repeat completed work.";

export const REMINDER_INSTRUCTION =
  "Only the user can set, replace, pause, or resume a goal. Use Goal to get status or report in_progress, complete, or blocked with a reason. in_progress reports progress and resets the blocker audit while keeping an active goal active. Preserve the full objective. Completion requires every requirement to be achieved and supported by verified evidence, including checking test coverage; uncertain work remains unfinished. Record the same unavoidable blocker once per turn; only three consecutive turns stop continuation. Difficulty or partial progress does not establish a blocker. Honor paused and terminal states, user steering, permissions, and approvals.";

export const BUDGET_LIMIT_INSTRUCTION =
  "The goal token budget is exhausted. Stop substantive work. This is the single final summary request; no tools are available. Briefly report what was accomplished and verified, what remains unfinished, and any blockers. Preserve the full objective and do not claim incomplete work is complete. Leave the goal budget_limited for the user to decide.";

export const DUPLICATE_BLOCKER_NOTICE =
  "A blocker was already recorded for this turn; reassess on the next continuation turn.";

export function formatGoalStatus(goal: GoalState | null): string {
  if (!goal) {
    return NO_GOAL_MESSAGE;
  }
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens: ${String(goal.tokensUsed)}${goal.tokenBudget === null ? "" : ` / ${String(goal.tokenBudget)}`}\nActive time: ${String(Math.floor(goal.activeMs / 1000))}s\nContinuation turns: ${String(goal.turnsExecuted)} / ${String(MAX_GOAL_TURNS)}${goal.lastBlockReason ? `\nBlocker: ${goal.lastBlockReason}` : ""}`;
}

export function buildContinuationPrompt(objective: string): string {
  return `Continue working toward the persistent goal: ${objective}\n${CONTINUATION_INSTRUCTION}`;
}

export function buildGoalReminder(statusReport: string): string {
  return `${PERSISTENT_GOAL_MARKER}\n${statusReport}\n${REMINDER_INSTRUCTION}\n</persistent-goal>`;
}

export function buildBudgetLimitPrompt(statusReport: string): string {
  return `<goal-budget-limit>\n${statusReport}\n${BUDGET_LIMIT_INSTRUCTION}\n</goal-budget-limit>`;
}

export function buildBlockedAuditNotice(
  attempts: number,
  statusReport: string,
): string {
  return `Blocked audit: ${String(attempts)}/${String(MAX_BLOCKED_ATTEMPTS)} consecutive turns.\n${statusReport}`;
}

export function buildGoalSetPrompt(objective: string): string {
  return `Work toward this persistent goal: ${objective}`;
}
