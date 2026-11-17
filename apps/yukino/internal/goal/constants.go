package goal

import "regexp"

const (
	MaxGoalTurns       = 150
	MaxBlockedAttempts = 3
	MaxObjectiveChars  = 4000
	GoalRecord         = "goal_state"
)

// BudgetArgPattern mirrors /^--budget\s+(\d+)\s+([\s\S]+)$/u. Go's \s is ASCII
// whitespace, which is sufficient for a CLI budget argument.
var BudgetArgPattern = regexp.MustCompile(`^--budget\s+(\d+)\s+([\s\S]+)$`)

const (
	NoGoalMessage               = "No goal is set. Only the user can set one with /goal <objective>."
	GoalAlreadyExistsError      = "An unfinished goal already exists. Use /goal replace <objective> to replace it explicitly."
	NoGoalSetError              = "No goal is set."
	ResumeInvalidStateError     = "Only a paused, blocked, or turn-limited goal can resume."
	ResumeTurnLimitedError      = "Use /goal continue to reset the continuation limit."
	ContinueNotTurnLimitedError = "/goal continue only resets a turn-limited goal. Use /goal resume."
	BudgetExhaustedError        = "The token budget is exhausted; replace the goal with an explicit new budget."
	UpdateInactiveGoalError     = "Only an active goal can be updated by the agent."
	ReasonRequiredError         = "A reason is required."
	PauseInactiveGoalError      = "Only an active goal can be paused."
	GoalClearedMessage          = "Goal cleared."
	GoalUsage                   = "Usage: /goal [replace] [--budget <positive integer>] <objective>"
)
