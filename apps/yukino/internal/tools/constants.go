package tools

const (
	DefaultReadLimit          = 2000
	MaxReadBytes              = 50 * 1024
	MaxReadFileBytes          = 10 * 1024 * 1024
	MaxSearchOutputBytes      = 50 * 1024
	MaxSearchResults          = 500
	MaxMatchLineBytes         = 2000
	MaxGrepFileBytes          = 25 * 1024 * 1024
	MaxTraversedEntries       = 10000
	MaxTraversalDepth         = 25
	OperationInterruptedError = "Error: operation interrupted"
	OutputRequiredError       = "Error: output is required"
	QuestionCountError        = "Error: must have 1-4 questions"
	CommandInterruptedError   = "Error: command interrupted"
	// ExecutionCancelledError mirrors EXECUTION_CANCELLED_ERROR: reported by
	// the executor when a submitted call is aborted before it starts.
	ExecutionCancelledError = "Tool execution was cancelled before it started."
	FileNotReadError        = "Error: file has not been read yet, read it first before editing."
	FileDeletedError        = "Error: file was deleted or is no longer accessible; read it again before editing."
	FileModifiedError       = "Error: file has been modified since last read, read it again before editing."
)

const PlanModeUnavailableError = "Plan mode is unavailable because no permission context exists."

const PlanModeDelegatedError = "EnterPlanMode cannot be used from delegated agents."

const NotInPlanModeContinueError = "You are not in plan mode. Continue within the user's requested scope and current permissions, or call EnterPlanMode first when the task genuinely needs planning. AskUserQuestion is for clarification, not approval."

const NotInPlanModeError = "You are not in plan mode. This tool is only for exiting plan mode after writing a plan."

const NoPlanFileError = "No non-empty plan file found. Write your plan to the declared plan file before calling ExitPlanMode."

const NoPlanApprovalHandlerError = "No leader plan approval handler is available for this teammate."

const GoalMainSessionOnly = "Goals belong to the main session and are unavailable to delegated agents."

const GoalUpdateRequiresStatusReason = "Updating a goal requires status and reason."

const GoalInvalidStatusError = "Goal update accepts only 'in_progress', 'complete', or 'blocked'. A goal is active as soon as the user sets it. Only the user can pause or resume a goal."

const GoalInvalidArgsError = "Goal expects action 'get' or 'update'. Updating requires status 'in_progress', 'complete', or 'blocked' and a non-empty reason; no other fields are accepted."

const SlugInvalidError = "Error: slug must contain only alphanumeric, hyphen, underscore"
const WorktreeRuntimeRequiredError = "Error: a runtime permission checker is required for worktree sessions"
