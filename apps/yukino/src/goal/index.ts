import z from "zod";

import { loadSession, saveMessage } from "@/session/index.js";

export const MAX_GOAL_TURNS = 150;
export const GOAL_RECORD = "goal_state";
export const GoalSchema = z.object({
  objective: z.string().trim().min(1).max(4000),
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
      throw new Error(
        "An unfinished goal already exists. Use /goal replace <objective> to replace it explicitly.",
      );
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
      throw new Error("No goal is set.");
    }
    this.state.activeMs = this.elapsed();
    this.activeSince = null;
    this.state.status = status;
    this.persist();
  }

  resume(resetTurns = false): void {
    const goal = this.state;
    if (!goal || !["paused", "blocked", "max_turns"].includes(goal.status)) {
      throw new Error(
        "Only a paused, blocked, or turn-limited goal can resume.",
      );
    }
    if (goal.status === "max_turns" && !resetTurns) {
      throw new Error("Use /goal continue to reset the continuation limit.");
    }
    if (resetTurns && goal.status !== "max_turns") {
      throw new Error(
        "/goal continue only resets a turn-limited goal. Use /goal resume.",
      );
    }
    if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
      throw new Error(
        "The token budget is exhausted; replace the goal with an explicit new budget.",
      );
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

  update(status: "complete" | "blocked", reason: string): string {
    const goal = this.state;
    if (goal?.status !== "active") {
      throw new Error("Only an active goal can be updated by the agent.");
    }
    if (!reason.trim()) {
      throw new Error("A reason is required.");
    }
    if (status === "complete") {
      this.transition("complete");
      return this.format();
    }
    if (goal.lastBlockedTurn === goal.turnsExecuted) {
      return "A blocker was already recorded for this turn; reassess on the next continuation turn.";
    }
    const same =
      goal.lastBlockReason?.trim().toLowerCase() ===
        reason.trim().toLowerCase() &&
      goal.lastBlockedTurn === goal.turnsExecuted - 1;
    goal.blockedAttempts = same ? goal.blockedAttempts + 1 : 1;
    goal.lastBlockReason = reason.trim();
    goal.lastBlockedTurn = goal.turnsExecuted;
    if (goal.blockedAttempts >= 3) {
      this.transition("blocked");
    } else {
      this.persist();
    }
    return `Blocked audit: ${String(goal.blockedAttempts)}/3 consecutive turns.\n${this.format()}`;
  }

  continuation(): string | null {
    if (this.state?.status !== "active") {
      return null;
    }
    if (this.state.turnsExecuted >= MAX_GOAL_TURNS) {
      this.transition("max_turns");
      return null;
    }
    return `Continue working toward the persistent goal: ${this.state.objective}\nPreserve the full objective and do not narrow success to completed work. Before using Goal to mark complete, derive all requirements and verify each with authoritative evidence; check that tests cover those requirements and treat uncertainty as unfinished work. If the same blocker persists, record it once per continuation turn; three consecutive turns stop continuation. Difficulty, slowness, and partial progress are not blockers. Honor user steering, current permissions, and pending approvals. Do not repeat completed work.`;
  }

  reminder(): string {
    const goal = this.get();
    return goal
      ? `<persistent-goal>\n${this.format()}\nOnly the user can set, replace, pause, or resume a goal. Use Goal to get status or report completion/blockage. Preserve the full objective. Completion requires every requirement to be achieved and supported by verified evidence, including checking test coverage; uncertain work remains unfinished. Record the same unavoidable blocker once per turn; only three consecutive turns stop continuation. Difficulty or partial progress does not establish a blocker. Honor paused and terminal states, user steering, permissions, and approvals.\n</persistent-goal>`
      : "";
  }

  format(): string {
    const goal = this.get();
    if (!goal) {
      return "No goal is set. Use /goal <objective>.";
    }
    return `Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens: ${String(goal.tokensUsed)}${goal.tokenBudget === null ? "" : ` / ${String(goal.tokenBudget)}`}\nActive time: ${String(Math.floor(goal.activeMs / 1000))}s\nContinuation turns: ${String(goal.turnsExecuted)} / ${String(MAX_GOAL_TURNS)}${goal.lastBlockReason ? `\nBlocker: ${goal.lastBlockReason}` : ""}`;
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
      return { message: "Goal cleared." };
    }
    if (input === "pause" || input === "complete") {
      if (input === "pause" && manager.get()?.status !== "active") {
        throw new Error("Only an active goal can be paused.");
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
      const match = /^--budget\s+(\d+)\s+([\s\S]+)$/u.exec(input);
      if (!match) {
        throw new Error(
          "Usage: /goal [replace] [--budget <positive integer>] <objective>",
        );
      }
      budget = Number(match[1]);
      input = match[2];
    }
    manager.set(input, budget, replace);
    return {
      message: manager.format(),
      prompt: `Work toward this persistent goal: ${input}`,
    };
  } catch (error) {
    return {
      message: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}
