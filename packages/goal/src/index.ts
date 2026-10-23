import { loadSession, saveMessage } from "@yukino.js/session";
import z from "zod";

import {
  BUDGET_ARG_PATTERN,
  BUDGET_EXHAUSTED_ERROR,
  CONTINUE_NOT_TURN_LIMITED_ERROR,
  GOAL_ALREADY_EXISTS_ERROR,
  GOAL_CLEARED_MESSAGE,
  GOAL_RECORD,
  GOAL_USAGE,
  MAX_BLOCKED_ATTEMPTS,
  MAX_GOAL_TURNS,
  MAX_OBJECTIVE_CHARS,
  NO_GOAL_SET_ERROR,
  PAUSE_INACTIVE_GOAL_ERROR,
  REASON_REQUIRED_ERROR,
  RESUME_INVALID_STATE_ERROR,
  RESUME_TURN_LIMITED_ERROR,
  UPDATE_INACTIVE_GOAL_ERROR,
} from "./constants.js";
import {
  buildBlockedAuditNotice,
  buildBudgetLimitPrompt,
  buildContinuationPrompt,
  buildGoalReminder,
  buildGoalSetPrompt,
  DUPLICATE_BLOCKER_NOTICE,
  formatGoalStatus,
} from "./prompts.js";

export * from "./constants.js";
export * from "./prompts.js";

export const GoalSchema = z.object({
  objective: z.string().trim().min(1).max(MAX_OBJECTIVE_CHARS),
  status: z.enum([
    "active",
    "paused",
    "blocked",
    "complete",
    "budget_limited",
    "max_turns",
  ]),
  tokenBudget: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  tokensUsed: z.number().nonnegative(),
  turnsExecuted: z.number().int().nonnegative(),
  activeMs: z.number().nonnegative(),
  blockedAttempts: z.number().int().nonnegative(),
  lastBlockReason: z.string().nullable(),
  lastBlockedTurn: z.number().int().nullable(),
  budgetSummaryPending: z.boolean(),
});
export type GoalState = z.infer<typeof GoalSchema>;

export class GoalManager {
  private state: GoalState | null = null;
  private activeSince: number | null = null;
  private trackingUsage = false;

  constructor(
    private cwd: string,
    readonly sessionId: string,
  ) {
    for (const record of loadSession(cwd, sessionId)) {
      if (record.type !== GOAL_RECORD || typeof record.content !== "string") {
        continue;
      }
      try {
        const value: unknown = JSON.parse(record.content);
        if (value === null) {
          this.state = null;
        } else {
          const parsed = GoalSchema.safeParse(value);
          if (parsed.success) {
            this.state = parsed.data;
          }
        }
      } catch {
        /* Keep the last valid state. */
      }
    }
  }

  get(): GoalState | null {
    return this.state ? { ...this.state, activeMs: this.elapsed() } : null;
  }

  private elapsed(): number {
    return (
      (this.state?.activeMs ?? 0) +
      (this.activeSince === null
        ? 0
        : Math.max(0, Date.now() - this.activeSince))
    );
  }

