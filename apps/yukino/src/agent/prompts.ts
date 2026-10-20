export const NO_CALLABLE_TOOLS_REMINDER =
  "No tools are currently callable. Return findings or blockers without issuing tool calls.";

export const NO_PERSISTENT_GOAL_REMINDER =
  "<persistent-goal>\nNo persistent goal is set. Follow the current user request.\n</persistent-goal>";

export const NO_DEFERRED_TOOLS_REMINDER =
  "No deferred tools can currently be discovered and invoked. Do not use earlier deferred-tool lists.";

export const NEW_SKILLS_REMINDER_PREFIX =
  "The following skills became available:\n";

export const MAX_TOKENS_RESUME_PROMPT =
  "Output token limit hit. Resume directly from where you stopped. Do not apologize or repeat previous content. Pick up mid-thought if needed.";

export const MAX_TOKENS_RECOVERY_PROMPT =
  "Output token limit hit. Resume directly from where you stopped. Break remaining work into smaller pieces.";

export const MAX_TOKENS_TRUNCATED_ARGS_NOTICE =
  "The response hit the output token limit, so tool arguments may be truncated. Re-issue the call with complete arguments";

export const GOAL_BUDGET_LIMITED_NOTICE =
  "Goal token budget reached; no further tools will be executed. Report existing progress.";
export function buildWorkingDirectoryReminder(
  cwd: string,
  branch?: string,
  instructions = "",
): string {
  return `<working-directory>\nThe agent's current working directory is ${cwd}.${branch ? ` Worktree branch: ${branch}.` : ""} Resolve relative file paths and shell commands here. This supersedes earlier working-directory information.${instructions ? `\nInstructions for the current directory:\n${instructions}` : ""}\n</working-directory>`;
}
