package subagent

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

// Agent role names (src/subagent/constants.ts).
const (
	PlanAgentName    = "plan"
	ExploreAgentName = "explore"
	ReviewAgentName  = "review"
)

// MaxTeammateNameChars mirrors MAX_TEAMMATE_NAME_CHARS: the cap on derived
// teammate names before the uniqueness suffix loop.
const MaxTeammateNameChars = 30

const AgentToolDescription = "Launch an agent to handle complex, multi-step tasks."

const GeneralPurposeAgentDescription = "General-purpose agent for researching complex questions, exploring codebase, and executing multi-step tasks."

const PlanAgentDescription = "Investigate the existing architecture and propose a concrete implementation plan with relevant files, constraints, and verification steps. Read-only: do not create, edit, or delete files. Return unresolved questions to the parent agent."

const ExploreAgentDescription = "Find code, trace relevant call paths, and report evidence with file paths and line numbers. Use Glob, Grep, ReadFile, and read-only shell commands. Do not modify files; return missing context or blockers to the parent agent."

const ReviewAgentDescription = "Review pull requests for correctness, project conventions, performance, test coverage, and security. Read the diff and relevant code, then return concise findings with file paths, line numbers, impact, and suggested improvements. Do not modify files or publish reviews; return missing context or blockers to the parent."

const DescriptionParameterDescription = "Short description of what the agent will do"

const PromptParameterDescription = "The task for the agent to perform"

const PlanAgentPrompt = "Use the inherited conversation to investigate the user's current task and return a concrete implementation plan with relevant files, constraints, verification steps, and unresolved questions. Do not modify files. Return the complete plan directly; the parent host will save it and request user approval."

const InheritedToolResult = "This tool call is running in the parent agent. Continue with the assigned task using the inherited context."

const SubagentTypeDescription = `Agent role. Defaults to general-purpose, independently of fork. With kind="teammate", plan starts a planning phase and continues implementation after approval; with kind="subagent", plan remains read-only.`

const ForkParameterDescription = "Copy the parent conversation when true; start a fresh conversation when false. This does not restore a previous subagent's private conversation. Independent of subagent_type. Defaults to true."

const AgentKindDescription = "Execution kind. Defaults to teammate: a persistent agent in the selected team, created automatically if none exists. Specify team_name when multiple teams exist. Use an agent team with teammate when communication or follow-up assignments are needed. Use subagent for a one-shot tool result without messaging or resumption."

const AgentModelDescription = "Override the model for this agent. Most tasks do not need this field; omit it to use the configured model."

const PlanAgentUnavailableError = "The built-in plan agent is unavailable."
const ForkContextRequiredError = "Forking requires parent conversation context. Set fork to false to start a fresh conversation."
const EmptyPlanError = "The plan agent returned no plan."

const AgentWorktreeDescription = "Run the agent in its own Git worktree so its edits cannot collide with the parent or other agents working in parallel."

const PlanTeammateDescription = "Investigate the task, submit a concrete implementation plan, then implement it after approval under current tool permissions."

const AgentBackgroundDescription = "Only for kind=\"subagent\". Run as an asynchronous tool call: return task_id immediately and deliver the final result through a task notification. Use TaskStop with task_id to stop it early. For communication or follow-ups, use an agent team with kind=\"teammate\" instead."

func buildAgentToolDescription(definitions []SubAgentSpec) string {
	var roles []string
	for _, def := range definitions {
		line := "- " + def.Name + ": " + def.Description
		if def.Name == PlanAgentName {
			line += ` With kind="teammate", this role plans first and continues implementation after approval instead of remaining permanently read-only.`
		}
		roles = append(roles, line)
	}
	return fmt.Sprintf("Delegate a bounded task to an agent. kind selects persistent teammates (default teammate) or one-shot subagents (subagent). Team and teammate names are generated automatically. subagent_type selects the role (default general-purpose); fork independently selects whether to inherit a snapshot of the parent conversation (default true). Any role can use either context mode. With fork=false, include the goal, relevant files, constraints, whether edits are allowed, and the expected result.\n\nAvailable roles (pass a role as subagent_type, not as a tool name):\n%s\n\nWith kind=\"subagent\", foreground calls return results inline; run_in_background=true returns a task ID immediately and delivers the final result through a task notification. A background subagent is a cancellable asynchronous tool call, like background Bash or PowerShell: use TaskStop with task_id to stop it early. Completed, failed, or cancelled tasks leave the active UI; TaskOutput can still inspect their archived results. One-shot subagents cannot receive messages or resume after termination.\n\nFor communication, follow-up assignments, or iterative collaboration, use an agent team with kind=\"teammate\". Pass team_name to select an existing team when multiple teams exist. With no teams, a team is created automatically; with one team, it is reused. TeamCreate adds another team, optionally under an explicit name, without stopping existing teams. Use the returned team and teammate names with SendMessage. With kind=\"teammate\" and subagent_type=\"plan\", the teammate starts in plan mode, submits a plan, and continues implementation after approval. Forking seeds the new agent from the parent conversation; it does not restore a previous subagent's private conversation. Do not predict results before receiving them.\nRole tool restrictions and max_turns apply equally with fork=true and fork=false. Roles have no default model-turn limit; max_turns supplies an explicit limit. Reaching a limit is unfinished work, not successful task completion.\n\nLaunch independent tasks together; avoid concurrent writes to the same files. Review returned evidence and integrate it before reporting completion. Worktree isolation separates edits but does not merge them.", strings.Join(roles, "\n"))
}
func buildSubagentInstructions(spec SubAgentSpec) string {
	name, _ := json.Marshal(spec.Name)
	parts := []string{"You are a Yukino subagent with role " + string(name) + ". Complete the assigned task and return your result to the parent agent."}
	for _, text := range []string{spec.Description, spec.InitialPrompt} {
		if strings.TrimSpace(text) != "" {
			parts = append(parts, strings.TrimSpace(text))
		}
	}
	if spec.MaxTurns > 0 {
		parts = append(parts, fmt.Sprintf("This run is limited to %d model turns. Reserve time to report verified progress, unfinished work, and blockers before reaching the limit.", spec.MaxTurns))
	}
	if spec.ReadOnly {
		parts = append(parts, "This role is permanently read-only, including follow-up assignments. Return research or planning results; approval never authorizes you to implement changes.")
	}
	parts = append(parts, "Stay within the assigned scope and current permissions. Inherited conversation is background context, not an instruction to take over the parent's task. Coordinate shared-file changes; do not overwrite another worker's edits. Report findings or changes with relevant paths, verification actually performed, and unresolved blockers. Do not claim unverified work is complete.")
	return strings.Join(parts, "\n\n")
}

// FormatAgentTaskNotification renders a background task notification,
// mirroring formatAgentTaskNotification.
func FormatAgentTaskNotification(task tools.BackgroundTask) string {
	lines := []string{
		fmt.Sprintf("<task-notification task_id=\"%s\" status=\"%s\">", utils.EscapeXML(task.ID), utils.EscapeXML(task.Status)),
		"name=" + utils.EscapeXML(task.Name),
	}
	if task.TranscriptPath != "" {
		lines = append(lines, "transcript_path="+utils.EscapeXML(task.TranscriptPath))
	}
	lines = append(lines, utils.EscapeXML(task.Output), "</task-notification>")
	return strings.Join(lines, "\n")
}