  private persist(): void {
    if (this.state) {
      this.state.activeMs = this.elapsed();
    }
    if (this.activeSince !== null) {
      this.activeSince = Date.now();
    }
    saveMessage(this.cwd, this.sessionId, {
      role: "system",
      type: GOAL_RECORD,
      content: JSON.stringify(this.state),
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  set(
    objective: string,
    tokenBudget: number | null = null,
    replace = false,
  ): void {
    if (this.state && this.state.status !== "complete" && !replace) {
      throw new Error(GOAL_ALREADY_EXISTS_ERROR);
    }
    this.state = GoalSchema.parse({
      objective,
      tokenBudget,
      status: "active",
      tokensUsed: 0,
      turnsExecuted: 0,
      activeMs: 0,
      blockedAttempts: 0,
      lastBlockReason: null,
      lastBlockedTurn: null,
      budgetSummaryPending: false,
    });
    this.activeSince = null;
    this.trackingUsage = false;
    this.persist();
  }

  clear(): void {
    this.state = null;
    this.activeSince = null;
    this.trackingUsage = false;
    this.persist();
  }

  transition(status: GoalState["status"]): void {
    if (!this.state) {
      throw new Error(NO_GOAL_SET_ERROR);
    }
    this.state.activeMs = this.elapsed();
    this.activeSince = null;
    this.state.status = status;
    this.state.budgetSummaryPending = status === "budget_limited";
    this.persist();
  }

  resume(resetTurns = false): void {
    const goal = this.state;
    if (!goal || !["paused", "blocked", "max_turns"].includes(goal.status)) {
      throw new Error(RESUME_INVALID_STATE_ERROR);
    }
    if (goal.status === "max_turns" && !resetTurns) {
      throw new Error(RESUME_TURN_LIMITED_ERROR);
    }
    if (resetTurns && goal.status !== "max_turns") {
      throw new Error(CONTINUE_NOT_TURN_LIMITED_ERROR);
    }
    if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
      throw new Error(BUDGET_EXHAUSTED_ERROR);
    }
    if (resetTurns) {
      goal.turnsExecuted = 0;
    }
    goal.blockedAttempts = 0;
    goal.lastBlockReason = null;
    goal.lastBlockedTurn = null;
    this.transition("active");
  }

  beginTurn(): void {
    if (this.state?.status !== "active") {
      return;
    }
    this.trackingUsage = true;
    if (this.activeSince === null) {
      this.activeSince = Date.now();
    }
    this.state.turnsExecuted++;
    this.persist();
  }

  endRun(): void {
    this.trackingUsage = false;
    if (this.activeSince === null) {
      return;
    }
    if (this.state) {
      this.state.activeMs = this.elapsed();
    }
    this.activeSince = null;
    this.persist();
  }

  addTokens(tokens: number): void {
    if (
      !this.state ||
      !this.trackingUsage ||
      !Number.isFinite(tokens) ||
      tokens < 0
    ) {
      return;
    }
    this.state.tokensUsed += tokens;
    if (
      this.state.status === "active" &&
      this.state.tokenBudget !== null &&
      this.state.tokensUsed >= this.state.tokenBudget
    ) {
      this.transition("budget_limited");
    } else {
      this.persist();
    }
  }

  update(
    status: "in_progress" | "complete" | "blocked",
    reason: string,
  ): string {
    const goal = this.state;
    if (goal?.status !== "active") {
      throw new Error(UPDATE_INACTIVE_GOAL_ERROR);
    }
    if (!reason.trim()) {
      throw new Error(REASON_REQUIRED_ERROR);
    }
    if (status === "in_progress") {
      goal.blockedAttempts = 0;
      goal.lastBlockReason = null;
      goal.lastBlockedTurn = null;
      this.persist();
      return this.format();
    }
    if (status === "complete") {
      this.transition("complete");
      return this.format();
    }
    if (goal.lastBlockedTurn === goal.turnsExecuted) {
      return DUPLICATE_BLOCKER_NOTICE;
    }
    const same =
      goal.lastBlockReason?.trim().toLowerCase() ===
        reason.trim().toLowerCase() &&
      goal.lastBlockedTurn === goal.turnsExecuted - 1;
    goal.blockedAttempts = same ? goal.blockedAttempts + 1 : 1;
    goal.lastBlockReason = reason.trim();
    goal.lastBlockedTurn = goal.turnsExecuted;
    if (goal.blockedAttempts >= MAX_BLOCKED_ATTEMPTS) {
      this.transition("blocked");
    } else {
      this.persist();
    }
    return buildBlockedAuditNotice(goal.blockedAttempts, this.format());
  }

  continuation(): string | null {
    if (this.state?.status !== "active") {
      return null;
    }
    if (this.state.turnsExecuted >= MAX_GOAL_TURNS) {
      this.transition("max_turns");
      return null;
    }
    return buildContinuationPrompt(this.state.objective);
  }

  takeBudgetSummary(): string | null {
    const goal = this.state;
    if (goal?.status !== "budget_limited" || !goal.budgetSummaryPending) {
      return null;
    }
    goal.budgetSummaryPending = false;
    this.trackingUsage = true;
    this.persist();
    return buildBudgetLimitPrompt(this.format());
  }

  reminder(): string {
    return this.get() ? buildGoalReminder(this.format()) : "";
  }

  format(): string {
    return formatGoalStatus(this.get());
  }
}

export function handleGoalCommand(
  manager: GoalManager,
  args: string,
): { message: string; prompt?: string; isError?: boolean } {
  let input = args.trim();
  try {
    if (!input || input === "status") {
      return { message: manager.format() };
    }
    if (input === "clear") {
      manager.clear();
      return { message: GOAL_CLEARED_MESSAGE };
    }
    if (input === "pause" || input === "complete") {
      if (input === "pause" && manager.get()?.status !== "active") {
        throw new Error(PAUSE_INACTIVE_GOAL_ERROR);
      }
      manager.transition(input === "pause" ? "paused" : "complete");
      return { message: manager.format() };
    }
    if (input === "resume" || input === "continue") {
      manager.resume(input === "continue");
      return {
        message: manager.format(),
        prompt: manager.continuation() ?? undefined,
      };
    }
    const replace = input.startsWith("replace ");
    if (replace) {
      input = input.slice(8).trim();
    }
    let budget: number | null = null;
    if (input.startsWith("--budget ")) {
      const match = BUDGET_ARG_PATTERN.exec(input);
      if (!match) {
        throw new Error(GOAL_USAGE);
      }
      budget = Number(match[1]);
      input = match[2];
    }
    manager.set(input, budget, replace);
    return {
      message: manager.format(),
      prompt: buildGoalSetPrompt(input),
    };
  } catch (error) {
    return {
      message: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}
