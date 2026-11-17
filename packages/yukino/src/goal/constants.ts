export const MAX_GOAL_TURNS = 150;
export const MAX_BLOCKED_ATTEMPTS = 3;
export const MAX_OBJECTIVE_CHARS = 4000;
export const GOAL_RECORD = "goal_state";
export const BUDGET_ARG_PATTERN = /^--budget\s+(\d+)\s+([\s\S]+)$/u;

export const NO_GOAL_MESSAGE =
  "No goal is set. Only the user can set one with /goal <objective>.";

export const GOAL_ALREADY_EXISTS_ERROR =
  "An unfinished goal already exists. Use /goal replace <objective> to replace it explicitly.";
export const NO_GOAL_SET_ERROR = "No goal is set.";
export const RESUME_INVALID_STATE_ERROR =
  "Only a paused, blocked, or turn-limited goal can resume.";
export const RESUME_TURN_LIMITED_ERROR =
  "Use /goal continue to reset the continuation limit.";
export const CONTINUE_NOT_TURN_LIMITED_ERROR =
  "/goal continue only resets a turn-limited goal. Use /goal resume.";
export const BUDGET_EXHAUSTED_ERROR =
  "The token budget is exhausted; replace the goal with an explicit new budget.";
export const UPDATE_INACTIVE_GOAL_ERROR =
  "Only an active goal can be updated by the agent.";
export const REASON_REQUIRED_ERROR = "A reason is required.";
export const PAUSE_INACTIVE_GOAL_ERROR = "Only an active goal can be paused.";
export const GOAL_CLEARED_MESSAGE = "Goal cleared.";
export const GOAL_USAGE =
  "Usage: /goal [replace] [--budget <positive integer>] <objective>";
