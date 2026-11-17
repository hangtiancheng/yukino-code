package goal

import (
	"strconv"
	"strings"
)

// PersistentGoalMarker mirrors agent/constants.ts PERSISTENT_GOAL_MARKER. It is
// defined here rather than in internal/agent because the agent package imports
// this one (through the tool registry), and Go forbids import cycles. The value
// is identical to the reference.
const PersistentGoalMarker = "<persistent-goal>"

const (
	ContinuationInstruction = "Preserve the full objective and do not narrow success to completed work. Before using Goal to mark complete, derive all requirements and verify each with authoritative evidence; check that tests cover those requirements and treat uncertainty as unfinished work. If the same blocker persists, record it once per continuation turn; three consecutive turns stop continuation. Difficulty, slowness, and partial progress are not blockers. Honor user steering, current permissions, and pending approvals. Do not repeat completed work."

	ReminderInstruction = "Only the user can set, replace, pause, or resume a goal. Use Goal to get status or report in_progress, complete, or blocked with a reason. in_progress reports progress and resets the blocker audit while keeping an active goal active. Preserve the full objective. Completion requires every requirement to be achieved and supported by verified evidence, including checking test coverage; uncertain work remains unfinished. Record the same unavoidable blocker once per turn; only three consecutive turns stop continuation. Difficulty or partial progress does not establish a blocker. Honor paused and terminal states, user steering, permissions, and approvals."

	BudgetLimitInstruction = "The goal token budget is exhausted. Stop substantive work. This is the single final summary request; no tools are available. Briefly report what was accomplished and verified, what remains unfinished, and any blockers. Preserve the full objective and do not claim incomplete work is complete. Leave the goal budget_limited for the user to decide."

	DuplicateBlockerNotice = "A blocker was already recorded for this turn; reassess on the next continuation turn."
)

// formatNumber renders a float the way JavaScript's String(number) does for the
// integer-valued token and millisecond counts used here.
func formatNumber(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func FormatGoalStatus(goal *GoalState) string {
	if goal == nil {
		return NoGoalMessage
	}
	var b strings.Builder
	b.WriteString("Goal: " + goal.Objective + "\n")
	b.WriteString("Status: " + goal.Status + "\n")
	b.WriteString("Tokens: " + formatNumber(goal.TokensUsed))
	if goal.TokenBudget != nil {
		b.WriteString(" / " + strconv.FormatInt(*goal.TokenBudget, 10))
	}
	b.WriteString("\n")
	b.WriteString("Active time: " + strconv.FormatInt(int64(goal.ActiveMs/1000), 10) + "s\n")
	b.WriteString("Continuation turns: " + strconv.Itoa(goal.TurnsExecuted) + " / " + strconv.Itoa(MaxGoalTurns))
	if goal.LastBlockReason != nil {
		b.WriteString("\nBlocker: " + *goal.LastBlockReason)
	}
	return b.String()
}

func BuildContinuationPrompt(objective string) string {
	return "Continue working toward the persistent goal: " + objective + "\n" + ContinuationInstruction
}

func BuildGoalReminder(statusReport string) string {
	return PersistentGoalMarker + "\n" + statusReport + "\n" + ReminderInstruction + "\n</persistent-goal>"
}

func BuildBudgetLimitPrompt(statusReport string) string {
	return "<goal-budget-limit>\n" + statusReport + "\n" + BudgetLimitInstruction + "\n</goal-budget-limit>"
}

func BuildBlockedAuditNotice(attempts int, statusReport string) string {
	return "Blocked audit: " + strconv.Itoa(attempts) + "/" + strconv.Itoa(MaxBlockedAttempts) + " consecutive turns.\n" + statusReport
}

func BuildGoalSetPrompt(objective string) string {
	return "Work toward this persistent goal: " + objective
}
