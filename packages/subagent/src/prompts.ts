import type { AgentDefinition } from "./definition.js";
import type { AgentTask } from "./task-manager.js";
import { escapeXml } from "@yukino.js/utils/xml.js";

export const AGENT_TOOL_DESCRIPTION =
  "Launch an agent to handle complex, multi-step tasks.";

export const GENERAL_PURPOSE_AGENT_DESCRIPTION =
  "General-purpose agent for researching complex questions, exploring codebase, and executing multi-step tasks.";

export const PLAN_AGENT_DESCRIPTION =
  "Investigate the existing architecture and propose a concrete implementation plan with relevant files, constraints, and verification steps. Read-only: do not create, edit, or delete files. Return unresolved questions to the parent agent.";

export const EXPLORE_AGENT_DESCRIPTION =
  "Find code, trace relevant call paths, and report evidence with file paths and line numbers. Use Glob, Grep, ReadFile, and read-only shell commands. Do not modify files; return missing context or blockers to the parent agent.";

export const REVIEW_AGENT_DESCRIPTION =
  "Review pull requests for correctness, project conventions, performance, test coverage, and security. Read the diff and relevant code, then return concise findings with file paths, line numbers, impact, and suggested improvements. Do not modify files or publish reviews; return missing context or blockers to the parent.";

export const DESCRIPTION_PARAMETER_DESCRIPTION =
  "Short description of what the agent will do";

export const PROMPT_PARAMETER_DESCRIPTION = "The task for the agent to perform";

export const PLAN_AGENT_PROMPT =
  "Use the inherited conversation to investigate the user's current task and return a concrete implementation plan with relevant files, constraints, verification steps, and unresolved questions. Do not modify files. Return the complete plan directly; the parent host will save it and request user approval.";

export const INHERITED_TOOL_RESULT =
  "This tool call is running in the parent agent. Continue with the assigned task using the inherited context.";

export const SUBAGENT_TYPE_DESCRIPTION =
  'Agent role. Defaults to general-purpose, independently of fork. With kind="teammate", plan starts a planning phase and continues implementation after approval; with kind="subagent", plan remains read-only.';
export const FORK_PARAMETER_DESCRIPTION =
  "Copy the parent conversation when true; start a fresh conversation when false. This does not restore a previous subagent's private conversation. Independent of subagent_type. Defaults to the session's enable_fork setting (true when unset).";

export function buildAgentToolDescription(
  definitions: AgentDefinition[],
  defaultFork: boolean,
): string {
  const roles = definitions.map(
    (definition) =>
      `- ${definition.name}: ${definition.description}${definition.name === "plan" ? ' With kind="teammate", this role plans first and continues implementation after approval instead of remaining permanently read-only.' : ""}`,
  );
  return `Delegate a bounded task to an agent. kind selects persistent teammates (default teammate) or one-shot subagents (subagent). Team and teammate names are generated automatically. subagent_type selects the role (default general-purpose); fork independently selects whether to inherit a snapshot of the parent conversation (default ${String(defaultFork)}). Any role can use either context mode. With fork=false, include the goal, relevant files, constraints, whether edits are allowed, and the expected result.

Available roles (pass a role as subagent_type, not as a tool name):
${roles.join("\n")}

With kind="subagent", foreground calls return results inline; run_in_background=true returns a task ID immediately and delivers the final result through a task notification. A background subagent is a cancellable asynchronous tool call, like background Bash or PowerShell: use TaskStop with task_id to stop it early. Completed, failed, or cancelled tasks leave the active UI; TaskOutput can still inspect their archived results. One-shot subagents cannot receive messages or resume after termination.

For communication, follow-up assignments, or iterative collaboration, use an agent team with kind="teammate". The agent joins the current team, creating one if needed; use the returned teammate name with SendMessage. With kind="teammate" and subagent_type="plan", the teammate starts in plan mode, submits a plan, and continues implementation after approval. Forking seeds the new agent from the parent conversation; it does not restore a previous subagent's private conversation. Do not predict results before receiving them.
Role tool restrictions and max_turns apply equally with fork=true and fork=false. Roles have no default model-turn limit; max_turns supplies an explicit limit. Reaching a limit is unfinished work, not successful task completion.

Launch independent tasks together; avoid concurrent writes to the same files. Review returned evidence and integrate it before reporting completion. Worktree isolation separates edits but does not merge them.`;
}

export const AGENT_KIND_DESCRIPTION =
  "Execution kind. Defaults to teammate: a persistent agent in the current team, created automatically if needed. Use an agent team with teammate when communication or follow-up assignments are needed. Use subagent for a one-shot tool result without messaging or resumption.";
export const AGENT_MODEL_DESCRIPTION =
  "Override the model for this agent. Most tasks do not need this field; omit it to use the configured model.";
export const AGENT_WORKTREE_DESCRIPTION =
  "Run the agent in its own Git worktree so its edits cannot collide with the parent or other agents working in parallel.";

export const PLAN_TEAMMATE_DESCRIPTION =
  "Investigate the task, submit a concrete implementation plan, then implement it after approval under current tool permissions.";

export const AGENT_BACKGROUND_DESCRIPTION =
  'Only for kind="subagent". Run as an asynchronous tool call: return task_id immediately and deliver the final result through a task notification. Use TaskStop with task_id to stop it early. For communication or follow-ups, use an agent team with kind="teammate" instead.';

export function formatAgentTaskNotification(task: AgentTask): string {
  return [
    `<task-notification task_id="${escapeXml(task.id)}" status="${escapeXml(task.status)}">`,
    `name=${escapeXml(task.name)}`,
    ...(task.transcriptPath
      ? [`transcript_path=${escapeXml(task.transcriptPath)}`]
      : []),
    escapeXml(task.output),
    "</task-notification>",
  ].join("\n");
}
