package agent

import "github.com/yukino-js/yukino/yukino/internal/goal"

const NoPersistentGoalReminder = goal.PersistentGoalMarker +
	"\nNo persistent goal is set. Follow the current user request.\n</persistent-goal>"

const GoalBudgetLimitedNotice = "Goal token budget reached; no further tools will be executed. Report existing progress."

const NoCallableToolsReminder = "No tools are currently callable. Return findings or blockers without issuing tool calls."
const NoDeferredToolsReminder = "No deferred tools can currently be discovered and invoked. Do not use earlier deferred-tool lists."
const NewSkillsReminderPrefix = "The following skills became available:\n"
const MaxTokensResumePrompt = "Output token limit hit. Resume directly from where you stopped. Do not apologize or repeat previous content. Pick up mid-thought if needed."
const MaxTokensRecoveryPrompt = "Output token limit hit. Resume directly from where you stopped. Break remaining work into smaller pieces."
const MaxTokensTruncatedArgsNotice = "The response hit the output token limit, so tool arguments may be truncated. Re-issue the call with complete arguments"

func BuildPermissionDeniedOutput(reason string) string {
	return "Permission denied: " + reason + ". This operation has been blocked by the security policy. Inform the user that the command was denied; do not describe what the command would do."
}

func BuildWorkingDirectoryReminder(cwd, branch, instructions string) string {
	text := WorkingDirectoryMarker + "\nThe agent's current working directory is " + cwd + "."
	if branch != "" {
		text += " Worktree branch: " + branch + "."
	}
	text += " Resolve relative file paths and shell commands here. This supersedes earlier working-directory information."
	if instructions != "" {
		text += "\nInstructions for the current directory:\n" + instructions
	}
	return text + "\n</working-directory>"
}
