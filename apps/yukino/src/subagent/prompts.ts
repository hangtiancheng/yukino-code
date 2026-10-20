import type { AgentDefinition } from "@/subagent/definition.js";

export const AGENT_TOOL_DESCRIPTION =
  "Launch an agent to handle complex, multi-step tasks.";

export const PLAN_AGENT_PROMPT =
  "Use the inherited conversation to investigate the user's current task and return a concrete implementation plan with relevant files, constraints, verification steps, and unresolved questions. Do not modify files. Return the complete plan directly; the parent host will save it and request user approval.";

export const INHERITED_TOOL_RESULT =
  "This tool call is running in the parent agent. Continue with the assigned task using the inherited context.";

export const SUBAGENT_TYPE_DESCRIPTION =
  'Agent role. Defaults to general-purpose, independently of fork. With kind="teammate", plan starts a planning phase and continues implementation after approval; with kind="subagent", plan remains read-only.';
export const FORK_PARAMETER_DESCRIPTION =
  "Copy the parent conversation when true; start a fresh conversation when false. Independent of subagent_type. Defaults to the session's enable_fork setting (true when unset).";

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

With kind="subagent", foreground calls return results inline; run_in_background=true returns a task ID immediately and delivers the final result through a task notification. With kind="teammate", the agent joins the current team, creating one if needed; use the returned teammate name with SendMessage for follow-up assignments. With kind="teammate" and subagent_type="plan", the teammate starts in plan mode, submits a plan, and continues implementation after approval. The fork setting seeds a teammate's initial conversation only. Do not predict results before receiving them.
Role tool restrictions and max_turns apply equally with fork=true and fork=false. Roles have no default model-turn limit; max_turns supplies an explicit limit. Reaching a limit is unfinished work, not successful task completion.

Launch independent tasks together; avoid concurrent writes to the same files. Review returned evidence and integrate it before reporting completion. Worktree isolation separates edits but does not merge them.`;
}

export const AGENT_KIND_DESCRIPTION =
  "Execution kind. Defaults to teammate: a persistent agent in the current team, created automatically if needed. Use subagent for a one-shot result.";
export const AGENT_MODEL_DESCRIPTION =
  "Override the model for this agent. Most tasks do not need this field; omit it to use the configured model.";
export const AGENT_WORKTREE_DESCRIPTION =
  "Run the agent in its own Git worktree so its edits cannot collide with the parent or other agents working in parallel.";

export const PLAN_TEAMMATE_DESCRIPTION =
  "Investigate the task, submit a concrete implementation plan, then implement it after approval under current tool permissions.";

export const AGENT_BACKGROUND_DESCRIPTION =
  'Only for kind="subagent". Run asynchronously, returning a task ID immediately and delivering the final result through a task notification.';
